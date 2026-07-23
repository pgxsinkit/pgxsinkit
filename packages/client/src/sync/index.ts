// Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE).
// Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — evolve freely.
import type { EventMessage, MovePattern, Row } from "@electric-sql/client";
import { isChangeMessage, isControlMessage } from "@electric-sql/client";
import type { ChangeMessage, ShapeStreamOptions } from "@electric-sql/client";
import { MultiShapeStream } from "@electric-sql/experimental";
import type { PGliteInterface } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { type ApplyStrategy, classifyTableApplyStrategy } from "@pgxsinkit/contracts";

import { instrumentShapeFetch, syncDebug } from "../debug";
import { type ApplyTarget, resolveApplyTarget } from "../local-tables";
import { computeRetryDelayMs } from "../mutation";
import {
  applyBulkDeletesToTable,
  applyBulkUpdatesToTable,
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
  applyUpsertsToTable,
  applyUpsertsToTableWithJson,
} from "./apply";
import { drizzleOverPg } from "./drizzle-executor";
import {
  NUDGE_HOLD_GRACE_MS,
  NUDGE_MAX_ROUNDS,
  NUDGE_ROUND_GRACE_MS,
  NUDGE_ROUND_WAIT_MS,
  withNudgeBuster,
} from "./nudge";
import { foldChangeBatch, ShapeInbox } from "./shape-inbox";
import {
  deleteSubscriptionState,
  getSubscriptionState,
  migrateSubscriptionMetadataTables,
  type SubscriptionState,
  updateSubscriptionState,
} from "./subscription-state";
import {
  addShapeRowTags,
  applyShapeMoveOut,
  applyShapeTagSync,
  assertValidMetadataSchema,
  clearShapeTags,
  DEFAULT_METADATA_SCHEMA,
  shapeTableId,
} from "./tags";
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

/**
 * Construct the pgxsinkit sync engine over an ALREADY-created PGlite instance (ADR-0032 S1). The engine
 * is a plain module — not a create-time PGlite extension — so it demands only the minimal surface it
 * actually uses: a {@link PGliteInterface} (it runs its metadata DDL + apply commits through `pg.transaction`
 * / `pg.query` / `pg.exec`; it does NOT touch the `live` extension). It returns the `namespace` object (the
 * local-bookkeeping + shape-sync entry points the client attaches as `pg.electric`) plus an explicit
 * `close()` — the teardown the former extension's `close` hook ran when PGlite closed, now invoked
 * explicitly by the owner at the same moment (see `createSyncClient`'s `stop`/`destroy`).
 */
export async function createSyncEngine(pg: PGliteInterface, options?: ElectricSyncOptions) {
  const debug = options?.debug ?? false;
  // pgxsinkit-owned metadata namespace (ADR-0009 decision 6): this is our local bookkeeping (the
  // subscription-state table) and the sync-origin GUC (`<schema>.syncing`), not Electric's — so it
  // lives under our own schema, renamed from the upstream `electric` default.
  const metadataSchema = options?.metadataSchema ?? DEFAULT_METADATA_SCHEMA;
  // The schema name reaches raw GUC + DDL identifier positions below (no quoted-identifier form exists
  // there), so validate it at construction rather than trust caller input in those raw spots.
  assertValidMetadataSchema(metadataSchema);
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

  // Memoize the metadata DDL as a PROMISE, not a boolean: concurrent eager groups (`shape-sync.ts`
  // starts them with `Promise.all`) both call `initMetadataTables`, and a boolean set BEFORE the async
  // migration completed let the second caller return early and query the metadata tables before the DDL
  // had run. Storing the in-flight promise makes every concurrent caller await the same single migration.
  // Cleared on rejection so a transient DDL failure can be retried by a later start rather than caching a
  // rejected promise forever.
  let initMetadataTablesPromise: Promise<void> | undefined;
  const initMetadataTables = (): Promise<void> => {
    if (!initMetadataTablesPromise) {
      initMetadataTablesPromise = migrateSubscriptionMetadataTables({
        pg,
        metadataSchema,
      }).catch((error: unknown) => {
        initMetadataTablesPromise = undefined;
        throw error;
      });
    }
    return initMetadataTablesPromise;
  };

  const syncShapesToTables = async ({
    key,
    registry,
    shapes,
    sessionScoped = false,
    initialInsertMethod,
    onInitialSync,
    onError,
    onSyncError,
    onSyncActivity,
    dbReady,
    bootStamp,
    maxCommitRetries = DEFAULT_MAX_COMMIT_RETRIES,
    commitRetryDelayMs = computeRetryDelayMs,
  }: SyncShapesToTablesOptions): Promise<SyncShapesToTablesResult> => {
    let unsubscribed = false;
    // Fresh-store prefetch overlap (ADR-0032 S4): the caller proved the store fresh and handed a `dbReady`
    // gate, so start the streams and buffer their catch-up into the memory inbox NOW — before the local
    // store's schema/journal/reconcile finish — and defer every DB touch (metadata DDL, the first commit)
    // until the gate lifts. Without it, the exact sequential path: init the metadata tables up front.
    const overlap = dbReady != null;
    if (!overlap) {
      await initMetadataTables();
    }

    // Resolve each shape's apply target ONCE at subscribe time (ADR-0029 D1/D2): the real projected
    // synced table, its columns, PKs, and model-derived types — the engine's per-message work is then a
    // pure builder over these resolved objects, never a per-message re-derivation or catalog probe.
    const targets = new Map<string, ApplyTarget>(
      Object.entries(shapes).map(([shapeName, shapeOptions]) => [
        shapeName,
        resolveApplyTarget(registry, shapeOptions.tableKey),
      ]),
    );
    const getTarget = (shapeName: string): ApplyTarget => {
      const target = targets.get(shapeName);
      if (!target) {
        throw new Error(`Missing apply target for ${shapeName}`);
      }
      return target;
    };
    // The synced table's physical identity — the per-table lock key and the tag-store `shape_table` key.
    const tableIdentity = (target: ApplyTarget) => {
      const { name, schema } = getTableConfig(target.table);
      return shapeTableId(schema, name);
    };

    Object.entries(shapes)
      .filter(([, shape]) => !shape.onMustRefetch)
      .forEach(([, shape]) => {
        if (shapePerTableLock.has(shape.tableKey)) {
          throw new Error("Already syncing shape for table " + shape.tableKey);
        }
        shapePerTableLock.set(shape.tableKey);
      });

    let subState: SubscriptionState | null = null;

    // On the overlap path the store is provably fresh (the `freshStore` gate), so it carries no persisted
    // subscription state — AND its metadata tables do not exist yet (their DDL is deferred to the gate).
    // Skip the read entirely: `subState` stays null, so the group is (correctly) a new subscription.
    if (key !== null && !overlap) {
      subState = await getSubscriptionState({
        pg,
        metadataSchema,
        subscriptionKey: key,
        sessionScoped,
      });
      if (debug && subState) {
        console.log("resuming from subscription state", subState);
      }
    }

    const isNewSubscription = subState === null;

    // Each shape resolves its own apply method (ADR-0009 decisions 2 + 3 / ADR-0029 D1): an explicit
    // per-shape `initialInsertMethod` override wins, else the group-level default, else the registry's
    // build-time classification of the entry. So a consistency group with mixed column profiles applies
    // each table on its correct path.
    const shapeInsertMethod = new Map<string, InitialInsertMethod>(
      Object.entries(shapes).map(([shapeName, shapeOptions]) => {
        // Strategy precedence (ADR-0009 decisions 2+3 / ADR-0029 D1): an explicit per-shape override,
        // then the group-level default, then the registry's build-time classification of the entry.
        const entry = registry[shapeOptions.tableKey]!;
        const method =
          shapeOptions.initialInsertMethod ??
          initialInsertMethod ??
          applyStrategyToInsertMethod(classifyTableApplyStrategy(entry));
        return [shapeName, method];
      }),
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

    // Live-tail sibling nudge (ADR-0031): a per-shape one-shot cache-buster token. The watchdog (below)
    // sets a token just before nudging a lagging sibling; `withNudgeBuster` (wrapping each shape's
    // fetchClient) consumes it on the sibling's next non-live catch-up so a CDN HIT cannot return the same
    // stale watermark and defeat the nudge. Empty on the steady path → the wrapper is a straight passthrough.
    const nudgeBusters = new Map<string, string>();

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
        // Instrument every ShapeStream HTTP request (the read-path long-poll/catch-up) when debug is on;
        // a passthrough otherwise (see instrumentShapeFetch). Wraps any existing fetchClient rather than
        // replacing it, so auth/header injection on the shape's own fetchClient still runs. `withNudgeBuster`
        // is the OUTER wrapper (ADR-0031 live-tail nudge): it stamps the cache-buster onto the URL BEFORE
        // instrumentation runs, so the debug rail logs the busted URL (`BUSTED`) that actually hits the wire.
        fetchClient: withNudgeBuster(instrumentShapeFetch(shapeOptions.shape.fetchClient), nudgeBusters, shapeName),
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

    // The commit gate (ADR-0032 S4). Open immediately on the sequential path; held closed on the overlap
    // path until `dbReady` resolves, so NOTHING writes to PGlite before the local schema exists. The inbox
    // is pure memory, so buffering catch-up behind this closed gate is safe — the only DB-bound work
    // (metadata DDL, then commits) waits for the gate.
    let dbGateOpen = !overlap;
    if (overlap) {
      // The streams' network side is starting now (subscribe below triggers the first fetch), overlapping
      // the caller's local boot phases. Name the shapes so the overlap is measurable on the boot rail.
      syncDebug("boot shape prefetch start", { shapes: Object.keys(shapes) });
    }

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
      // PEEK (not drain) the buffered batch: it stays in the inbox until the transaction below actually
      // succeeds, and is only then ACKed (removed). A commit that exhausts its retries (→ `degraded`)
      // therefore HOLDS the drained batch in the buffer instead of losing it (ADR-0009 decision 5) — and
      // `enqueueCommit` refuses to run any newer commit while degraded, so a later LSN can never apply
      // over this held, unapplied batch. Recovery is a restart/refetch: the persisted offset was not
      // advanced, so the held batch re-streams from the same frontier.
      const messagesToCommit = inbox.peekUpTo(targetLsn);

      // Record every shape's reset epoch AT PEEK TIME (synchronously with the peeks, before the async
      // transaction). If a must-refetch + re-snapshot bumps a shape's epoch mid-commit, the acks below
      // skip that shape so its post-reset rebuild survives rather than being deleted/spliced away — see
      // ShapeInbox.ackUpTo / ackMoveOuts / ackMoveIns.
      const epochsAtPeek = inbox.snapshotEpochs();

      // Capture, per shape, whether it is still accepting snapshot (LSN-0) rows AT PEEK TIME. A shape in
      // snapshot acceptance (post-reset re-snapshot, or a brand-new shape before its first real lsn) can
      // have the SAME snapshot rows double-delivered by the racing recovery fetch loops — possibly across
      // separate commits — so its inserts are applied idempotently (upsert) rather than as plain
      // collision-surfacing inserts. Once a real lsn re-arms the dedup, this is false and the live-tail
      // plain-INSERT invariant (a genuine PK collision must surface, ADR-0014) is back in force.
      const snapshotModeAtPeek = new Map<string, boolean>(
        Object.keys(shapes).map((shapeName) => [shapeName, inbox.acceptsSnapshotRowsFor(shapeName)]),
      );

      // Snapshot the truncate set so a retried transaction still truncates; the per-shape flag is
      // cleared only once the commit has succeeded.
      const shapesToTruncate = new Set(truncateNeeded);

      // Peek the buffered tagged-subquery move-outs (ADR-0023) the same way: held in the buffer so a
      // retried/degraded commit still has them, ACKed only on success (by the exact peeked count, so a
      // move-out that arrived during a coalescing commit is not dropped).
      const moveOutsToCommit = new Map<string, MovePattern[][]>();
      // Peek the buffered tagged-subquery move-ins (ADR-0024) identically: a move-in snapshot row carries
      // no LSN; it is applied idempotently in the commit transaction and ACKed only on success.
      const moveInsToCommit = new Map<string, ChangeMessage<Row<unknown>>[]>();
      for (const shapeName of Object.keys(shapes)) {
        const pendingOut = inbox.peekMoveOuts(shapeName);
        if (pendingOut.length > 0) {
          moveOutsToCommit.set(shapeName, pendingOut);
        }
        const pendingIn = inbox.peekMoveIns(shapeName);
        if (pendingIn.length > 0) {
          moveInsToCommit.set(shapeName, pendingIn);
        }
      }

      const runCommit = () =>
        pg.transaction(async (tx) => {
          if (debug) {
            console.time("commit");
          }

          // Tier ③ (ADR-0028 allow-list): a `SET LOCAL` GUC — the sync-origin `<schema>.syncing` flag
          // the apply trigger reads to distinguish streamed server truth from local writes. GUCs have
          // no tier-①/② builder form; the schema identifier is fixed at engine construction.
          await tx.exec(`SET LOCAL ${metadataSchema}.syncing = true;`);

          for (const [shapeName, initialMessages] of messagesToCommit.entries()) {
            const shape = getShapeOptions(shapes, shapeName);
            const target = getTarget(shapeName);
            const shapeMethod = shapeInsertMethod.get(shapeName)!;
            let messages = initialMessages;

            // ADR-0023: the shape's tag store key (synced table, schema-qualified).
            const shapeTable = tableIdentity(target);

            if (shapesToTruncate.has(shapeName)) {
              if (debug) {
                console.log("truncating table", shapeTable);
              }
              if (shape.onMustRefetch) {
                await shape.onMustRefetch(drizzleOverPg(tx));
              } else {
                // ADR-0029 D4: a must-refetch wipe is engine cache maintenance, not server truth — so it
                // TRUNCATEs (tier ②; `TRUNCATE` has no Drizzle builder, the table object is interpolated)
                // rather than reacting via the per-row reconcile trigger. Correctness rides the reconcile
                // loop; TRUNCATE is O(1) and the re-snapshot inserts still fire the trigger.
                await drizzleOverPg(tx).execute(sql`TRUNCATE ${target.table}`);
              }
              // The re-snapshot rebuilds tags from scratch, so drop this shape's stale tag-set too
              // (ADR-0023 Slice 2: a must-refetch/​rebuild must not leave orphan tags).
              await clearShapeTags({ pg: tx, metadataSchema, shapeTable, sessionScoped });
            }

            // ADR-0024: this shape's buffered move-in snapshot rows (a row ENTERING the shape). Their
            // tags are UNIONED first (a move-in adds a reason, it must not clear an independent grant's
            // tag) — and a regular change for the same row in this batch then authoritatively replaces
            // below, so union-then-replace converges either way.
            const moveInMessages = moveInsToCommit.get(shapeName) ?? [];
            if (moveInMessages.length > 0) {
              await addShapeRowTags({
                pg: tx,
                metadataSchema,
                shapeTable,
                messages: moveInMessages,
                primaryKey: target.primaryKey,
                sessionScoped,
              });
            }

            // Maintain the tag-set from the RAW drained batch (ADR-0023) — before the data apply and
            // the move-out eviction, so an add-then-remove within one commit resolves correctly. Uses
            // `initialMessages` (the full batch) since the insert/​fold split below reduces `messages`.
            await applyShapeTagSync({
              pg: tx,
              metadataSchema,
              shapeTable,
              messages: initialMessages,
              primaryKey: target.primaryKey,
              sessionScoped,
            });

            // ADR-0024: apply the move-in rows idempotently BEFORE the change fold, so a same-commit
            // update to a just-moved-in row lands on a present row. Upsert (not plain INSERT) because the
            // row may already be present via another grant or be re-delivered on a resume.
            if (moveInMessages.length > 0) {
              await applyUpsertsToTable({
                pg: tx,
                target,
                messages: moveInMessages,
                debug,
              });
            }

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
                if (target.applyMode === "upsert") {
                  // ADR-0045: the initial bulk-insert fast path's appliers (json/copy/insert) are all
                  // plain-INSERT appliers with no conflict clause. A local trigger can already have created
                  // rows before this snapshot applies — even on a fresh store, because another table's
                  // apply in the same catch-up can fire the trigger — so route through an idempotent
                  // upsert applier instead, keeping the `useInsert` bookkeeping identical. A json- or
                  // COPY-classified table takes the set-based `json_to_recordset` upsert (COPY itself has
                  // no ON CONFLICT clause, so json is the bulk ceiling — and it keeps the performance a
                  // param-bound `applyUpsertsToTable` would lose on a large snapshot). A table classified
                  // `insert` is so BECAUSE a column is not json-safe — it must take the batched-VALUES
                  // upsert, never the json cast.
                  const applyInitialUpserts =
                    shapeMethod === "insert" ? applyUpsertsToTable : applyUpsertsToTableWithJson;
                  await applyInitialUpserts({
                    pg: tx,
                    target,
                    messages: initialInserts,
                    debug,
                  });
                } else {
                  await insertMethods[shapeMethod]({
                    pg: tx,
                    target,
                    messages: initialInserts,
                    debug,
                  });
                }

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
              const folded = foldChangeBatch(messages);

              if (folded.deletes.length > 0) {
                await applyBulkDeletesToTable({
                  pg: tx,
                  target,
                  messages: folded.deletes,
                  debug,
                });
              }
              if (folded.inserts.length > 0) {
                if (snapshotModeAtPeek.get(shapeName) || target.applyMode === "upsert") {
                  // Snapshot-acceptance mode (post-reset re-snapshot / pre-first-lsn): the racing recovery
                  // loops can re-deliver these exact snapshot rows, possibly in a later commit after this
                  // shape's TRUNCATE flag has been consumed — so apply them idempotently (upsert), the same
                  // posture as a move-in, rather than failing the commit on a PK collision.
                  // ADR-0045: a table declaring `applyMode: "upsert"` also folds its CDC inserts through the
                  // idempotent applier, because a local trigger may already have created the provisional row.
                  await applyUpsertsToTable({
                    pg: tx,
                    target,
                    messages: folded.inserts,
                    debug,
                  });
                } else {
                  await applyInsertsToTable({
                    pg: tx,
                    target,
                    messages: folded.inserts,
                    debug,
                  });
                }
              }
              if (folded.updates.length > 0) {
                await applyBulkUpdatesToTable({
                  pg: tx,
                  target,
                  messages: folded.updates,
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
                target,
                patternSets,
                debug,
                sessionScoped,
              });
            }
          }

          if (key) {
            await updateSubscriptionState({
              pg: tx,
              metadataSchema,
              subscriptionKey: key,
              sessionScoped,
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
            // committed frontier, ACK the peeked buffer, or clear truncate flags for discarded work.
            return false;
          }
          committedLsn = targetLsn;
          // The transaction committed — now (and only now) remove the peeked batch from the inbox, passing
          // the peek-time epochs so a shape reset mid-commit is skipped (its rebuild survives). Move-outs/
          // move-ins are ACKed by the exact peeked count so anything that arrived during a coalescing
          // commit survives for the next run.
          inbox.ackUpTo(targetLsn, epochsAtPeek);
          for (const [shapeName, patternSets] of moveOutsToCommit) {
            inbox.ackMoveOuts(shapeName, patternSets.length, epochsAtPeek.get(shapeName) ?? inbox.epochFor(shapeName));
          }
          for (const [shapeName, moveInMessages] of moveInsToCommit) {
            inbox.ackMoveIns(
              shapeName,
              moveInMessages.length,
              epochsAtPeek.get(shapeName) ?? inbox.epochFor(shapeName),
            );
          }
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

    // ─── Live-tail sibling nudge (ADR-0031 live-tail completion) ──────────────────────────────────────
    // The catch-up alignment (ADR-0031 in shape-inbox.ts) fixed this class of stall at BOOT: quiet shapes'
    // stale cached watermarks no longer hold a busy shape's backfill. On the LIVE tail the same shape holds
    // recur — a change batch lands on a busy shape at LSN L, but the group commits only at the min effective
    // frontier, so the batch stays buffered until every quiet sibling's PARKED long-poll returns a fresh
    // `global_last_seen_lsn` (~41s on Electric Cloud). This watchdog closes that live-tail gap: when a batch
    // is gated (its `batchMaxLsn > committedLsn`), it nudges each lagging sibling — aborting its parked poll
    // and forcing an immediate NON-live catch-up (`forceDisconnectAndRefresh`), which returns a fresh
    // watermark in ~sub-second. The group frontier then reaches L and the normal commit path (driven by the
    // up-to-date arrivals, NOT by this watchdog) fires. Atomicity is untouched: commits still happen only at
    // the group min frontier. The one-shot cache-buster (`nudgeBusters` + `withNudgeBuster`) defends each
    // nudged catch-up against a CDN HIT that would echo the stale watermark. Bounded to NUDGE_MAX_ROUNDS so a
    // genuinely-dead or still-legitimately-polling sibling degrades to the old wait-out-the-poll behavior
    // rather than a refresh storm.
    const nudgeInFlight = new Map<string, Promise<void>>();
    let nudgeTargetLsn: Lsn = BigInt(-1);
    let nudgeWatchdogRunning = false;

    // Void-called from the subscribe callback (never awaited — it must not backpressure the stream). Raises
    // the shared target and, if not already running, runs bounded rounds until the frontier reaches it, the
    // group tears down / degrades / re-closes its gate, or the rounds exhaust. Single-flight: a concurrent
    // gated batch just raises `nudgeTargetLsn` and returns. Wrapped so it can never throw unhandled.
    const runNudgeWatchdog = async (targetLsn: Lsn): Promise<void> => {
      if (targetLsn > nudgeTargetLsn) {
        nudgeTargetLsn = targetLsn;
      }
      if (nudgeWatchdogRunning) {
        return;
      }
      nudgeWatchdogRunning = true;
      try {
        // Pre-alignment (boot catch-up, before ADR-0031 lays the commit floors) the nudge is pure noise:
        // the alignment itself will commit the gated backfill the moment every shape reports, and firing
        // busted catch-ups mid-boot only contends with the boot requests. The floors survive later resets,
        // so this gate closes exactly once — the live tail is always past it.
        if (inbox.alignedFloor() < BigInt(0)) {
          return;
        }
        // Resolved / torn-down / gated-shut → nothing to nudge; the up-to-date arrival itself runs the
        // commit, so the watchdog never commits.
        const resolvedOrStopped = (): boolean =>
          unsubscribed || degraded || !dbGateOpen || lowestCompleteLsn() >= nudgeTargetLsn;

        // Hold-persistence grace: a cross-shape transaction's sibling halves arrive milliseconds apart,
        // so EVERY grouped commit passes through a transient held instant — nudging on it would abort
        // the sibling poll that is about to deliver the other half (the sync-e2e regression). Only a
        // hold that survives this grace is a real quiet-sibling park worth nudging.
        for (let waited = 0; waited < NUDGE_HOLD_GRACE_MS; waited += NUDGE_ROUND_GRACE_MS) {
          await new Promise((resolve) => setTimeout(resolve, NUDGE_ROUND_GRACE_MS));
          if (resolvedOrStopped()) {
            return;
          }
        }

        for (let round = 1; round <= NUDGE_MAX_ROUNDS; round++) {
          if (resolvedOrStopped()) {
            return;
          }
          for (const shapeName of Object.keys(shapes)) {
            // A shape still catching up advances on its own — only nudge one already in its live tail.
            if (!inbox.hasReportedUpToDate(shapeName)) continue;
            if (inbox.effectiveLsnFor(shapeName) >= nudgeTargetLsn) continue;
            if (nudgeInFlight.has(shapeName)) continue;
            // `forceDisconnectAndRefresh` is declared on the real ShapeStream, but a mocked/typed surface may
            // omit it — reach it structurally and skip (with a rail line) when absent.
            const stream = getShapeStream(shapeName) as { forceDisconnectAndRefresh?: () => Promise<void> };
            if (typeof stream.forceDisconnectAndRefresh !== "function") {
              syncDebug("live-tail sibling nudge unavailable", { shape: shapeName });
              continue;
            }
            // Arm the one-shot cache-buster BEFORE the refresh so the forced catch-up carries it.
            nudgeBusters.set(shapeName, crypto.randomUUID());
            syncDebug("live-tail sibling nudge", { shape: shapeName, target: String(nudgeTargetLsn), round });
            const refresh = stream
              .forceDisconnectAndRefresh()
              .catch((err: unknown) =>
                syncDebug("live-tail sibling nudge failed", { shape: shapeName, error: String(err) }),
              )
              .finally(() => {
                nudgeInFlight.delete(shapeName);
              });
            nudgeInFlight.set(shapeName, refresh);
          }
          // Nothing to nudge and nothing in flight → exit QUIETLY (no exhaustion line). This is the routine
          // pre-alignment case: a gated batch during catch-up has siblings that have not yet reported
          // up-to-date, and those advance on their own — spinning the remaining rounds would only delay-loop
          // and print a misleading "exhausted" line on every boot rail. The "held by group frontier" line
          // already told the story.
          if (nudgeInFlight.size === 0) {
            return;
          }
          // Wait for this round's forced catch-ups to actually land and advance the frontier. The refresh
          // promises settle before the refreshed response does (measured), so awaiting them alone would
          // re-nudge into still-in-flight requests — poll the frontier instead, bounded per round, and
          // break out the moment the target is reached.
          await Promise.all([...nudgeInFlight.values()]);
          for (let waited = 0; waited < NUDGE_ROUND_WAIT_MS; waited += NUDGE_ROUND_GRACE_MS) {
            await new Promise((resolve) => setTimeout(resolve, NUDGE_ROUND_GRACE_MS));
            if (resolvedOrStopped()) {
              return;
            }
          }
        }
        // Rounds exhausted and the frontier is still short: a sibling is dead or genuinely mid-poll. Degrade
        // to the old behavior (wait out its live long-poll) rather than nudge forever.
        syncDebug("live-tail nudge exhausted; waiting on sibling live polls", {
          target: String(nudgeTargetLsn),
          frontier: String(lowestCompleteLsn()),
        });
      } catch (err) {
        syncDebug("live-tail nudge watchdog error", { error: String(err) });
      } finally {
        nudgeWatchdogRunning = false;
      }
    };

    // Drain buffered changes up to the current complete frontier, one commit at a time, looping
    // while fresh messages keep arriving (so commits coalesce). Returns early on `degraded` — a held
    // commit is not retried here; recovery is a later message/refetch or a restart.
    const runCommitLoop = async (): Promise<void> => {
      do {
        commitRerun = false;
        const target = lowestCompleteLsn();
        const isCommitNeeded = target > committedLsn;
        const isMustRefetchAndCatchingUp = target >= committedLsn && truncateNeeded.size > 0;
        // A buffered move-out (ADR-0023) or move-in (ADR-0024) must be committed even if no change
        // advanced the frontier — the revocation/grant has to land. Their `up-to-date` normally advances
        // `target`, but don't rely on that (move/event messages carry no LSN).
        const hasPendingMoves = target >= committedLsn && (inbox.hasPendingMoveOuts() || inbox.hasPendingMoveIns());
        // ADR-0031: a LATE-arriving change at or below an already-committed target must still commit. The
        // aligned commit floor lets `ingestChange` accept a change below the floor (its dedup frontier is
        // the raw `completeLsns`, unmoved by the floor), so such a change can land AFTER the group frontier
        // has already reached — or passed — its LSN, where no frontier advance would trigger a commit for
        // it. Committing at `target === committedLsn` is safe: it mirrors the moves path, which already
        // calls `commitUpToLsn(target)` with no frontier advance. (At `target > committedLsn` this overlaps
        // `isCommitNeeded` — harmless; the expression stays simple.)
        const hasLateArrivals = target >= committedLsn && inbox.hasBufferedChangesAtOrBelow(target);
        if (isCommitNeeded || isMustRefetchAndCatchingUp || hasPendingMoves || hasLateArrivals) {
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
      // ADR-0009 decision 5: once a commit exhausts its retries the engine latches `degraded` and
      // REFUSES to run any further commit. `commitUpToLsn` peeks (never drains) the buffer, so the
      // unapplied batch is still held; refusing later commits guarantees a newer LSN can never apply
      // over that held batch (the divergence the destructive drain allowed). The buffer keeps
      // accumulating incoming messages harmlessly; recovery is a restart/refetch, which re-streams the
      // held frontier because the persisted offset was never advanced. Note the commit-await backpressure
      // is intentionally absent while degraded — the inbox grows at the stream's rate until recovery,
      // which is the accepted cost of ADR-0009's documented "hold the buffer" posture.
      if (degraded) {
        return commitInFlight ?? Promise.resolve();
      }
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
      // Boot observability (ADR-0034): one delivery = one shape-stream response. Records the fetch (network)
      // gap since the last settle plus this batch's request + change-row counts. No-op post-ready (frozen).
      bootStamp?.onBatchDelivered(changeCount);
      const commitStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();

      // The max LSN over the change rows this batch COMPLETED (routed to `ingestChange` with `isLastOfLsn`;
      // move-in rows carry no lsn and are excluded). It is what the batch needs the group frontier to reach
      // to actually commit — the truth test for the "applied" vs "held" rail line below. -1 if none.
      let batchMaxLsn: Lsn = BigInt(-1);

      messages.forEach((message) => {
        if (isChangeMessage(message)) {
          // A tagged-subquery MOVE-IN row (ADR-0024): an existing row ENTERING the shape because a grant
          // was added. Electric delivers it as a snapshot insert flagged `is_move_in` with NO `lsn`/`last`
          // (it is not a replication-stream change), so the `ingestChange` dedup — which floors a missing
          // lsn to 0 — would treat it as already-seen and drop it once the frontier passed 0. Route it to
          // its own buffer, applied idempotently at the next commit (the trailing `up-to-date`).
          if (message.headers["is_move_in"] === true) {
            inbox.ingestMoveIn(message.shape, message);
          } else {
            const { lsn, isLastOfLsn } = readReplicationHeaders(message.headers);
            inbox.ingestChange(message.shape, message, lsn, isLastOfLsn);
            if (isLastOfLsn && lsn > batchMaxLsn) {
              batchMaxLsn = lsn;
            }
          }
        } else if (isControlMessage(message)) {
          switch (message.headers.control) {
            case "up-to-date": {
              if (debug) {
                console.log("received up-to-date", message);
              }
              if (typeof message.headers.global_last_seen_lsn !== "string") {
                throw new Error("global_last_seen_lsn is not a string");
              }
              // ADR-0031: `ingestUpToDate` returns true ONLY on the transition where this control message
              // completed the group (every shape has now reported up-to-date) and the inbox aligned the
              // commit floors. Surface that single moment on the debug rail so a "stale board at load that
              // rearranges itself" symptom is diagnosable — the floor it aligned to is the group head.
              if (inbox.ingestUpToDate(message.shape, BigInt(message.headers.global_last_seen_lsn))) {
                syncDebug("catch-up watermark aligned", { floor: String(inbox.alignedFloor()) });
              }
              break;
            }
            case "must-refetch": {
              if (debug) {
                console.log("received must-refetch", message);
              }
              // Surface the expired-handle / rewind event on the syncDebug rail too (the `debug` option only
              // console.logs it): must-refetch is the trigger for the truncate + re-snapshot
              // recovery, so it must be visible when diagnosing a convergence loss in a live app.
              syncDebug("must-refetch received", { shape: message.shape });
              inbox.resetShape(message.shape);
              truncateNeeded.add(message.shape);
              break;
            }
          }
        } else if (isEventMessage(message)) {
          // ADR-0023: a tagged-subquery move-out — a grant was revoked, so the rows it kept in the shape
          // must be evicted. Buffer the patterns; the eviction runs in the next commit (decision 3).
          // `MultiShapeStream`'s callback type does not declare `EventMessage` (the prior guards narrow
          // `message` to `never` here), so reach the runtime-present event through an explicit cast.
          const eventMessage = message as unknown as ShapeEventMessage;
          if (eventMessage.headers.event === "move-out") {
            if (debug) {
              console.log("received move-out", eventMessage);
            }
            inbox.ingestMoveOut(eventMessage.shape, eventMessage.headers.patterns);
          }
          // A `move-in` EventMessage (ADR-0024) needs no action here: its newly-matched rows arrive in the
          // same batch as snapshot inserts flagged `is_move_in`, which the change branch routes to the
          // move-in buffer. The event's `patterns` are redundant with those inserts' `tags`.
        }
      });

      // Buffering above is synchronous. On the overlap path, while the commit gate is still closed the
      // batch stays in the memory inbox (its LSN frontier + catch-up watermarks still advance from the
      // ingest above) and the callback returns WITHOUT awaiting a commit — so the stream keeps fetching
      // catch-up and does not stall behind the local boot phases. Once the gate lifts, the deferred commit
      // train (below) drains everything buffered. On the sequential path the gate is already open, so this
      // is the unchanged path: enqueue the single-flight commit and await it (the natural backpressure that
      // bounds the buffer — replacing the old fire-and-forget commit + `setTimeout(0)` race).
      if (dbGateOpen) {
        const applyStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        await enqueueCommit();
        // Boot observability (ADR-0034): the apply (commit-into-PGlite) wall for this delivery.
        bootStamp?.onApply((typeof performance !== "undefined" ? performance.now() : Date.now()) - applyStartedAt);
        if (changeCount > 0) {
          // Truthful rail (ADR-0031): the "applied" line only fires when this batch's completed changes
          // actually landed (its `batchMaxLsn` is at or below the advanced `committedLsn`). Otherwise the
          // group frontier had not reached them — the batch is BUFFERED behind a quiet sibling's watermark —
          // so say so, and kick the live-tail sibling nudge to shorten that hold (void: never backpressure
          // the stream).
          if (batchMaxLsn <= committedLsn) {
            const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - commitStartedAt;
            syncDebug("sync applied change batch to local store", { changes: changeCount, ms: Math.round(elapsed) });
          } else {
            syncDebug("sync change batch held by group frontier", {
              changes: changeCount,
              heldLsn: String(batchMaxLsn),
              frontier: String(lowestCompleteLsn()),
            });
            void runNudgeWatchdog(batchMaxLsn);
          }
        }
      }
    }, onError);

    // Fresh-store prefetch overlap (ADR-0032 S4): the moment the caller signals the local store is ready
    // (schema exec + journal recovery + store-version reconcile done), run the deferred metadata DDL, open
    // the commit gate, and drain everything the streams buffered during the window in one commit train. The
    // ADR-0031 catch-up watermarks were aligned by the ingests above as the up-to-dates arrived, so this
    // drain commits to the aligned floor and `onInitialSync` fires exactly as on the sequential path.
    if (overlap) {
      void dbReady!.then(async () => {
        if (unsubscribed) {
          return;
        }
        // The metadata tables' DDL was deferred past the gate (the store had no schema when the streams
        // started); create them now, before the first commit needs the subscription-state table.
        await initMetadataTables();
        dbGateOpen = true;
        syncDebug("boot commits opened");
        // Boot observability (ADR-0034): on the overlap path the buffered catch-up drains here (not in a
        // subscribe callback), so stamp the drain's apply wall into the group's accumulator.
        const drainStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        await enqueueCommit();
        bootStamp?.onApply((typeof performance !== "undefined" ? performance.now() : Date.now()) - drainStartedAt);
      });
    }

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
        shapePerTableLock.delete(shape.tableKey);
      }
    };

    return {
      unsubscribe,
      get isUpToDate() {
        // Never report up-to-date while a commit is pending or after going degraded (ADR-0009
        // decision 5): the read cache must not claim to match the server on an unapplied commit. Nor while
        // the overlap commit gate is still closed (ADR-0032 S4): the stream may already be `isUpToDate` on
        // the network side while its catch-up is still buffered, unapplied, in the memory inbox.
        return dbGateOpen && !degraded && commitInFlight === null && multiShapeStream.isUpToDate;
      },
      streams: Object.fromEntries(
        Object.keys(shapes).map((shapeName) => [shapeName, getShapeStream(shapeName)]),
      ) as SyncShapesToTablesResult["streams"],
    };
  };

  const syncShapeToTable = async (options: SyncShapeToTableOptions): Promise<SyncShapeToTableResult> => {
    // ADR-0029 D6: thin sugar over the group form, forwarding the same entry-based options. The
    // per-shape `initialInsertMethod` (if any) rides through; the group form resolves the backfill
    // strategy from the registry entry when it is absent.
    const multiShapeSub = await syncShapesToTables({
      registry: options.registry,
      shapes: {
        shape: {
          shape: options.shape,
          tableKey: options.tableKey,
          onMustRefetch: options.onMustRefetch,
          ...(options.initialInsertMethod ? { initialInsertMethod: options.initialInsertMethod } : {}),
        },
      },
      key: options.shapeKey,
      ...(options.sessionScoped ? { sessionScoped: options.sessionScoped } : {}),
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
    // ADR-0042: the scope-blind delete now also touches `pg_temp.subscriptions_metadata`, which does NOT
    // exist until the (per-engine, memoized) metadata migration has run — so a warm-store reset that fires
    // before any group started (nothing else triggered `initMetadataTables` yet) would hit 42P01. Ensure the
    // provisioning first; the promise is memoized/idempotent, so on the normal path (a group already
    // started) this is a no-op await on the resolved init promise.
    await initMetadataTables();
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
    namespace: namespaceObj,
    close,
  };
}

/**
 * The pgxsinkit sync engine handle: the {@link SyncNamespaceObj} the client attaches as `pg.electric`,
 * plus the explicit `close()` teardown. Derived from {@link createSyncEngine}'s real return so the type
 * follows the object.
 */
export type SyncEngine = Awaited<ReturnType<typeof createSyncEngine>>;
export type SyncNamespaceObj = SyncEngine["namespace"];

export type PGliteWithSync = PGliteInterface & {
  sync: SyncNamespaceObj;
};
