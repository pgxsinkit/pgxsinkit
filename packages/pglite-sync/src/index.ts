import type { Row } from "@electric-sql/client";
import { isChangeMessage, isControlMessage } from "@electric-sql/client";
import type { ChangeMessage, ShapeStreamOptions } from "@electric-sql/client";
import { MultiShapeStream } from "@electric-sql/experimental";
import type { Extension, PGliteInterface } from "@electric-sql/pglite";

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
} from "./subscriptionState";
import type {
  ElectricSyncOptions,
  InsertChangeMessage,
  Lsn,
  SyncShapesToTablesOptions,
  SyncShapesToTablesResult,
  SyncShapeToTableOptions,
  SyncShapeToTableResult,
} from "./types";

export * from "./types";

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
    const lastCommittedLsn: Lsn = subState?.last_lsn ?? BigInt(-1);

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

    const commitUpToLsn = async (targetLsn: Lsn) => {
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

      await pg.transaction(async (tx) => {
        if (debug) {
          console.time("commit");
        }

        await tx.exec(`SET LOCAL ${metadataSchema}.syncing = true;`);

        for (const [shapeName, initialMessages] of messagesToCommit.entries()) {
          const shape = getShapeOptions(shapes, shapeName);
          let messages = initialMessages;

          if (truncateNeeded.has(shapeName)) {
            if (debug) {
              console.log("truncating table", shape.table);
            }
            if (shape.onMustRefetch) {
              await shape.onMustRefetch(tx);
            } else {
              const schema = shape.schema || "public";
              await tx.exec(`DELETE FROM "${schema}"."${shape.table}";`);
            }
            truncateNeeded.delete(shapeName);
          }

          if (!useInsert) {
            const initialInserts: InsertChangeMessage[] = [];
            const remainingMessages: ChangeMessage<any>[] = [];
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
                debug,
              });

              useInsert = true;
            }
          }

          const bulkInserts: InsertChangeMessage[] = [];
          let change: ChangeMessage<any> | null = null;
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
        if (unsubscribed) {
          await tx.rollback();
        }
      });

      if (debug) console.timeEnd("commit");
      maybeSignalInitialSync();
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
          const lsn = typeof message.headers.lsn === "string" ? BigInt(message.headers.lsn) : BigInt(0);
          if (lsn <= lastCommittedLsnForShape) {
            return;
          }
          const isLastOfLsn = (message.headers.last as boolean | undefined) ?? false;
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

      const lowestCommittedLsn = Array.from(completeLsns.values()).reduce((minimum, entry) =>
        entry < minimum ? entry : minimum,
      );

      const isCommitNeeded = lowestCommittedLsn > lastCommittedLsn;
      const isMustRefetchAndCatchingUp = lowestCommittedLsn >= lastCommittedLsn && truncateNeeded.size > 0;

      if (isCommitNeeded || isMustRefetchAndCatchingUp) {
        void commitUpToLsn(lowestCommittedLsn);
        await new Promise((resolve) => setTimeout(resolve));
        return;
      }

      maybeSignalInitialSync();
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
        return multiShapeStream.isUpToDate;
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
        },
      },
      key: options.shapeKey,
      useCopy: options.useCopy,
      initialInsertMethod: options.initialInsertMethod,
      onInitialSync: options.onInitialSync,
      onError: options.onError,
    });

    return {
      unsubscribe: multiShapeSub.unsubscribe,
      get isUpToDate() {
        return multiShapeSub.isUpToDate;
      },
      stream: (() => {
        const stream = multiShapeSub.streams.shape;
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
