import type { AnyPgTable } from "drizzle-orm/pg-core";
import { ZodObject } from "zod";

import type {
  BatchMutationAck,
  MutationDiagnostics,
  SyncTableCreateInput,
  SyncTableEntry,
  SyncTableName,
  SyncTableRecord,
  SyncTableRegistry,
  SyncTableUpdateInput,
} from "@pgxsinkit/contracts";
import { getProjectedColumns as getProjectedTableColumns, getSyncRegistrySchema } from "@pgxsinkit/contracts";

export type MutationStatus = "pending" | "sending" | "acked" | "failed";
export type MutationKind = "create" | "update" | "delete";

export type MutationBatchItem<TRegistry extends SyncTableRegistry> = {
  [TKey in SyncTableName<TRegistry>]:
    | {
        table: TKey;
        kind: "create";
        input: SyncTableCreateInput<TRegistry, TKey>;
      }
    | {
        table: TKey;
        kind: "update";
        entityKey: Record<string, string>;
        patch: SyncTableUpdateInput<TRegistry, TKey>;
      }
    | {
        table: TKey;
        kind: "delete";
        entityKey: Record<string, string>;
      };
}[SyncTableName<TRegistry>];

export const DEFAULT_FLUSH_BATCH_SIZE = 100;

export interface MutationDetail {
  tableName: string;
  entityKey: Record<string, string>;
  mutationId: string;
  mutationSeq: number;
  mutationKind: MutationKind;
  status: MutationStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
  updatedAtUs: string;
}

export interface MutationDb {
  exec: (sql: string) => Promise<unknown>;
  query: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
}

export interface CreateMutationRuntimeOptions<TRegistry extends SyncTableRegistry> {
  db: MutationDb;
  registry: TRegistry;
  writeUrl: string;
  batchWriteUrl?: string;
  getAuthToken?: () => Promise<string | undefined>;
}

interface TableContext {
  key: string;
  entry: SyncTableEntry<AnyPgTable>;
  readModel: string;
  syncedTable: string;
  overlayTable: string;
  journalTable: string;
  journalSequence: string;
  routeBasePath?: string;
  pkColumnNames: string[];
  pkPropertyKeys: string[];
  recordIncludesOverlayState: boolean;
  columns: Array<{
    propertyKey: string;
    column: ReturnType<typeof getProjectedTableColumns<AnyPgTable>>[number]["column"];
  }>;
}

export interface MutationRuntime<TRegistry extends SyncTableRegistry> {
  create: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    input: SyncTableCreateInput<TRegistry, TKey>,
  ) => Promise<void>;
  update: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
    patch: SyncTableUpdateInput<TRegistry, TKey>,
  ) => Promise<void>;
  delete: <TKey extends SyncTableName<TRegistry>>(table: TKey, entityKey: Record<string, string>) => Promise<void>;
  batch: (items: ReadonlyArray<MutationBatchItem<TRegistry>>) => Promise<void>;
  flush: (table?: SyncTableName<TRegistry>) => Promise<void>;
  reconcile: (table?: SyncTableName<TRegistry>) => Promise<void>;
  retryFailed: (table?: SyncTableName<TRegistry>) => Promise<void>;
  recoverSending: (table?: SyncTableName<TRegistry>) => Promise<void>;
  readMutationStats: (table?: SyncTableName<TRegistry>) => Promise<MutationDiagnostics>;
  readMutationDetails: (table?: SyncTableName<TRegistry>) => Promise<MutationDetail[]>;
  createOptimisticRecord: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    input: SyncTableCreateInput<TRegistry, TKey>,
  ) => SyncTableRecord<TRegistry, TKey>;
}

export function nowMicroseconds(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

export function computeBackoffDelayMs(attemptCount: number) {
  const exponent = Math.max(attemptCount - 1, 0);
  return Math.min(1000 * 2 ** exponent, 30_000);
}

export function computeNextRetryAtUs(nowUs: string, attemptCount: number) {
  return (BigInt(nowUs) + BigInt(computeBackoffDelayMs(attemptCount)) * 1000n).toString();
}

export function shouldClearOverlayRow(syncedUpdatedAtUs: string, serverUpdatedAtUs: string | null) {
  if (serverUpdatedAtUs === null) {
    return false;
  }

  return BigInt(syncedUpdatedAtUs) >= BigInt(serverUpdatedAtUs);
}

export function createMutationRuntime<TRegistry extends SyncTableRegistry>(
  options: CreateMutationRuntimeOptions<TRegistry>,
): MutationRuntime<TRegistry> {
  const resolveAuthToken = async () => {
    if (options.getAuthToken) {
      return await options.getAuthToken();
    }

    return undefined;
  };

  const tableContexts = buildTableContexts(options.registry, options.batchWriteUrl === undefined);
  let flushQueue = Promise.resolve();

  const getTableContext = (table: SyncTableName<TRegistry>) => {
    const context = tableContexts[table];

    if (!context) {
      throw new Error(`Unknown mutation table: ${String(table)}`);
    }

    return context;
  };

  const runInTransaction = async (operation: () => Promise<void>) => {
    await options.db.exec("BEGIN");

    try {
      await operation();
      await options.db.exec("COMMIT");
    } catch (error) {
      await options.db.exec("ROLLBACK");
      throw error;
    }
  };

  const normalizeBatchItem = (item: MutationBatchItem<TRegistry>, order: number): NormalizedBatchItem => {
    const context = getTableContext(item.table as SyncTableName<TRegistry>);
    const mutationId = globalThis.crypto.randomUUID();
    const nowUs = nowMicroseconds();

    switch (item.kind) {
      case "create": {
        const optimisticRecord = ensureRecord(createOptimisticRecordFromContext(context, item.input));
        const entityKey = buildEntityKeyFromRecord(context, optimisticRecord);

        return {
          context,
          kind: "create",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          optimisticRecord,
          input: item.input,
          mutationId,
          nowUs,
          order,
        };
      }
      case "update": {
        const entityKey = normalizeEntityKey(context, item.entityKey);
        const patch = ensureRecord(parseUpdateInput(context, item.patch));

        return {
          context,
          kind: "update",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          patch,
          mutationId,
          nowUs,
          order,
        };
      }
      case "delete": {
        const entityKey = normalizeEntityKey(context, item.entityKey);

        return {
          context,
          kind: "delete",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          mutationId,
          nowUs,
          order,
        };
      }
    }
  };

  const enqueueBatch = async (items: ReadonlyArray<MutationBatchItem<TRegistry>>) => {
    if (items.length === 0) {
      return;
    }

    const normalizedItems = items.map((item, index) => normalizeBatchItem(item, index));
    const batchGroups = new Map<string, { context: TableContext; items: NormalizedBatchItem[] }>();

    for (const item of normalizedItems) {
      const existing = batchGroups.get(item.context.key);

      if (existing) {
        existing.items.push(item);
        continue;
      }

      batchGroups.set(item.context.key, {
        context: item.context,
        items: [item],
      });
    }

    for (const { context, items: groupedItems } of batchGroups.values()) {
      groupedItems.sort((left, right) => left.order - right.order);
      const uniqueEntities = dedupeBatchEntities(groupedItems);
      const latestMutationStates = await readLatestMutationStates(options.db, context, uniqueEntities);
      const currentRecordStates = await readCurrentRecordStates(options.db, context, uniqueEntities);
      const entityStates = new Map<string, BatchEntityState>();

      for (const entity of uniqueEntities) {
        const latestState = latestMutationStates.get(entity.entityKeyJson);
        const currentState = currentRecordStates.get(entity.entityKeyJson);

        entityStates.set(entity.entityKeyJson, {
          entityKey: entity.entityKey,
          entityKeyJson: entity.entityKeyJson,
          record: currentState ? extractRecordFromState(context, currentState) : null,
          overlayKind: currentState?.overlayKind ?? null,
          localUpdatedAtUs: currentState?.localUpdatedAtUs ?? null,
          latestMutationSeq: latestState?.latestMutationSeq ?? null,
          latestMutationKind: latestState?.latestMutationKind ?? null,
          latestMutationStatus: latestState?.latestMutationStatus ?? null,
        });
      }

      const plannedMutations: PlannedMutationInsert[] = [];
      const plannedOverlays = new Map<string, PlannedOverlayUpsert>();

      for (const item of groupedItems) {
        const entityState = entityStates.get(item.entityKeyJson);

        if (!entityState) {
          throw new Error(`Missing batch state for table ${context.key}`);
        }

        switch (item.kind) {
          case "create": {
            if ((entityState.latestMutationSeq ?? 0) !== 0) {
              throw new Error(`${context.key} already has queued mutations`);
            }

            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "create",
              payloadJson: JSON.stringify({
                kind: "create",
                value: item.input,
              }),
              nowUs: item.nowUs,
            });

            entityState.record = item.optimisticRecord;
            entityState.overlayKind = "pending_create";
            entityState.localUpdatedAtUs = item.nowUs;
            entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
            entityState.latestMutationKind = "create";
            entityState.latestMutationStatus = "pending";
            plannedOverlays.set(item.entityKeyJson, {
              entityKey: item.entityKey,
              record: item.optimisticRecord,
              overlayKind: "pending_create",
              localUpdatedAtUs: item.nowUs,
            });
            break;
          }
          case "update": {
            if (!entityState.record) {
              throw new Error(`${context.key} not found in local read model`);
            }

            if (entityState.latestMutationKind === "delete" && entityState.latestMutationStatus !== "acked") {
              throw new Error(`${context.key} is already queued for deletion`);
            }

            const overlayKind = entityState.overlayKind === "pending_create" ? "pending_create" : "pending_update";
            const optimisticRecord = ensureRecord(
              buildOptimisticRecord(
                context,
                {
                  ...entityState.record,
                  ...item.patch,
                  updatedAtUs: item.nowUs,
                },
                {
                  overlayKind,
                  localUpdatedAtUs: item.nowUs,
                },
              ),
            );
            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "update",
              payloadJson: JSON.stringify({
                kind: "update",
                patch: item.patch,
              }),
              nowUs: item.nowUs,
            });

            entityState.record = optimisticRecord;
            entityState.overlayKind = overlayKind;
            entityState.localUpdatedAtUs = item.nowUs;
            entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
            entityState.latestMutationKind = "update";
            entityState.latestMutationStatus = "pending";
            plannedOverlays.set(item.entityKeyJson, {
              entityKey: item.entityKey,
              record: optimisticRecord,
              overlayKind,
              localUpdatedAtUs: item.nowUs,
            });
            break;
          }
          case "delete": {
            if (!entityState.record) {
              throw new Error(`${context.key} not found in local read model`);
            }

            if (entityState.latestMutationKind === "delete" && entityState.latestMutationStatus !== "acked") {
              throw new Error(`${context.key} is already queued for deletion`);
            }

            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "delete",
              payloadJson: JSON.stringify({
                kind: "delete",
                entityKey: item.entityKey,
              }),
              nowUs: item.nowUs,
            });

            entityState.overlayKind = "pending_delete";
            entityState.localUpdatedAtUs = item.nowUs;
            entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
            entityState.latestMutationKind = "delete";
            entityState.latestMutationStatus = "pending";
            plannedOverlays.set(item.entityKeyJson, {
              entityKey: item.entityKey,
              record: entityState.record,
              overlayKind: "pending_delete",
              localUpdatedAtUs: item.nowUs,
            });
            break;
          }
        }
      }

      await insertMutationsBulk(options.db, context, plannedMutations);
      await upsertOverlayRecordsBulk(options.db, context, [...plannedOverlays.values()]);
    }
  };

  const runFlush = async (table?: SyncTableName<TRegistry>) => {
    if (options.batchWriteUrl) {
      const affectedContexts = new Map<string, TableContext>();
      let processedCount = 0;

      do {
        const batchResult = await flushBatch(
          options.db,
          tableContexts as Record<string, TableContext>,
          options.batchWriteUrl,
          table,
          resolveAuthToken,
        );

        processedCount = batchResult.processedCount;

        for (const context of batchResult.affectedContexts) {
          affectedContexts.set(context.key, context);
        }
      } while (processedCount > 0);

      for (const context of affectedContexts.values()) {
        await reconcileTable(options.db, context);
      }
    } else {
      let processedCount = 0;

      do {
        processedCount = 0;

        const contexts = filterContexts(tableContexts, table);

        for (const context of contexts) {
          processedCount += await flushTable(options.db, context, options.writeUrl, resolveAuthToken);
        }
      } while (processedCount > 0);
    }
  };

  return {
    create: async (table, input) => {
      await runInTransaction(async () => {
        await enqueueBatch([
          {
            table,
            kind: "create",
            input,
          },
        ]);
      });
    },
    update: async (table, entityKeyInput, patch) => {
      await runInTransaction(async () => {
        await enqueueBatch([
          {
            table,
            kind: "update",
            entityKey: entityKeyInput,
            patch,
          },
        ]);
      });
    },
    delete: async (table, entityKeyInput) => {
      await runInTransaction(async () => {
        await enqueueBatch([
          {
            table,
            kind: "delete",
            entityKey: entityKeyInput,
          },
        ]);
      });
    },
    batch: async (items) => {
      await runInTransaction(async () => {
        await enqueueBatch(items);
      });
    },
    flush: async (table) => {
      const nextFlush = flushQueue.then(() => runFlush(table));
      flushQueue = nextFlush.catch(() => undefined);
      await nextFlush;
    },
    reconcile: async (table) => {
      const contexts = filterContexts(tableContexts, table);

      for (const context of contexts) {
        await reconcileTable(options.db, context);
      }
    },
    retryFailed: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      const nowUs = nowMicroseconds();

      for (const context of contexts) {
        await options.db.query(
          `
            UPDATE ${context.journalTable}
            SET
              status = 'pending',
              next_retry_at_us = $1::bigint,
              updated_at_us = $1::bigint,
              conflict_reason = NULL
            WHERE status = 'failed'
          `,
          [nowUs],
        );
      }
    },
    recoverSending: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      const nowUs = nowMicroseconds();

      for (const context of contexts) {
        await options.db.query(
          `
            UPDATE ${context.journalTable}
            SET
              status = 'pending',
              updated_at_us = $1::bigint,
              sent_at_us = NULL,
              next_retry_at_us = $1::bigint,
              last_error = NULL,
              last_http_status = NULL,
              conflict_reason = NULL
            WHERE status = 'sending'
          `,
          [nowUs],
        );
      }
    },
    readMutationStats: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      const totals: MutationDiagnostics = {
        pendingCount: 0,
        sendingCount: 0,
        failedCount: 0,
        ackedCount: 0,
      };

      for (const context of contexts) {
        const result = await options.db.query<MutationDiagnostics>(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS "pendingCount",
            COUNT(*) FILTER (WHERE status = 'sending')::int AS "sendingCount",
            COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedCount",
            COUNT(*) FILTER (WHERE status = 'acked')::int AS "ackedCount"
          FROM ${context.journalTable}
        `);

        const row = result.rows[0];
        if (!row) {
          continue;
        }

        totals.pendingCount += row.pendingCount;
        totals.sendingCount += row.sendingCount;
        totals.failedCount += row.failedCount;
        totals.ackedCount += row.ackedCount;
      }

      return totals;
    },
    readMutationDetails: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      const rows: MutationDetail[] = [];

      for (const context of contexts) {
        const result = await options.db.query<MutationDetailRow>(`
          SELECT
            mutation_id AS "mutationId",
            entity_key_json AS "entityKeyJson",
            mutation_seq AS "mutationSeq",
            mutation_kind AS "mutationKind",
            status,
            attempt_count AS "attemptCount",
            last_http_status AS "lastHttpStatus",
            last_error AS "lastError",
            conflict_reason AS "conflictReason",
            next_retry_at_us::text AS "nextRetryAtUs",
            server_updated_at_us::text AS "serverUpdatedAtUs",
            updated_at_us::text AS "updatedAtUs"
          FROM ${context.journalTable}
          ORDER BY updated_at_us DESC, mutation_seq DESC
        `);

        rows.push(
          ...result.rows.map((row) => ({
            tableName: context.key,
            entityKey: JSON.parse(row.entityKeyJson) as Record<string, string>,
            mutationId: row.mutationId,
            mutationSeq: row.mutationSeq,
            mutationKind: row.mutationKind,
            status: row.status,
            attemptCount: row.attemptCount,
            lastHttpStatus: row.lastHttpStatus,
            lastError: row.lastError,
            conflictReason: row.conflictReason,
            nextRetryAtUs: row.nextRetryAtUs,
            serverUpdatedAtUs: row.serverUpdatedAtUs,
            updatedAtUs: row.updatedAtUs,
          })),
        );
      }

      return rows.sort((left, right) => Number(right.updatedAtUs) - Number(left.updatedAtUs));
    },
    createOptimisticRecord: (table, input) => {
      const context = getTableContext(table);
      return createOptimisticRecordFromContext(context, input);
    },
  };
}

interface MutationRow extends Record<string, unknown> {
  mutationId: string;
  entityKeyJson: string;
  mutationSeq: number;
  mutationKind: MutationKind;
  status: MutationStatus;
  payloadJson: string;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
}

interface MutationDetailRow extends Record<string, unknown> {
  mutationId: string;
  entityKeyJson: string;
  mutationSeq: number;
  mutationKind: MutationKind;
  status: MutationStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
  updatedAtUs: string;
}

interface CurrentRecordStateRow extends Record<string, unknown> {
  overlayKind: string;
  localUpdatedAtUs: string;
  latestMutationSeq: number | null;
  latestMutationKind: MutationKind | null;
  latestMutationStatus: MutationStatus | null;
}

interface BatchLatestMutationStateRow extends Record<string, unknown> {
  entityKeyJson: string;
  latestMutationSeq: number | null;
  latestMutationKind: MutationKind | null;
  latestMutationStatus: MutationStatus | null;
}

interface BatchCurrentRecordStateRow extends Record<string, unknown> {
  entityKeyJson: string;
  overlayKind: string;
  localUpdatedAtUs: string;
}

interface BatchEntityRef {
  entityKey: Record<string, string>;
  entityKeyJson: string;
}

interface PlannedMutationInsert {
  mutationId: string;
  entityKey: Record<string, string>;
  entityKeyJson: string;
  mutationKind: MutationKind;
  payloadJson: string;
  nowUs: string;
}

interface PlannedOverlayUpsert {
  entityKey: Record<string, string>;
  record: Record<string, unknown>;
  overlayKind: string;
  localUpdatedAtUs: string;
}

interface BatchEntityState {
  entityKey: Record<string, string>;
  entityKeyJson: string;
  record: Record<string, unknown> | null;
  overlayKind: string | null;
  localUpdatedAtUs: string | null;
  latestMutationSeq: number | null;
  latestMutationKind: MutationKind | null;
  latestMutationStatus: MutationStatus | null;
}

type NormalizedBatchItem =
  | {
      context: TableContext;
      kind: "create";
      entityKey: Record<string, string>;
      entityKeyJson: string;
      optimisticRecord: Record<string, unknown>;
      input: unknown;
      mutationId: string;
      nowUs: string;
      order: number;
    }
  | {
      context: TableContext;
      kind: "update";
      entityKey: Record<string, string>;
      entityKeyJson: string;
      patch: Record<string, unknown>;
      mutationId: string;
      nowUs: string;
      order: number;
    }
  | {
      context: TableContext;
      kind: "delete";
      entityKey: Record<string, string>;
      entityKeyJson: string;
      mutationId: string;
      nowUs: string;
      order: number;
    };

function buildTableContexts<TRegistry extends SyncTableRegistry>(registry: TRegistry, requireRouteBasePath: boolean) {
  const localSchema = getSyncRegistrySchema(registry);

  return Object.fromEntries(
    Object.entries(registry)
      .filter(([, entry]) => entry.mode !== "readonly")
      .map(([key, entry]) => [key, buildTableContext(key, entry, localSchema, requireRouteBasePath)]),
  ) as Partial<Record<SyncTableName<TRegistry>, TableContext>>;
}

function buildTableContext(
  key: string,
  entry: SyncTableEntry<AnyPgTable>,
  localSchema: string,
  requireRouteBasePath: boolean,
): TableContext {
  if (!entry.clientProjection?.overlayTable || !entry.clientProjection.journalTable) {
    throw new Error(`overlay and journal tables are required for writable table ${key}`);
  }

  if (requireRouteBasePath && !entry.routes?.basePath) {
    throw new Error(`routes.basePath is required for writable table ${key}`);
  }

  const columns = getProjectedTableColumns(entry).map(({ propertyKey, column }) => ({
    propertyKey,
    column,
  }));

  const pkPropertyKeys = entry.primaryKey.columns.map((columnName) => {
    const column = columns.find((candidate) => candidate.column.name === columnName);

    if (!column) {
      throw new Error(`Primary key column ${columnName} was not found on table ${key}`);
    }

    return column.propertyKey;
  });

  return {
    key,
    entry,
    readModel: qualifyLocalIdentifier(localSchema, entry.clientProjection.readModel),
    syncedTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.syncedTable),
    overlayTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.overlayTable),
    journalTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.journalTable),
    journalSequence: qualifyLocalIdentifier(localSchema, buildJournalSequenceName(entry.clientProjection.journalTable)),
    ...(entry.routes?.basePath ? { routeBasePath: entry.routes.basePath } : {}),
    pkColumnNames: [...entry.primaryKey.columns],
    pkPropertyKeys,
    recordIncludesOverlayState: recordSchemaIncludesOverlayState(entry.schemas?.recordSchema),
    columns,
  };
}

function filterContexts<TRegistry extends SyncTableRegistry>(
  contexts: Partial<Record<SyncTableName<TRegistry>, TableContext>>,
  table?: SyncTableName<TRegistry>,
) {
  if (table) {
    const context = contexts[table];
    return context ? [context] : [];
  }

  return Object.values(contexts).filter((context): context is TableContext => context !== undefined);
}

function createOptimisticRecordFromContext<TCreate, TRecord>(context: TableContext, input: TCreate): TRecord {
  const parsed = parseCreateInput(context, input);
  const record = {
    ...(isRecord(parsed) ? parsed : {}),
  };
  const nowUs = nowMicroseconds();

  if (hasProperty(context, "createdAtUs") && record.createdAtUs === undefined) {
    record.createdAtUs = nowUs;
  }

  if (hasProperty(context, "updatedAtUs") && record.updatedAtUs === undefined) {
    record.updatedAtUs = nowUs;
  }

  return buildOptimisticRecord(context, record, {
    overlayKind: "pending_create",
    localUpdatedAtUs: nowUs,
  }) as TRecord;
}

function parseCreateInput(context: TableContext, input: unknown) {
  return context.entry.schemas?.createSchema ? context.entry.schemas.createSchema.parse(input) : input;
}

function parseUpdateInput(context: TableContext, input: unknown) {
  return context.entry.schemas?.updateSchema ? context.entry.schemas.updateSchema.parse(input) : input;
}

function parseRecord(context: TableContext, input: unknown) {
  return context.entry.schemas?.recordSchema ? context.entry.schemas.recordSchema.parse(input) : input;
}

function buildOptimisticRecord(
  context: TableContext,
  record: Record<string, unknown>,
  options: {
    overlayKind: string;
    localUpdatedAtUs: string;
  },
) {
  if (!context.recordIncludesOverlayState) {
    return parseRecord(context, record);
  }

  return parseRecord(context, {
    ...record,
    overlayKind: options.overlayKind,
    localUpdatedAtUs: options.localUpdatedAtUs,
  });
}

function recordSchemaIncludesOverlayState(schema: unknown) {
  if (!(schema instanceof ZodObject)) {
    return false;
  }

  const shape = schema.shape;
  return "overlayKind" in shape && "localUpdatedAtUs" in shape;
}

function buildEntityKeyFromRecord(context: TableContext, record: unknown) {
  const recordObject = ensureRecord(record);
  return normalizeEntityKey(
    context,
    context.entry.adapters?.toEntityKey
      ? context.entry.adapters.toEntityKey(recordObject)
      : Object.fromEntries(
          context.pkPropertyKeys.map((propertyKey) => [propertyKey, String(recordObject[propertyKey])]),
        ),
  );
}

function normalizeEntityKey(context: TableContext, input: Record<string, string>) {
  return Object.fromEntries(
    context.pkPropertyKeys.map((propertyKey) => {
      const value = input[propertyKey];

      if (value === undefined) {
        throw new Error(`Missing entity key property ${propertyKey} for table ${context.key}`);
      }

      return [propertyKey, String(value)];
    }),
  );
}

function serializeEntityKey(entityKey: Record<string, string>) {
  return JSON.stringify(entityKey);
}

function dedupeBatchEntities(items: ReadonlyArray<NormalizedBatchItem>): BatchEntityRef[] {
  const entities = new Map<string, BatchEntityRef>();

  for (const item of items) {
    if (!entities.has(item.entityKeyJson)) {
      entities.set(item.entityKeyJson, {
        entityKey: item.entityKey,
        entityKeyJson: item.entityKeyJson,
      });
    }
  }

  return [...entities.values()];
}

async function readLatestMutationStates(
  db: MutationDb,
  context: TableContext,
  entities: ReadonlyArray<BatchEntityRef>,
) {
  if (entities.length === 0) {
    return new Map<string, BatchLatestMutationStateRow>();
  }

  const { cteSql, params } = buildBatchEntityInputCte(context, entities);
  const result = await db.query<BatchLatestMutationStateRow>(
    `
      WITH ${cteSql},
      latest_mutations AS (
        SELECT DISTINCT ON (journal.entity_key_json)
          journal.entity_key_json,
          journal.mutation_seq,
          journal.mutation_kind,
          journal.status
        FROM ${context.journalTable} AS journal
        JOIN input_entities AS input
          ON input.entity_key_json = journal.entity_key_json
        ORDER BY journal.entity_key_json, journal.mutation_seq DESC
      )
      SELECT
        input.entity_key_json AS "entityKeyJson",
        latest.mutation_seq AS "latestMutationSeq",
        latest.mutation_kind AS "latestMutationKind",
        latest.status AS "latestMutationStatus"
      FROM input_entities AS input
      LEFT JOIN latest_mutations AS latest
        ON latest.entity_key_json = input.entity_key_json
    `,
    params,
  );

  return new Map(result.rows.map((row) => [row.entityKeyJson, row]));
}

async function readCurrentRecordStates(db: MutationDb, context: TableContext, entities: ReadonlyArray<BatchEntityRef>) {
  if (entities.length === 0) {
    return new Map<string, BatchCurrentRecordStateRow>();
  }

  const { cteSql, params } = buildBatchEntityInputCte(context, entities);
  const overlaySelectColumns = buildContextSelectColumns(context, "overlay");
  const syncedSelectColumns = buildContextSelectColumns(context, "synced");
  const inputOverlayJoin = buildBatchEntityJoinClause(context, "overlay", "input");
  const inputSyncedJoin = buildBatchEntityJoinClause(context, "synced", "input");
  const syncedLocalUpdatedSql = hasProperty(context, "updatedAtUs")
    ? 'synced.updated_at_us::text AS "localUpdatedAtUs"'
    : `'0' AS "localUpdatedAtUs"`;

  const result = await db.query<BatchCurrentRecordStateRow>(
    `
      WITH ${cteSql},
      overlay_rows AS (
        SELECT
          input.entity_key_json AS "entityKeyJson",
          ${overlaySelectColumns.join(",\n          ")},
          overlay.overlay_kind AS "overlayKind",
          overlay.local_updated_at_us::text AS "localUpdatedAtUs"
        FROM input_entities AS input
        JOIN ${context.overlayTable} AS overlay
          ON ${inputOverlayJoin}
      ),
      synced_rows AS (
        SELECT
          input.entity_key_json AS "entityKeyJson",
          ${syncedSelectColumns.join(",\n          ")},
          'synced' AS "overlayKind",
          ${syncedLocalUpdatedSql}
        FROM input_entities AS input
        JOIN ${context.syncedTable} AS synced
          ON ${inputSyncedJoin}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${context.overlayTable} AS overlay
          WHERE ${inputOverlayJoin}
        )
      )
      SELECT *
      FROM overlay_rows
      UNION ALL
      SELECT *
      FROM synced_rows
    `,
    params,
  );

  return new Map(result.rows.map((row) => [row.entityKeyJson, row]));
}

async function insertMutationsBulk(db: MutationDb, context: TableContext, rows: ReadonlyArray<PlannedMutationInsert>) {
  if (rows.length === 0) {
    return;
  }

  const insertColumnNames = [
    "mutation_id",
    ...context.pkColumnNames,
    "entity_key_json",
    "mutation_seq",
    "mutation_kind",
    "status",
    "payload_json",
    "enqueued_at_us",
    "next_retry_at_us",
    "updated_at_us",
  ];
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    const values = [
      row.mutationId,
      ...context.pkPropertyKeys.map((propertyKey) => row.entityKey[propertyKey]),
      row.entityKeyJson,
      row.mutationKind,
      "pending",
      row.payloadJson,
      row.nowUs,
      row.nowUs,
      row.nowUs,
    ];

    params.push(...values);

    const valuePlaceholders = [
      formatSqlValuePlaceholder(start + 1, "mutation_id"),
      ...context.pkColumnNames.map((columnName, index) => formatSqlValuePlaceholder(start + index + 2, columnName)),
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 2, "entity_key_json"),
      `nextval('${escapeSqlString(context.journalSequence)}')::integer`,
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 3, "mutation_kind"),
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 4, "status"),
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 5, "payload_json"),
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 6, "enqueued_at_us"),
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 7, "next_retry_at_us"),
      formatSqlValuePlaceholder(start + context.pkColumnNames.length + 8, "updated_at_us"),
    ];

    return `(${valuePlaceholders.join(", ")})`;
  });

  await db.query(
    `
      INSERT INTO ${context.journalTable} (
        ${insertColumnNames.join(", ")}
      )
      VALUES ${tuples.join(",\n        ")}
    `,
    params,
  );
}

async function upsertOverlayRecordsBulk(
  db: MutationDb,
  context: TableContext,
  rows: ReadonlyArray<PlannedOverlayUpsert>,
) {
  if (rows.length === 0) {
    return;
  }

  const overlayColumnNames = context.columns.map(({ column }) => column.name);
  const insertColumns = [...overlayColumnNames, "overlay_kind", "local_updated_at_us"];
  const updateColumns = [
    ...overlayColumnNames.map((columnName) => `${columnName} = EXCLUDED.${columnName}`),
    "overlay_kind = EXCLUDED.overlay_kind",
    "local_updated_at_us = EXCLUDED.local_updated_at_us",
  ];
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    const values = [
      ...context.columns.map(({ propertyKey }) => row.record[propertyKey] ?? null),
      row.overlayKind,
      row.localUpdatedAtUs,
    ];

    params.push(...values);

    return `(${insertColumns
      .map((columnName, index) => formatSqlValuePlaceholder(start + index + 1, columnName))
      .join(", ")})`;
  });

  await db.query(
    `
      INSERT INTO ${context.overlayTable} (
        ${insertColumns.join(", ")}
      )
      VALUES ${tuples.join(",\n        ")}
      ON CONFLICT (${context.pkColumnNames.join(", ")})
      DO UPDATE SET
        ${updateColumns.join(",\n        ")}
    `,
    params,
  );
}

function buildBatchEntityInputCte(context: TableContext, entities: ReadonlyArray<BatchEntityRef>) {
  const columns = ["entity_key_json", ...context.pkColumnNames];
  const params: unknown[] = [];
  const tuples = entities.map((entity) => {
    const start = params.length;
    const values = [
      entity.entityKeyJson,
      ...context.pkPropertyKeys.map((propertyKey) => entity.entityKey[propertyKey]),
    ];

    params.push(...values);

    return `(${columns
      .map((columnName, index) => formatBatchEntityInputPlaceholder(context, start + index + 1, columnName))
      .join(", ")})`;
  });

  return {
    cteSql: `input_entities (${columns.join(", ")}) AS (VALUES ${tuples.join(", ")})`,
    params,
  };
}

function formatBatchEntityInputPlaceholder(context: TableContext, position: number, columnName: string) {
  if (columnName === "entity_key_json") {
    return `$${position}`;
  }

  const columnEntry = context.columns.find(({ column }) => column.name === columnName);

  if (!columnEntry) {
    return `$${position}`;
  }

  switch (columnEntry.column.columnType) {
    case "PgUUID":
      return `$${position}::uuid`;
    case "PgBigInt64":
    case "PgBigInt53":
      return `$${position}::bigint`;
    case "PgInteger":
    case "PgSerial":
    case "PgSmallInt":
      return `$${position}::int`;
    case "PgBoolean":
      return `$${position}::boolean`;
    case "PgTimestamp":
    case "PgTimestampString":
      return `$${position}::timestamp`;
    default:
      return `$${position}`;
  }
}

function buildContextSelectColumns(context: TableContext, tableAlias: string) {
  return context.columns.map(({ propertyKey, column }) => {
    const qualifiedColumn = `${tableAlias}.${column.name}`;

    if (column.columnType === "PgBigInt64" || column.columnType === "PgBigInt53") {
      return `${qualifiedColumn}::text AS "${propertyKey}"`;
    }

    return `${qualifiedColumn} AS "${propertyKey}"`;
  });
}

function buildBatchEntityJoinClause(context: TableContext, tableAlias: string, inputAlias: string) {
  return context.pkColumnNames
    .map((columnName) => `${tableAlias}.${columnName} = ${inputAlias}.${columnName}`)
    .join(" AND ");
}

// ---------------------------------------------------------------------------
// Batch flush — sends one send-eligible slice of pending mutations across all
// target tables in a single POST /api/mutations call. The public flush()
// wrapper loops until no more eligible rows remain.
// ---------------------------------------------------------------------------

interface PendingBatchRow extends MutationRow {
  tableKey: string;
  enqueuedAtUs: string;
}

interface PreparedBatchRow extends PendingBatchRow {
  context: TableContext;
  entityKey: Record<string, string>;
  envelopePayload: Record<string, unknown>;
  sqlTableName: string;
}

interface FlushBatchResult {
  processedCount: number;
  affectedContexts: TableContext[];
}

interface MutationStatusUpdate {
  mutationId: string;
  status: MutationStatus;
  attemptCount: number;
  updatedAtUs: string;
  sentAtUs?: string | null;
  replaceSentAtUs?: boolean;
  ackedAtUs?: string | null;
  replaceAckedAtUs?: boolean;
  serverUpdatedAtUs?: string | null;
  replaceServerUpdatedAtUs?: boolean;
  lastError?: string | null;
  nextRetryAtUs?: string | null;
  lastHttpStatus?: number | null;
  conflictReason?: string | null;
}

async function readPendingBatchRows(db: MutationDb, contexts: TableContext[], nowUs: string) {
  if (contexts.length === 0) {
    return [] as PendingBatchRow[];
  }

  const unionSql = contexts
    .map(
      (context) => `
        SELECT
          '${escapeSqlString(context.key)}' AS "tableKey",
          mutation_id AS "mutationId",
          entity_key_json AS "entityKeyJson",
          mutation_seq AS "mutationSeq",
          mutation_kind AS "mutationKind",
          status,
          payload_json AS "payloadJson",
          attempt_count AS "attemptCount",
          last_http_status AS "lastHttpStatus",
          last_error AS "lastError",
          conflict_reason AS "conflictReason",
          next_retry_at_us::text AS "nextRetryAtUs",
          server_updated_at_us::text AS "serverUpdatedAtUs",
          enqueued_at_us::text AS "enqueuedAtUs"
        FROM ${context.journalTable}
        WHERE status IN ('pending', 'failed')
          AND COALESCE(next_retry_at_us, 0) <= $1::bigint
          AND NOT EXISTS (
            SELECT 1
            FROM ${context.journalTable} AS earlier
            WHERE earlier.entity_key_json = ${context.journalTable}.entity_key_json
              AND earlier.mutation_seq < ${context.journalTable}.mutation_seq
              AND earlier.status IN ('pending', 'failed', 'sending')
          )
      `,
    )
    .join("\nUNION ALL\n");

  const result = await db.query<PendingBatchRow>(
    `
      SELECT *
      FROM (
        ${unionSql}
      ) AS pending
      ORDER BY pending."enqueuedAtUs"::bigint ASC, pending."mutationSeq" ASC
      LIMIT ${DEFAULT_FLUSH_BATCH_SIZE}
    `,
    [nowUs],
  );

  return result.rows;
}

async function flushBatch(
  db: MutationDb,
  tableContexts: Record<string, TableContext>,
  batchWriteUrl: string,
  tableFilter?: string,
  getAuthToken?: () => Promise<string | undefined>,
): Promise<FlushBatchResult> {
  const contexts = filterContexts(tableContexts, tableFilter);
  const nowUs = nowMicroseconds();

  // Collect send-eligible mutations across all target tables.
  const pendingRows = await readPendingBatchRows(db, contexts, nowUs);
  const pending: PreparedBatchRow[] = [];
  const pendingByTable = new Map<string, PreparedBatchRow[]>();

  for (const row of pendingRows) {
    const context = tableContexts[row.tableKey];

    if (!context) {
      continue;
    }

    const entityKey = JSON.parse(row.entityKeyJson) as Record<string, string>;
    const rawPayload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    const preparedRow: PreparedBatchRow = {
      ...row,
      context,
      entityKey,
      envelopePayload:
        row.mutationKind === "delete"
          ? entityKey
          : toSqlColumnPayload(
              context,
              stripManagedFields(
                context,
                (rawPayload.value ?? rawPayload.patch ?? rawPayload) as Record<string, unknown>,
                row.mutationKind as "create" | "update",
              ),
            ),
      sqlTableName: context.entry.shape?.tableName ?? context.key,
    };

    pending.push(preparedRow);

    const existingTableRows = pendingByTable.get(context.key);

    if (existingTableRows) {
      existingTableRows.push(preparedRow);
    } else {
      pendingByTable.set(context.key, [preparedRow]);
    }
  }

  if (pending.length === 0) {
    return {
      processedCount: 0,
      affectedContexts: [],
    };
  }

  // Mark all as sending.
  const sentAtUs = nowMicroseconds();

  for (const rows of pendingByTable.values()) {
    await applyMutationStatusUpdates(
      db,
      rows[0]!.context,
      rows.map((row) => ({
        mutationId: row.mutationId,
        status: "sending",
        attemptCount: row.attemptCount + 1,
        updatedAtUs: sentAtUs,
        sentAtUs,
        replaceSentAtUs: true,
        lastError: null,
        nextRetryAtUs: null,
        lastHttpStatus: null,
        conflictReason: null,
      })),
    );
  }

  const mutations = pending.map((row) => {
    return {
      tableName: row.sqlTableName,
      entityKey: row.entityKey,
      mutationId: row.mutationId,
      mutationSeq: row.mutationSeq,
      kind: row.mutationKind as "create" | "update" | "delete",
      payload: row.envelopePayload,
      clientTimestampUs: sentAtUs,
    };
  });

  let responseOk = false;
  let acksByMutationId: Map<string, BatchMutationAck["acks"][number]> = new Map();
  const batchMutationUrl = resolveBatchMutationUrl(batchWriteUrl);

  try {
    let response = await fetch(batchMutationUrl, {
      method: "POST",
      headers: buildRequestHeaders(await getAuthToken?.()),
      body: JSON.stringify({ mutations }),
    });

    if ([401, 403].includes(response.status) && getAuthToken) {
      response = await fetch(batchMutationUrl, {
        method: "POST",
        headers: buildRequestHeaders(await getAuthToken()),
        body: JSON.stringify({ mutations }),
      });
    }

    if (response.ok) {
      const responseJson = (await response.json()) as BatchMutationAck;
      responseOk = true;
      acksByMutationId = new Map(responseJson.acks.map((ack) => [ack.mutationId, ack]));
    } else {
      const text = await response.text();
      throw new MutationRequestError(
        text.length > 0 ? text : `Bulk write responded with ${response.status}`,
        response.status,
      );
    }
  } catch (error) {
    // All mutations in the batch fail together on a transport or server error.
    const failedAtUs = nowMicroseconds();

    for (const rows of pendingByTable.values()) {
      await applyMutationStatusUpdates(
        db,
        rows[0]!.context,
        rows.map((row) => {
          const attemptCount = row.attemptCount + 1;

          return {
            mutationId: row.mutationId,
            status: "failed",
            attemptCount,
            updatedAtUs: failedAtUs,
            lastError: error instanceof Error ? error.message : "Unknown batch write failure",
            nextRetryAtUs: computeNextRetryAtUs(failedAtUs, attemptCount),
            lastHttpStatus: error instanceof MutationRequestError ? error.status : null,
            conflictReason: null,
          };
        }),
      );
    }

    return {
      processedCount: pending.length,
      affectedContexts: [...new Set(pending.map((row) => row.context))],
    };
  }

  if (!responseOk) {
    return {
      processedCount: pending.length,
      affectedContexts: [...new Set(pending.map((row) => row.context))],
    };
  }

  // Apply per-mutation ack results.
  const ackedAtUs = nowMicroseconds();
  const failedAtUs = nowMicroseconds();

  for (const rows of pendingByTable.values()) {
    await applyMutationStatusUpdates(
      db,
      rows[0]!.context,
      rows.map((row) => {
        const ack = acksByMutationId.get(row.mutationId);

        if (!ack || ack.status !== "acked") {
          return {
            mutationId: row.mutationId,
            status: "failed",
            attemptCount: row.attemptCount + 1,
            updatedAtUs: failedAtUs,
            lastError: ack?.conflictReason ?? "Batch mutation not acknowledged",
            nextRetryAtUs: computeNextRetryAtUs(failedAtUs, row.attemptCount + 1),
            lastHttpStatus: ack?.httpStatus ?? null,
            conflictReason: ack?.conflictReason ?? null,
          };
        }

        if (row.mutationKind === "delete") {
          return {
            mutationId: row.mutationId,
            status: "acked",
            attemptCount: row.attemptCount + 1,
            updatedAtUs: ackedAtUs,
            ackedAtUs,
            replaceAckedAtUs: true,
            lastError: null,
            nextRetryAtUs: null,
            lastHttpStatus: 204,
            conflictReason: null,
          };
        }

        return {
          mutationId: row.mutationId,
          status: "acked",
          attemptCount: row.attemptCount + 1,
          updatedAtUs: ackedAtUs,
          ackedAtUs,
          replaceAckedAtUs: true,
          serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
          replaceServerUpdatedAtUs: true,
          lastError: null,
          nextRetryAtUs: null,
          lastHttpStatus: 200,
          conflictReason: null,
        };
      }),
    );
  }

  return {
    processedCount: pending.length,
    affectedContexts: [...new Set(pending.map((row) => row.context))],
  };
}

function resolveBatchMutationUrl(batchWriteUrl: string): string {
  const trimmed = batchWriteUrl.replace(/\/+$/, "");

  if (trimmed.endsWith("/mutations")) {
    return trimmed;
  }

  return `${trimmed}/mutations`;
}

function toSqlColumnPayload(context: TableContext, payload: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const { propertyKey, column } of context.columns) {
    const columnName = column.name;

    if (Object.prototype.hasOwnProperty.call(payload, columnName)) {
      normalized[columnName] = payload[columnName];
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(payload, propertyKey)) {
      normalized[columnName] = payload[propertyKey];
    }
  }

  return normalized;
}

function filterProjectedPayload(context: TableContext, payload: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};

  for (const { propertyKey, column } of context.columns) {
    if (Object.prototype.hasOwnProperty.call(payload, propertyKey)) {
      normalized[propertyKey] = payload[propertyKey];
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(payload, column.name)) {
      normalized[column.name] = payload[column.name];
    }
  }

  return normalized;
}

function stripManagedFields(
  context: TableContext,
  payload: Record<string, unknown>,
  operation: "create" | "update",
): Record<string, unknown> {
  const managedColumns = new Set<string>();

  for (const mf of context.entry.governance?.managedFields ?? []) {
    if (mf.applyOn.includes(operation)) {
      managedColumns.add(mf.column);
    }
  }

  if (managedColumns.size === 0) return payload;

  return Object.fromEntries(Object.entries(payload).filter(([key]) => !managedColumns.has(key)));
}

async function flushTable(
  db: MutationDb,
  context: TableContext,
  writeUrl: string,
  getAuthToken?: () => Promise<string | undefined>,
) {
  const result = await db.query<MutationRow>(
    `
      SELECT
        mutation_id AS "mutationId",
        entity_key_json AS "entityKeyJson",
        mutation_seq AS "mutationSeq",
        mutation_kind AS "mutationKind",
        status,
        payload_json AS "payloadJson",
        attempt_count AS "attemptCount",
        last_http_status AS "lastHttpStatus",
        last_error AS "lastError",
        conflict_reason AS "conflictReason",
        next_retry_at_us::text AS "nextRetryAtUs",
        server_updated_at_us::text AS "serverUpdatedAtUs"
      FROM ${context.journalTable}
      WHERE status IN ('pending', 'failed')
        AND COALESCE(next_retry_at_us, 0) <= $1::bigint
        AND NOT EXISTS (
          SELECT 1
          FROM ${context.journalTable} AS earlier
          WHERE earlier.entity_key_json = ${context.journalTable}.entity_key_json
            AND earlier.mutation_seq < ${context.journalTable}.mutation_seq
            AND earlier.status IN ('pending', 'failed', 'sending')
        )
      ORDER BY enqueued_at_us ASC, mutation_seq ASC
      LIMIT ${DEFAULT_FLUSH_BATCH_SIZE}
    `,
    [nowMicroseconds()],
  );

  if (result.rows.length === 0) {
    return 0;
  }

  for (const mutation of result.rows) {
    const sentAtUs = nowMicroseconds();
    await setMutationStatus(db, context, mutation.mutationId, "sending", {
      attemptCount: mutation.attemptCount + 1,
      sentAtUs,
      updatedAtUs: sentAtUs,
      lastError: null,
      nextRetryAtUs: null,
      lastHttpStatus: null,
      conflictReason: null,
    });

    try {
      const entityKey = JSON.parse(mutation.entityKeyJson) as Record<string, string>;
      const payload = JSON.parse(mutation.payloadJson) as Record<string, unknown>;
      let response = await sendMutationRequest(writeUrl, context, entityKey, payload, await getAuthToken?.());

      if ([401, 403].includes(response.status) && getAuthToken) {
        response = await sendMutationRequest(writeUrl, context, entityKey, payload, await getAuthToken());
      }

      const responseText = await response.text();
      const responseJson = responseText.length > 0 ? JSON.parse(responseText) : null;

      if (!response.ok) {
        const errorMessage =
          responseJson && typeof responseJson.message === "string"
            ? responseJson.message
            : `Write API responded with ${response.status}`;

        if (mutation.mutationKind === "delete" && response.status === 404) {
          await markDeleteAcknowledged(db, context, mutation.mutationId);
          continue;
        }

        throw new MutationRequestError(errorMessage, response.status);
      }

      const ackedAtUs = nowMicroseconds();

      if (mutation.mutationKind === "delete") {
        await markDeleteAcknowledged(db, context, mutation.mutationId);
      } else {
        const created = parseRecord(context, responseJson);
        const createdRecord = ensureRecord(created);
        const serverUpdatedAtUs = toOptionalString(createdRecord.updatedAtUs);

        await db.query(
          `
            UPDATE ${context.journalTable}
            SET
              status = 'acked',
              acked_at_us = $2::bigint,
              updated_at_us = $2::bigint,
              server_updated_at_us = $3::bigint,
              last_error = NULL,
              last_http_status = 200,
              conflict_reason = NULL,
              next_retry_at_us = NULL
            WHERE mutation_id = $1
          `,
          [mutation.mutationId, ackedAtUs, serverUpdatedAtUs],
        );

        if (!(await hasLaterMutations(db, context, mutation.entityKeyJson, mutation.mutationSeq))) {
          await updateOverlayTimestamps(db, context, entityKey, createdRecord, ackedAtUs);
        }
      }
    } catch (error) {
      const failedAtUs = nowMicroseconds();
      const attemptCount = mutation.attemptCount + 1;
      const nextRetryAtUs = computeNextRetryAtUs(failedAtUs, attemptCount);
      const lastHttpStatus = error instanceof MutationRequestError ? error.status : null;
      const conflictReason =
        lastHttpStatus === 404 || lastHttpStatus === 409
          ? error instanceof Error
            ? error.message
            : "Server conflict"
          : null;

      await setMutationStatus(db, context, mutation.mutationId, "failed", {
        attemptCount,
        updatedAtUs: failedAtUs,
        lastError: error instanceof Error ? error.message : "Unknown write failure",
        nextRetryAtUs,
        lastHttpStatus,
        conflictReason,
      });
    }
  }

  await reconcileTable(db, context);
  return result.rows.length;
}

async function reconcileTable(db: MutationDb, context: TableContext) {
  await clearAcknowledgedDeletes(db, context);

  if (!context.columns.some(({ column }) => column.name === "updated_at_us")) {
    return;
  }

  await db.exec("BEGIN");

  try {
    await db.query(`
      WITH deleted AS (
        DELETE FROM ${context.journalTable} AS journal
        USING ${context.syncedTable} AS synced
        WHERE journal.status = 'acked'
          AND journal.mutation_kind <> 'delete'
          AND journal.server_updated_at_us IS NOT NULL
          AND ${buildColumnEquality(context.pkColumnNames, "journal", "synced")}
          AND synced.updated_at_us >= journal.server_updated_at_us
        RETURNING journal.mutation_id, journal.entity_key_json, ${context.pkColumnNames.map((columnName) => `journal.${columnName}`).join(", ")}
      ),
      clearable_entities AS (
        SELECT DISTINCT deleted.entity_key_json, ${context.pkColumnNames.map((columnName) => `deleted.${columnName}`).join(", ")}
        FROM deleted
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${context.journalTable} AS remaining
          WHERE remaining.entity_key_json = deleted.entity_key_json
            AND remaining.mutation_id NOT IN (
              SELECT deleted_for_entity.mutation_id
              FROM deleted AS deleted_for_entity
              WHERE deleted_for_entity.entity_key_json = deleted.entity_key_json
            )
        )
      )
      DELETE FROM ${context.overlayTable} AS overlay
      USING clearable_entities
      WHERE ${buildColumnEquality(context.pkColumnNames, "overlay", "clearable_entities")}
    `);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function clearAcknowledgedDeletes(db: MutationDb, context: TableContext) {
  await db.exec("BEGIN");

  try {
    await db.query(`
      WITH clearable_entities AS (
        SELECT DISTINCT journal.entity_key_json, ${context.pkColumnNames.map((columnName) => `journal.${columnName}`).join(", ")}
        FROM ${context.journalTable} AS journal
        LEFT JOIN ${context.syncedTable} AS synced
          ON ${buildColumnEquality(context.pkColumnNames, "journal", "synced")}
        WHERE journal.status = 'acked'
          AND journal.mutation_kind = 'delete'
          AND synced.${context.pkColumnNames[0]!} IS NULL
      ),
      deleted_overlay AS (
        DELETE FROM ${context.overlayTable} AS overlay
        USING clearable_entities
        WHERE ${buildColumnEquality(context.pkColumnNames, "overlay", "clearable_entities")}
      )
      DELETE FROM ${context.journalTable} AS journal
      USING clearable_entities
      WHERE journal.entity_key_json = clearable_entities.entity_key_json
    `);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function sendMutationRequest(
  writeUrl: string,
  context: TableContext,
  entityKey: Record<string, string>,
  payload: Record<string, unknown>,
  bearerToken?: string,
) {
  if (!context.routeBasePath) {
    throw new Error(`routes.basePath is required for direct mutation requests on table ${context.key}`);
  }

  switch (payload.kind) {
    case "create":
      return fetch(`${writeUrl}${context.routeBasePath}`, {
        method: "POST",
        headers: buildRequestHeaders(bearerToken),
        body: JSON.stringify(filterProjectedPayload(context, ensureRecord(payload.value))),
      });
    case "update":
      return fetch(
        `${writeUrl}${context.routeBasePath}/${encodeURIComponent(getSingleEntityKeyValue(context, entityKey))}`,
        {
          method: "PATCH",
          headers: buildRequestHeaders(bearerToken),
          body: JSON.stringify(filterProjectedPayload(context, ensureRecord(payload.patch))),
        },
      );
    case "delete":
      return fetch(
        `${writeUrl}${context.routeBasePath}/${encodeURIComponent(getSingleEntityKeyValue(context, entityKey))}`,
        {
          method: "DELETE",
          headers: buildRequestHeaders(bearerToken),
        },
      );
    default:
      throw new Error(`Unknown mutation kind for table ${context.key}`);
  }
}

function buildRequestHeaders(bearerToken?: string): Record<string, string> {
  if (!bearerToken) {
    return {
      "Content-Type": "application/json",
    };
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearerToken}`,
  };
}

function getSingleEntityKeyValue(context: TableContext, entityKey: Record<string, string>) {
  if (context.pkPropertyKeys.length !== 1) {
    throw new Error(`Only single-column primary keys are supported for routes on table ${context.key}`);
  }

  return entityKey[context.pkPropertyKeys[0]!]!;
}

async function setMutationStatus(
  db: MutationDb,
  context: TableContext,
  mutationId: string,
  status: MutationStatus,
  options: {
    attemptCount: number;
    updatedAtUs: string;
    sentAtUs?: string | null;
    nextRetryAtUs?: string | null;
    lastError?: string | null;
    lastHttpStatus?: number | null;
    conflictReason?: string | null;
  },
) {
  await db.query(
    `
      UPDATE ${context.journalTable}
      SET
        status = $2,
        attempt_count = $3,
        sent_at_us = COALESCE($4::bigint, sent_at_us),
        updated_at_us = $5::bigint,
        last_error = $6,
        next_retry_at_us = $7::bigint,
        last_http_status = $8,
        conflict_reason = $9
      WHERE mutation_id = $1
    `,
    [
      mutationId,
      status,
      options.attemptCount,
      options.sentAtUs ?? null,
      options.updatedAtUs,
      options.lastError ?? null,
      options.nextRetryAtUs ?? null,
      options.lastHttpStatus ?? null,
      options.conflictReason ?? null,
    ],
  );
}

async function applyMutationStatusUpdates(db: MutationDb, context: TableContext, updates: MutationStatusUpdate[]) {
  if (updates.length === 0) {
    return;
  }

  const columns = [
    "mutation_id",
    "status",
    "attempt_count",
    "updated_at_us",
    "sent_at_us",
    "replace_sent_at_us",
    "acked_at_us",
    "replace_acked_at_us",
    "server_updated_at_us",
    "replace_server_updated_at_us",
    "last_error",
    "next_retry_at_us",
    "last_http_status",
    "conflict_reason",
  ] as const;
  const params: unknown[] = [];
  const tuples = updates.map((update) => {
    const start = params.length;

    params.push(
      update.mutationId,
      update.status,
      update.attemptCount,
      update.updatedAtUs,
      update.sentAtUs ?? null,
      update.replaceSentAtUs ?? false,
      update.ackedAtUs ?? null,
      update.replaceAckedAtUs ?? false,
      update.serverUpdatedAtUs ?? null,
      update.replaceServerUpdatedAtUs ?? false,
      update.lastError ?? null,
      update.nextRetryAtUs ?? null,
      update.lastHttpStatus ?? null,
      update.conflictReason ?? null,
    );

    return `(${columns
      .map((columnName, index) => {
        const position = start + index + 1;

        if (
          columnName === "updated_at_us" ||
          columnName === "sent_at_us" ||
          columnName === "acked_at_us" ||
          columnName === "server_updated_at_us" ||
          columnName === "next_retry_at_us"
        ) {
          return `$${position}::bigint`;
        }

        if (columnName === "attempt_count" || columnName === "last_http_status") {
          return `$${position}::int`;
        }

        if (
          columnName === "replace_sent_at_us" ||
          columnName === "replace_acked_at_us" ||
          columnName === "replace_server_updated_at_us"
        ) {
          return `$${position}::boolean`;
        }

        return `$${position}`;
      })
      .join(", ")})`;
  });

  await db.query(
    `
      UPDATE ${context.journalTable} AS journal
      SET
        status = updates.status,
        attempt_count = updates.attempt_count,
        updated_at_us = updates.updated_at_us::bigint,
        sent_at_us = CASE
          WHEN updates.replace_sent_at_us THEN updates.sent_at_us::bigint
          ELSE journal.sent_at_us
        END,
        acked_at_us = CASE
          WHEN updates.replace_acked_at_us THEN updates.acked_at_us::bigint
          ELSE journal.acked_at_us
        END,
        server_updated_at_us = CASE
          WHEN updates.replace_server_updated_at_us THEN updates.server_updated_at_us::bigint
          ELSE journal.server_updated_at_us
        END,
        last_error = updates.last_error,
        next_retry_at_us = updates.next_retry_at_us::bigint,
        last_http_status = updates.last_http_status,
        conflict_reason = updates.conflict_reason
      FROM (
        VALUES ${tuples.join(",\n          ")}
      ) AS updates (
        mutation_id,
        status,
        attempt_count,
        updated_at_us,
        sent_at_us,
        replace_sent_at_us,
        acked_at_us,
        replace_acked_at_us,
        server_updated_at_us,
        replace_server_updated_at_us,
        last_error,
        next_retry_at_us,
        last_http_status,
        conflict_reason
      )
      WHERE journal.mutation_id = updates.mutation_id::uuid
    `,
    params,
  );
}

async function markDeleteAcknowledged(db: MutationDb, context: TableContext, mutationId: string) {
  const ackedAtUs = nowMicroseconds();

  await db.query(
    `
      UPDATE ${context.journalTable}
      SET
        status = 'acked',
        acked_at_us = $2::bigint,
        updated_at_us = $2::bigint,
        last_error = NULL,
        last_http_status = 204,
        conflict_reason = NULL,
        next_retry_at_us = NULL
      WHERE mutation_id = $1
    `,
    [mutationId, ackedAtUs],
  );
}

async function hasLaterMutations(db: MutationDb, context: TableContext, entityKeyJson: string, mutationSeq: number) {
  const result = await db.query<{ count: number }>(
    `
      SELECT COUNT(*)::int AS count
      FROM ${context.journalTable}
      WHERE entity_key_json = $1
        AND mutation_seq > $2
    `,
    [entityKeyJson, mutationSeq],
  );

  return (result.rows[0]?.count ?? 0) > 0;
}

async function updateOverlayTimestamps(
  db: MutationDb,
  context: TableContext,
  entityKey: Record<string, string>,
  record: Record<string, unknown>,
  localUpdatedAtUs: string,
) {
  if (!hasProperty(context, "createdAtUs") || !hasProperty(context, "updatedAtUs")) {
    return;
  }

  await db.query(
    `
      UPDATE ${context.overlayTable}
      SET
        created_at_us = $${context.pkPropertyKeys.length + 1}::bigint,
        updated_at_us = $${context.pkPropertyKeys.length + 2}::bigint,
        local_updated_at_us = $${context.pkPropertyKeys.length + 3}::bigint
      WHERE ${buildWhereClause(context)}
    `,
    [...buildWhereParams(context, entityKey), String(record.createdAtUs), String(record.updatedAtUs), localUpdatedAtUs],
  );
}

function buildWhereClause(context: TableContext) {
  return context.pkColumnNames.map((columnName, index) => `${columnName} = $${index + 1}`).join(" AND ");
}

function buildColumnEquality(columnNames: string[], leftAlias: string, rightAlias: string) {
  return columnNames.map((columnName) => `${leftAlias}.${columnName} = ${rightAlias}.${columnName}`).join(" AND ");
}

function qualifyLocalIdentifier(schemaName: string, tableName: string) {
  if (schemaName === "public") {
    return tableName;
  }

  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildJournalSequenceName(journalTable: string) {
  return `${journalTable}_mutation_seq`;
}

function escapeSqlString(value: string) {
  return value.replace(/'/g, "''");
}

function buildWhereParams(context: TableContext, entityKey: Record<string, string>) {
  return context.pkPropertyKeys.map((propertyKey) => entityKey[propertyKey]);
}

function formatSqlValuePlaceholder(position: number, columnName: string) {
  return /_at_us$/.test(columnName) ? `$${position}::bigint` : `$${position}`;
}

function hasProperty(context: TableContext, propertyKey: string) {
  return context.columns.some((column) => column.propertyKey === propertyKey);
}

function ensureRecord(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Mutation runtime expected a record payload");
  }

  return value;
}

function extractRecordFromState(context: TableContext, state: CurrentRecordStateRow | BatchCurrentRecordStateRow) {
  return Object.fromEntries(context.columns.map(({ propertyKey }) => [propertyKey, state[propertyKey] ?? null]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toOptionalString(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return JSON.stringify(value);
  }
}

class MutationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MutationRequestError";
  }
}
