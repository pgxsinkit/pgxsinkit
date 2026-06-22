import type { Row } from "@electric-sql/client";
import { isChangeMessage, isControlMessage } from "@electric-sql/client";
import type { ChangeMessage, ShapeStreamOptions } from "@electric-sql/client";
import { MultiShapeStream } from "@electric-sql/experimental";
import type { Extension, PGliteInterface } from "@electric-sql/pglite";

import { type ApplyStrategy, quoteIdentifier } from "@pgxsinkit/contracts";

import { computeRetryDelayMs } from "../mutation";
import {
  applyInsertsToTable,
  applyMessageToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
} from "./apply";
import {
  deleteSubscriptionState,
  getSubscriptionState,
  migrateSubscriptionMetadataTables,
  type SubscriptionState,
  updateSubscriptionState,
} from "./subscription-state";
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
 * initial-backfill apply path. Undefined (no registry-supplied strategy) defaults to `insert`,
 * the always-correct floor.
 */
function applyStrategyToInsertMethod(strategy: ApplyStrategy | undefined): InitialInsertMethod {
  switch (strategy) {
    case "copy":
      return "csv";
    case "json":
      return "json";
    default:
      return "insert";
  }
}

function readReplicationHeaders(headers: ChangeMessage["headers"]): { lsn: bigint; isLastOfLsn: boolean } {
  const rawLsn: unknown = headers["lsn"];

  return {
    lsn: typeof rawLsn === "string" ? BigInt(rawLsn) : BigInt(0),
    isLastOfLsn: headers["last"] === true,
  };
}

async function createPlugin(pg: PGliteInterface, options?: ElectricSyncOptions) {
  const debug = options?.debug ?? false;
  const metadataSchema = options?.metadataSchema ?? "electric";
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
    useCopy = false,
    initialInsertMethod = "insert",
    onInitialSync,
    onError,
    onSyncError,
    maxCommitRetries = DEFAULT_MAX_COMMIT_RETRIES,
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

    if (useCopy && initialInsertMethod === "insert") {
      initialInsertMethod = "csv";
      console.warn(
        "The useCopy option is deprecated and will be removed in a future version. Use initialInsertMethod instead.",
      );
    }

    let useInsert = !isNewSubscription || initialInsertMethod === "insert";
    let onInitialSyncCalled = false;

    const maybeSignalInitialSync = () => {
      if (onInitialSync && !onInitialSyncCalled && multiShapeStream.isUpToDate) {
        onInitialSync();
        onInitialSyncCalled = true;
      }
    };

    const changes = new Map<string, Map<Lsn, ChangeMessage<Row<unknown>>[]>>(
      Object.keys(shapes).map((key) => [key, new Map()]),
    );

    const completeLsns = new Map<string, Lsn>(Object.keys(shapes).map((key) => [key, BigInt(-1)]));

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
      csv: applyMessagesToTableWithCopy,
      useCopy: applyMessagesToTableWithCopy,
      insert: applyInsertsToTable,
    } as const;

    // Apply everything buffered up to `targetLsn` in a single transaction, retrying with jittered
    // backoff on failure. Returns `true` once applied (and advances the running committed frontier);
    // returns `false` without advancing if the engine unsubscribed mid-flight or the commit
    // exhausted its retries (→ `degraded` + `onSyncError`, ADR-0009 decision 5). The drained
    // messages and the truncate snapshot are held across retries so a transient failure loses
    // nothing; the read cache never advances past an unapplied commit.
    const commitUpToLsn = async (targetLsn: Lsn): Promise<boolean> => {
      const messagesToCommit = new Map<string, ChangeMessage<Row<unknown>>[]>(
        Object.keys(shapes).map((shapeName) => [shapeName, []]),
      );

      for (const [shapeName, shapeChanges] of changes.entries()) {
        const messagesForShape = messagesToCommit.get(shapeName)!;
        for (const lsn of shapeChanges.keys()) {
          if (lsn <= targetLsn) {
            for (const message of shapeChanges.get(lsn)!) {
              messagesForShape.push(message);
            }
            shapeChanges.delete(lsn);
          }
        }
      }

      // Snapshot the truncate set so a retried transaction still truncates; the per-shape flag is
      // cleared only once the commit has succeeded.
      const shapesToTruncate = new Set(truncateNeeded);

      const runCommit = () =>
        pg.transaction(async (tx) => {
          if (debug) {
            console.time("commit");
          }

          await tx.exec(`SET LOCAL ${metadataSchema}.syncing = true;`);

          for (const [shapeName, initialMessages] of messagesToCommit.entries()) {
            const shape = getShapeOptions(shapes, shapeName);
            let messages = initialMessages;

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
            }

            if (!useInsert) {
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
              if (initialInserts.length > 0 && initialInsertMethod === "csv") {
                remainingMessages.unshift(initialInserts.pop()!);
              }
              messages = remainingMessages;

              if (initialInserts.length > 0) {
                await insertMethods[initialInsertMethod]({
                  pg: tx,
                  table: shape.table,
                  schema: shape.schema,
                  messages: initialInserts,
                  mapColumns: shape.mapColumns,
                  primaryKey: shape.primaryKey,
                  columnTypes: shape.columnTypes,
                  debug,
                });

                useInsert = true;
              }
            }

            const bulkInserts: InsertChangeMessage[] = [];
            let change: ChangeMessage<Row<unknown>> | null = null;
            const messagesLength = messages.length;
            for (const [index, changeMessage] of messages.entries()) {
              if (changeMessage.headers.operation === "insert") {
                bulkInserts.push(changeMessage as InsertChangeMessage);
              } else {
                change = changeMessage;
              }

              if (change || index === messagesLength - 1) {
                if (bulkInserts.length > 0) {
                  await applyInsertsToTable({
                    pg: tx,
                    table: shape.table,
                    schema: shape.schema,
                    messages: bulkInserts,
                    mapColumns: shape.mapColumns,
                    primaryKey: shape.primaryKey,
                    columnTypes: shape.columnTypes,
                    debug,
                  });
                  bulkInserts.length = 0;
                }
                if (change) {
                  await applyMessageToTable({
                    pg: tx,
                    table: shape.table,
                    schema: shape.schema,
                    message: change,
                    mapColumns: shape.mapColumns,
                    primaryKey: shape.primaryKey,
                    debug,
                  });
                  change = null;
                }
              }
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
        });

      for (let attempt = 1; ; attempt++) {
        if (unsubscribed) {
          return false;
        }
        try {
          await runCommit();
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
          await new Promise((resolve) => setTimeout(resolve, computeRetryDelayMs(attempt)));
        }
      }
    };

    const lowestCompleteLsn = (): Lsn =>
      Array.from(completeLsns.values()).reduce((minimum, entry) => (entry < minimum ? entry : minimum));

    // Drain buffered changes up to the current complete frontier, one commit at a time, looping
    // while fresh messages keep arriving (so commits coalesce). Returns early on `degraded` — a held
    // commit is not retried here; recovery is a later message/refetch or a restart.
    const runCommitLoop = async (): Promise<void> => {
      do {
        commitRerun = false;
        const target = lowestCompleteLsn();
        const isCommitNeeded = target > committedLsn;
        const isMustRefetchAndCatchingUp = target >= committedLsn && truncateNeeded.size > 0;
        if (isCommitNeeded || isMustRefetchAndCatchingUp) {
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
      if (debug) {
        console.log("received messages", messages.length);
      }

      messages.forEach((message) => {
        const lastCommittedLsnForShape = completeLsns.get(message.shape) ?? BigInt(-1);

        if (isChangeMessage(message)) {
          const shapeChanges = changes.get(message.shape)!;
          const { lsn, isLastOfLsn } = readReplicationHeaders(message.headers);
          if (lsn <= lastCommittedLsnForShape) {
            return;
          }
          if (!shapeChanges.has(lsn)) {
            shapeChanges.set(lsn, []);
          }
          shapeChanges.get(lsn)!.push(message);
          if (isLastOfLsn) {
            completeLsns.set(message.shape, lsn);
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
              const globalLastSeenLsn = BigInt(message.headers.global_last_seen_lsn);
              if (globalLastSeenLsn <= lastCommittedLsnForShape) {
                return;
              }
              completeLsns.set(message.shape, globalLastSeenLsn);
              break;
            }
            case "must-refetch": {
              if (debug) {
                console.log("received must-refetch", message);
              }
              const shapeChanges = changes.get(message.shape)!;
              shapeChanges.clear();
              completeLsns.set(message.shape, BigInt(-1));
              truncateNeeded.add(message.shape);
              break;
            }
          }
        }
      });

      // Buffering above is synchronous; here we enqueue the single-flight commit and await it. The
      // stream awaits this callback, so awaiting the (coalesced) commit is the natural backpressure
      // that bounds the buffer — replacing the old fire-and-forget commit + `setTimeout(0)` race.
      await enqueueCommit();
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
      useCopy: options.useCopy,
      // Static type-driven selection (ADR-0009 decision 3): an explicit `initialInsertMethod`/`useCopy`
      // (the generic/legacy API) still wins; otherwise the registry-resolved `applyStrategy` picks the
      // backfill path, defaulting to `insert`.
      initialInsertMethod: options.initialInsertMethod ?? applyStrategyToInsertMethod(options.applyStrategy),
      onInitialSync: options.onInitialSync,
      onError: options.onError,
      onSyncError: options.onSyncError,
      maxCommitRetries: options.maxCommitRetries,
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
    name: "ElectricSQL Sync",
    setup: async (pg: PGliteInterface) => {
      const { namespaceObj, close } = await createPlugin(pg, options);
      return {
        namespaceObj,
        close,
      };
    },
  } satisfies Extension;
}
