import type { EventMessage, MovePattern, Row } from "@electric-sql/client";
import { isChangeMessage, isControlMessage } from "@electric-sql/client";
import type { ChangeMessage, ShapeStreamOptions } from "@electric-sql/client";
import { MultiShapeStream } from "@electric-sql/experimental";
import type { Extension, PGliteInterface } from "@electric-sql/pglite";

import { type ApplyStrategy, quoteIdentifier } from "@pgxsinkit/contracts";

import { syncDebug } from "../debug";
import { computeRetryDelayMs } from "../mutation";
import {
  applyBulkDeletesToTable,
  applyBulkUpdatesToTable,
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
  doMapColumns,
} from "./apply";
import { foldChangeBatch, ShapeInbox } from "./shape-inbox";
import {
  deleteSubscriptionState,
  getSubscriptionState,
  migrateSubscriptionMetadataTables,
  type SubscriptionState,
  updateSubscriptionState,
} from "./subscription-state";
import { applyShapeMoveOut, applyShapeTagSync, clearShapeTags, DEFAULT_METADATA_SCHEMA, shapeTableId } from "./tags";
import {
  DEFAULT_MAX_COMMIT_RETRIES,
  type ElectricSyncOptions,
  type InitialInsertMethod,
  type InsertChangeMessage,
  type Lsn,
  type SyncShapesToTablesOptions,
  type SyncShapesToTablesResult,
  type SyncShapeToTableOptions,
  type SyncShapeToTableResult,
} from "./types";

export * from "./types";

/**
 * Replication-stream headers Electric attaches to change messages but does not
 * declare on its `Header` type: `lsn` orders changes within the stream and
 * `last` marks the final change of an LSN. Single choke point for these
 * protocol assumptions.
 */
/**
 * Maps the statically-resolved {@link ApplyStrategy} (ADR-0009 decision 3) onto the engine's
 * initial-backfill apply path. Undefined (no registry-supplied strategy) defaults to `copy`:
 * the COPY TEXT serializer round-trips every built-in type, so it is the safe no-brainer bootstrap.
 */
function applyStrategyToInsertMethod(strategy: ApplyStrategy | undefined): InitialInsertMethod {
  switch (strategy) {
    case "json":
      return "json";
    case "insert":
      return "insert";
    default:
      return "copy";
  }
}

function readReplicationHeaders(headers: ChangeMessage["headers"]): { lsn: bigint; isLastOfLsn: boolean } {
  const rawLsn: unknown = headers["lsn"];

  return {
    lsn: typeof rawLsn === "string" ? BigInt(rawLsn) : BigInt(0),
    isLastOfLsn: headers["last"] === true,
  };
}

/**
 * Electric's tagged-subquery `EventMessage` (ADR-0023) — `headers.event` is `move-out` | `move-in`,
 * carrying `patterns`. It is neither a change nor a control message, so `@electric-sql/client` exposes
 * no guard; we detect it by the `event` header. `MultiShapeStream` adds `.shape` like every message.
 */
type ShapeEventMessage = EventMessage & { shape: string };

function isEventMessage(message: unknown): message is ShapeEventMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { headers?: { event?: unknown } }).headers?.event === "string"
  );
}

async function createPlugin(pg: PGliteInterface, options?: ElectricSyncOptions) {
  const debug = options?.debug ?? false;
  // pgxsinkit-owned metadata namespace (ADR-0009 decision 6): this is our local bookkeeping (the
  // subscription-state table) and the sync-origin GUC (`<schema>.syncing`), not Electric's — so it
  // lives under our own schema, renamed from the upstream `electric` default.
  const metadataSchema = options?.metadataSchema ?? DEFAULT_METADATA_SCHEMA;
  const streams: Array<{
    stream: MultiShapeStream<Record<string, Row<unknown>>>;
    aborter: AbortController;
  }> = [];

  const getShapeOptions = (shapes: SyncShapesToTablesOptions["shapes"], shapeName: string) => {
    const shape = shapes[shapeName];
    if (!shape) {
      throw new Error(`Missing shape options for ${shapeName}`);
    }
    return shape;
  };

  const shapePerTableLock = new Map<string, void>();

  let initMetadataTablesDone = false;
  const initMetadataTables = async () => {
    if (initMetadataTablesDone) return;
    initMetadataTablesDone = true;
    await migrateSubscriptionMetadataTables({
      pg,
      metadataSchema,
    });
  };

  const syncShapesToTables = async ({
    key,
    shapes,
    initialInsertMethod = "copy",
    onInitialSync,
    onError,
    onSyncError,
    onSyncActivity,
    maxCommitRetries = DEFAULT_MAX_COMMIT_RETRIES,
    commitRetryDelayMs = computeRetryDelayMs,
  }: SyncShapesToTablesOptions): Promise<SyncShapesToTablesResult> => {
    let unsubscribed = false;
    await initMetadataTables();

    Object.values(shapes)
      .filter((shape) => !shape.onMustRefetch)
      .forEach((shape) => {
        if (shapePerTableLock.has(shape.table)) {
          throw new Error("Already syncing shape for table " + shape.table);
        }
        shapePerTableLock.set(shape.table);
      });

    let subState: SubscriptionState | null = null;

    if (key !== null) {
      subState = await getSubscriptionState({
        pg,
        metadataSchema,
        subscriptionKey: key,
      });
      if (debug && subState) {
        console.log("resuming from subscription state", subState);
      }
    }

    const isNewSubscription = subState === null;

    // Each shape resolves its own apply method (ADR-0009 decisions 2 + 3): an explicit per-shape
    // `initialInsertMethod` wins, else the per-shape `applyStrategy`, else the group-level default.
    // So a consistency group with mixed column profiles applies each table on its correct path.
    const shapeInsertMethod = new Map<string, InitialInsertMethod>(
      Object.entries(shapes).map(([shapeName, shapeOptions]) => [
        shapeName,
        shapeOptions.initialInsertMethod ??
          (shapeOptions.applyStrategy ? applyStrategyToInsertMethod(shapeOptions.applyStrategy) : initialInsertMethod),
      ]),
    );

    // `useInsert` is per-shape, not shared: in a multi-shape group, one shape finishing its bulk
    // backfill must not flip every other shape onto plain `INSERT`. A shape uses its bulk path only
    // on a fresh subscription with a non-`insert` method; a resume starts already in insert mode.
    const useInsert = new Map<string, boolean>(
      Object.keys(shapes).map((shapeName) => [
        shapeName,
        !isNewSubscription || shapeInsertMethod.get(shapeName) === "insert",
      ]),
    );
    let onInitialSyncCalled = false;

    const maybeSignalInitialSync = () => {
      if (onInitialSync && !onInitialSyncCalled && multiShapeStream.isUpToDate) {
        onInitialSync();
        onInitialSyncCalled = true;
      }
    };

    // The Shape inbox (ADR-0014 / ISS-06): the pure, in-memory buffer + complete-LSN frontier for
    // this group's shapes. The engine keeps the commit queue, the apply, and the truncate set.
    const inbox = new ShapeInbox(Object.keys(shapes));

    const truncateNeeded = new Set<string>();
    // The committed frontier is a *running* variable, advanced after each successful commit — not
    // the boot-time `const` the upstream engine never advanced (which forced redundant empty
    // re-commits). `degraded` latches once commits exhaust their retries (ADR-0009 decision 5).
    let committedLsn: Lsn = subState?.last_lsn ?? BigInt(-1);
    let degraded = false;
    // Single-flight commit queue: at most one commit runs at a time; messages buffered while one
    // is in flight coalesce into the next run (re-armed via `commitRerun`).
    let commitInFlight: Promise<void> | null = null;
    let commitRerun = false;

    const aborter = new AbortController();
    Object.values(shapes)
      .filter((shapeOptions) => !!shapeOptions.shape.signal)
      .forEach((shapeOptions) => {
        shapeOptions.shape.signal!.addEventListener("abort", () => aborter.abort(), {
          once: true,
        });
      });

    const multiShapeOptions: Record<string, ShapeStreamOptions<Row<unknown>>> = {};
    for (const [shapeName, shapeOptions] of Object.entries(shapes)) {
      const shapeMetadata = subState?.shape_metadata[shapeName];
      const streamOptions: ShapeStreamOptions<Row<unknown>> = {
        ...shapeOptions.shape,
        signal: aborter.signal,
      };

      if (shapeMetadata) {
        streamOptions.offset = shapeMetadata.offset;
        streamOptions.handle = shapeMetadata.handle;
      }

      multiShapeOptions[shapeName] = streamOptions;
    }

    const multiShapeStream = new MultiShapeStream<Record<string, Row<unknown>>>({
      shapes: multiShapeOptions,
    });

    const getShapeStream = (shapeName: string) => {
      const stream = multiShapeStream.shapes[shapeName];
      if (!stream) {
        throw new Error(`Missing stream for ${shapeName}`);
      }
      return stream;
    };

    const insertMethods = {
      json: applyMessagesToTableWithJson,
      copy: applyMessagesToTableWithCopy,
      insert: applyInsertsToTable,
    } as const;

    // Apply everything buffered up to `targetLsn` in a single transaction, retrying with jittered
    // backoff on failure. Returns `true` once applied (and advances the running committed frontier);
    // returns `false` without advancing if the engine unsubscribed mid-flight or the commit
    // exhausted its retries (→ `degraded` + `onSyncError`, ADR-0009 decision 5). The drained
    // messages and the truncate snapshot are held across retries so a transient failure loses
    // nothing; the read cache never advances past an unapplied commit.
    const commitUpToLsn = async (targetLsn: Lsn): Promise<boolean> => {
      const messagesToCommit = inbox.drainUpTo(targetLsn);

      // Snapshot the truncate set so a retried transaction still truncates; the per-shape flag is
      // cleared only once the commit has succeeded.
      const shapesToTruncate = new Set(truncateNeeded);

      // Snapshot the buffered tagged-subquery move-outs (ADR-0023) the same way: drained here so a
      // retried commit still evicts, and (like the change drain) a degraded commit re-streams them on
      // resume because the persisted offset is not advanced.
      const moveOutsToCommit = new Map<string, MovePattern[][]>();
      for (const shapeName of Object.keys(shapes)) {
        const pending = inbox.drainMoveOuts(shapeName);
        if (pending.length > 0) {
          moveOutsToCommit.set(shapeName, pending);
        }
      }

      const runCommit = () =>
        pg.transaction(async (tx) => {
          if (debug) {
            console.time("commit");
          }

          await tx.exec(`SET LOCAL ${metadataSchema}.syncing = true;`);

          for (const [shapeName, initialMessages] of messagesToCommit.entries()) {
            const shape = getShapeOptions(shapes, shapeName);
            const shapeMethod = shapeInsertMethod.get(shapeName)!;
            let messages = initialMessages;

            // ADR-0023: the shape's tag store key (synced table, schema-qualified).
            const shapeTable = shapeTableId(shape.schema, shape.table);

            if (shapesToTruncate.has(shapeName)) {
              if (debug) {
                console.log("truncating table", shape.table);
              }
              if (shape.onMustRefetch) {
                await shape.onMustRefetch(tx);
              } else {
                const schema = shape.schema || "public";
                await tx.exec(`DELETE FROM ${quoteIdentifier(schema)}.${quoteIdentifier(shape.table)};`);
              }
              // The re-snapshot rebuilds tags from scratch, so drop this shape's stale tag-set too
              // (ADR-0023 Slice 2: a must-refetch/​rebuild must not leave orphan tags).
              await clearShapeTags({ pg: tx, metadataSchema, shapeTable });
            }

            // Maintain the tag-set from the RAW drained batch (ADR-0023) — before the data apply and
            // the move-out eviction, so an add-then-remove within one commit resolves correctly. Uses
            // `initialMessages` (the full batch) since the insert/​fold split below reduces `messages`.
            await applyShapeTagSync({
              pg: tx,
              metadataSchema,
              shapeTable,
              messages: initialMessages,
              mapColumns: shape.mapColumns,
              primaryKey: shape.primaryKey,
            });

            if (!useInsert.get(shapeName)) {
              const initialInserts: InsertChangeMessage[] = [];
              const remainingMessages: ChangeMessage<Row<unknown>>[] = [];
              let foundNonInsert = false;
              for (const message of messages) {
                if (!foundNonInsert && message.headers.operation === "insert") {
                  initialInserts.push(message as InsertChangeMessage);
                } else {
                  foundNonInsert = true;
                  remainingMessages.push(message);
                }
              }
              if (initialInserts.length > 0 && shapeMethod === "copy") {
                remainingMessages.unshift(initialInserts.pop()!);
              }
              messages = remainingMessages;

              if (initialInserts.length > 0) {
                await insertMethods[shapeMethod]({
                  pg: tx,
                  table: shape.table,
                  schema: shape.schema,
                  messages: initialInserts,
                  mapColumns: shape.mapColumns,
                  primaryKey: shape.primaryKey,
                  columnTypes: shape.columnTypes,
                  debug,
                });

                useInsert.set(shapeName, true);
              }
            }

            // ADR-0014 Phase 3: fold this shape's drained batch to one net op per PK, then apply
            // three bulk statements in the order DELETE → INSERT → UPDATE. A re-created PK's delete
            // must precede its insert; every other PK lands in exactly one statement, so the rest of
            // the order is irrelevant within the (atomic) commit. The fold collapses same-PK runs, so
            // no bulk statement ever holds two rows for one PK — closing the `UPDATE … FROM` /
            // `json_to_recordset` join hazard (which would use one arbitrary matching row) by
            // construction. This replaces the previous one-SQL-statement-per-row steady-state loop.
            if (messages.length > 0) {
              const mapColumns = shape.mapColumns;
              // A column-renaming map commutes with the per-PK value merge, so it can map after the
              // fold. A mapColumns *function* may not, so pre-map each message before folding and let
              // the bulk appliers apply the already-mapped values verbatim.
              const foldInput =
                typeof mapColumns === "function"
                  ? messages.map((message) => ({ ...message, value: doMapColumns(mapColumns, message) }))
                  : messages;
              const bulkMapColumns = typeof mapColumns === "function" ? undefined : mapColumns;
              const folded = foldChangeBatch(foldInput);

              if (folded.deletes.length > 0) {
                await applyBulkDeletesToTable({
                  pg: tx,
                  table: shape.table,
                  schema: shape.schema,
                  messages: folded.deletes,
                  mapColumns: bulkMapColumns,
                  primaryKey: shape.primaryKey,
                  columnTypes: shape.columnTypes,
                  debug,
                });
              }
              if (folded.inserts.length > 0) {
                await applyInsertsToTable({
                  pg: tx,
                  table: shape.table,
                  schema: shape.schema,
                  messages: folded.inserts,
                  mapColumns: bulkMapColumns,
                  primaryKey: shape.primaryKey,
                  columnTypes: shape.columnTypes,
                  debug,
                });
              }
              if (folded.updates.length > 0) {
                await applyBulkUpdatesToTable({
                  pg: tx,
                  table: shape.table,
                  schema: shape.schema,
                  messages: folded.updates,
                  mapColumns: bulkMapColumns,
                  primaryKey: shape.primaryKey,
                  columnTypes: shape.columnTypes,
                  debug,
                });
              }
            }

            // ADR-0023: after the data + tag state is current, apply this shape's buffered move-outs —
            // withdraw the revoked tag and evict any row left with no tag (via the bulk-delete path, so
            // the reconcile trigger fires and the read model converges).
            const patternSets = moveOutsToCommit.get(shapeName);
            if (patternSets) {
              await applyShapeMoveOut({
                pg: tx,
                metadataSchema,
                shapeTable,
                table: shape.table,
                schema: shape.schema,
                primaryKey: shape.primaryKey,
                columnTypes: shape.columnTypes,
                patternSets,
                debug,
              });
            }
          }

          if (key) {
            await updateSubscriptionState({
              pg: tx,
              metadataSchema,
              subscriptionKey: key,
              shapeMetadata: Object.fromEntries(
                Object.keys(shapes).map((shapeName) => {
                  const stream = getShapeStream(shapeName);
                  return [
                    shapeName,
                    {
                      handle: stream.shapeHandle!,
                      offset: stream.lastOffset,
                    },
                  ];
                }),
              ),
              lastLsn: targetLsn,
              debug,
            });
          }

          // If we unsubscribed while this commit was in flight, discard it rather than persist
          // work during teardown. PGlite's `transaction()` skips its COMMIT once `tx.rollback()`
          // has closed the tx, so this rolls back both the applied rows and the subscription-state
          // advance; the (un-advanced) persisted offset means a later resume re-streams this batch.
          if (unsubscribed) {
            await tx.rollback();
          }
        });

      for (let attempt = 1; ; attempt++) {
        if (unsubscribed) {
          return false;
        }
        try {
          await runCommit();
          if (unsubscribed) {
            // The commit rolled itself back on unsubscribe (see runCommit); do not advance the
            // committed frontier or clear truncate flags for work that was discarded.
            return false;
          }
          committedLsn = targetLsn;
          for (const shapeName of shapesToTruncate) {
            truncateNeeded.delete(shapeName);
          }
          if (debug) console.timeEnd("commit");
          maybeSignalInitialSync();
          return true;
        } catch (error) {
          if (unsubscribed) {
            return false;
          }
          if (attempt >= maxCommitRetries) {
            degraded = true;
            onSyncError?.(error instanceof Error ? error : new Error(String(error)));
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, commitRetryDelayMs(attempt)));
        }
      }
    };

    const lowestCompleteLsn = (): Lsn => inbox.lowestCompleteLsn();

    // Drain buffered changes up to the current complete frontier, one commit at a time, looping
    // while fresh messages keep arriving (so commits coalesce). Returns early on `degraded` — a held
    // commit is not retried here; recovery is a later message/refetch or a restart.
    const runCommitLoop = async (): Promise<void> => {
      do {
        commitRerun = false;
        const target = lowestCompleteLsn();
        const isCommitNeeded = target > committedLsn;
        const isMustRefetchAndCatchingUp = target >= committedLsn && truncateNeeded.size > 0;
        // A buffered move-out (ADR-0023) must be committed even if no change advanced the frontier — the
        // revocation has to land. Its `up-to-date` normally advances `target`, but don't rely on that.
        const hasPendingMoveOuts = target >= committedLsn && inbox.hasPendingMoveOuts();
        if (isCommitNeeded || isMustRefetchAndCatchingUp || hasPendingMoveOuts) {
          const applied = await commitUpToLsn(target);
          if (!applied) {
            return;
          }
        } else {
          maybeSignalInitialSync();
        }
      } while (commitRerun);
    };

    // Single-flight: at most one commit loop runs. A message arriving while one is running buffers
    // synchronously (above) and re-arms the loop via `commitRerun`; `commitInFlight` is cleared
    // inside the same async body — before its promise resolves — so an enqueue can never observe a
    // stale in-flight handle and resolve without committing its messages.
    const enqueueCommit = (): Promise<void> => {
      if (commitInFlight) {
        commitRerun = true;
        return commitInFlight;
      }
      commitInFlight = (async () => {
        try {
          await runCommitLoop();
        } finally {
          commitInFlight = null;
        }
      })();
      return commitInFlight;
    };

    multiShapeStream.subscribe(async (messages) => {
      if (unsubscribed) {
        return;
      }
      // A delivered batch means a fetch just succeeded — the read path is alive (ADR-0013 Phase 3),
      // so the runtime can clear an auth-needed status once a fresh token starts working again.
      onSyncActivity?.();
      if (debug) {
        console.log("received messages", messages.length);
      }
      // Receive-path latency probe: a batch carrying real change rows is the moment Electric delivered
      // a write to this subscriber (the writer's own echo, or another browser's edit fanning in). The
      // gap from here to the commit finishing is the local apply cost.
      const changeCount = messages.reduce((n, message) => (isChangeMessage(message) ? n + 1 : n), 0);
      if (changeCount > 0) {
        syncDebug("sync received change batch from Electric", { changes: changeCount });
      }
      const commitStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();

      messages.forEach((message) => {
        if (isChangeMessage(message)) {
          const { lsn, isLastOfLsn } = readReplicationHeaders(message.headers);
          inbox.ingestChange(message.shape, message, lsn, isLastOfLsn);
        } else if (isControlMessage(message)) {
          switch (message.headers.control) {
            case "up-to-date": {
              if (debug) {
                console.log("received up-to-date", message);
              }
              if (typeof message.headers.global_last_seen_lsn !== "string") {
                throw new Error("global_last_seen_lsn is not a string");
              }
              inbox.ingestUpToDate(message.shape, BigInt(message.headers.global_last_seen_lsn));
              break;
            }
            case "must-refetch": {
              if (debug) {
                console.log("received must-refetch", message);
              }
              inbox.resetShape(message.shape);
              truncateNeeded.add(message.shape);
              break;
            }
          }
        } else if (isEventMessage(message)) {
          // ADR-0023: a tagged-subquery move-out — a grant was revoked, so the rows it kept in the shape
          // must be evicted. Buffer the patterns; the eviction runs in the next commit (decision 3). A
          // `move-in` needs no action here — its newly-matched rows arrive as ordinary tagged inserts.
          // `MultiShapeStream`'s callback type does not declare `EventMessage` (the prior guards narrow
          // `message` to `never` here), so reach the runtime-present event through an explicit cast.
          const eventMessage = message as unknown as ShapeEventMessage;
          if (eventMessage.headers.event === "move-out") {
            if (debug) {
              console.log("received move-out", eventMessage);
            }
            inbox.ingestMoveOut(eventMessage.shape, eventMessage.headers.patterns);
          }
        }
      });

      // Buffering above is synchronous; here we enqueue the single-flight commit and await it. The
      // stream awaits this callback, so awaiting the (coalesced) commit is the natural backpressure
      // that bounds the buffer — replacing the old fire-and-forget commit + `setTimeout(0)` race.
      await enqueueCommit();
      if (changeCount > 0) {
        const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - commitStartedAt;
        syncDebug("sync applied change batch to local store", { changes: changeCount, ms: Math.round(elapsed) });
      }
    }, onError);

    streams.push({
      stream: multiShapeStream,
      aborter,
    });

    const unsubscribe = () => {
      if (debug) {
        console.log("unsubscribing");
      }
      unsubscribed = true;
      multiShapeStream.unsubscribeAll();
      aborter.abort();
      for (const shape of Object.values(shapes)) {
        shapePerTableLock.delete(shape.table);
      }
    };

    return {
      unsubscribe,
      get isUpToDate() {
        // Never report up-to-date while a commit is pending or after going degraded (ADR-0009
        // decision 5): the read cache must not claim to match the server on an unapplied commit.
        return !degraded && commitInFlight === null && multiShapeStream.isUpToDate;
      },
      streams: Object.fromEntries(
        Object.keys(shapes).map((shapeName) => [shapeName, getShapeStream(shapeName)]),
      ) as SyncShapesToTablesResult["streams"],
    };
  };

  const syncShapeToTable = async (options: SyncShapeToTableOptions): Promise<SyncShapeToTableResult> => {
    const multiShapeSub = await syncShapesToTables({
      shapes: {
        shape: {
          shape: options.shape,
          table: options.table,
          schema: options.schema,
          mapColumns: options.mapColumns,
          primaryKey: options.primaryKey,
          onMustRefetch: options.onMustRefetch,
          columnTypes: options.columnTypes,
        },
      },
      key: options.shapeKey,
      // Static type-driven selection (ADR-0009 decision 3): an explicit `initialInsertMethod`
      // (the generic API) still wins; otherwise the registry-resolved `applyStrategy` picks the
      // backfill path, defaulting to `copy`.
      initialInsertMethod: options.initialInsertMethod ?? applyStrategyToInsertMethod(options.applyStrategy),
      onInitialSync: options.onInitialSync,
      onError: options.onError,
      onSyncError: options.onSyncError,
      maxCommitRetries: options.maxCommitRetries,
      commitRetryDelayMs: options.commitRetryDelayMs,
    });

    return {
      unsubscribe: multiShapeSub.unsubscribe,
      get isUpToDate() {
        return multiShapeSub.isUpToDate;
      },
      stream: (() => {
        const stream = multiShapeSub.streams["shape"];
        if (!stream) {
          throw new Error("Missing stream for shape");
        }
        return stream;
      })() as SyncShapeToTableResult["stream"],
    };
  };

  const deleteSubscription = async (key: string) => {
    await deleteSubscriptionState({
      pg,
      metadataSchema,
      subscriptionKey: key,
    });
  };

  const namespaceObj = {
    initMetadataTables,
    syncShapesToTables,
    syncShapeToTable,
    deleteSubscription,
  };

  const close = async () => {
    for (const { stream, aborter } of streams) {
      stream.unsubscribeAll();
      aborter.abort();
    }
  };

  return {
    namespaceObj,
    close,
  };
}

export type SyncNamespaceObj = Awaited<ReturnType<typeof createPlugin>>["namespaceObj"];

export type PGliteWithSync = PGliteInterface & {
  sync: SyncNamespaceObj;
};

export function electricSync(options?: ElectricSyncOptions) {
  return {
    name: "Postgres Sync",
    setup: async (pg: PGliteInterface) => {
      const { namespaceObj, close } = await createPlugin(pg, options);
      return {
        namespaceObj,
        close,
      };
    },
  } satisfies Extension;
}
