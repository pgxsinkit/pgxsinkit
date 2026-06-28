import { is, SQL } from "drizzle-orm";
import { getTableConfig, getViewConfig, type AnyPgTable } from "drizzle-orm/pg-core";

/**
 * Strip the two internal overlay columns that appear on _read_model views
 * (`overlay_kind`, `local_updated_at_us`) from any user-supplied input or
 * patch object before it is serialised into a mutation payload.  Callers
 * that spread a view row directly into a create/update call would otherwise
 * hit `TypeError: Do not know how to serialize a BigInt` because
 * `local_updated_at_us` is stored as a native JS `bigint`.
 */
function stripReadModelOverlayFields<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (!("overlay_kind" in obj) && !("local_updated_at_us" in obj)) return value;
  const { overlay_kind: _ok, local_updated_at_us: _lu, ...rest } = obj;
  return rest as T;
}

/**
 * JSON replacer that serialises `bigint` values as strings. PostgreSQL
 * accepts string literals for BIGINT columns, and JSON has no native bigint
 * type, so this is the safest cross-boundary representation.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? String(value) : value;
}

function jsonStringifyPayload(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

import type {
  BatchMutationAck,
  MutationAck,
  MutationDiagnostics,
  MutationRejection,
  SyncTableCreateInput,
  SyncTableEntry,
  SyncTableName,
  SyncTableRecord,
  SyncTableRegistry,
  SyncTableUpdateInput,
  WriteMode,
} from "@pgxsinkit/contracts";
import {
  batchMutationErrorSchema,
  buildOverlayResolutionBarrier,
  escapeSqlLiteral as escapeSqlString,
  fingerprintRegistry,
  getProjectedColumns as getProjectedTableColumns,
  getSyncRegistrySchema,
  maybeQuoteIdentifier,
  quoteIdentifier,
  resolveServerVersionColumnName,
} from "@pgxsinkit/contracts";

import { syncDebug } from "./debug";
import {
  assertValidMutationTransition,
  classifyFailureStatus,
  DEFAULT_MAX_MUTATION_ATTEMPTS,
  type MutationStatus,
} from "./mutation-state";

export type { MutationStatus } from "./mutation-state";
export type MutationKind = "create" | "update" | "delete";

/**
 * The dynamic write-unit tag (ADR-0022 §2) a `transaction({ mode })` block stamps onto the mutations
 * authored within it: a shared `id` grouping the co-committed mutations, and the unit's `mode`. Persisted
 * on each journal row (`write_unit` / `write_mode`); absent for the default path, where the flusher derives
 * mode + unit from the table's static consistency group.
 */
export interface WriteUnit {
  id: string;
  mode: WriteMode;
}

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
  /** Registry fingerprint (ADR-0004) the mutation was authored under, or null if unstamped. */
  registryVersion: string | null;
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
  getAuthToken?: () => Promise<string | undefined>;
  /**
   * Registry fingerprint (ADR-0004) stamped onto each enqueued mutation as its
   * `registry_version`, so a version-boundary crossing is known before sending (ADR-0006).
   */
  registryVersion?: string;
  /**
   * Hard cap on send attempts before a still-failing mutation is quarantined
   * (ADR-0005 congestion policy). Defaults to {@link DEFAULT_MAX_MUTATION_ATTEMPTS}.
   */
  maxMutationAttempts?: number;
  /**
   * Max mutations drained per flush HTTP request; a flush loops slices until the journal is empty.
   * Defaults to {@link DEFAULT_FLUSH_BATCH_SIZE}. Primarily a test seam (a small value exercises the
   * multi-slice drain path without enqueueing hundreds of mutations).
   */
  flushBatchSize?: number;
  /**
   * Invoked after a flush whenever mutations transition to `quarantined` (terminal,
   * permanently rejected). Receives the newly-quarantined details so the app can surface
   * them. The library never silently drops these (ADR-0006 decision 4).
   */
  onQuarantine?: (quarantined: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked after a flush whenever mutations transition to `conflicted` — a stale write the
   * server declined under the `reject-if-stale` Conflict policy (ADR-0015). Distinct from
   * `onQuarantine` (structural rejection): the optimistic Overlay is KEPT, so the app surfaces a
   * resolution/diff UI and resolves each as a new write (or `discardConflict`s it). Never silent.
   */
  onConflict?: (conflicted: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked after an authoritative (pessimistic) flush whenever a write-unit was `rejected` (ADR-0022) —
   * a business decline the client could not evaluate locally (capacity/quota/uniqueness). The inverse of
   * `onConflict`: the optimistic Overlay was **auto-discarded** for every member of the unit, so the app
   * surfaces the typed reason (e.g. "full") rather than a resolve/diff UI. Never silent.
   */
  onReject?: (rejected: MutationDetail[]) => void | Promise<void>;
}

interface TableContext {
  key: string;
  entry: SyncTableEntry<AnyPgTable>;
  readModel: string;
  syncedTable: string;
  overlayTable: string;
  journalTable: string;
  journalSequence: string;
  pkColumnNames: string[];
  pkPropertyKeys: string[];
  /**
   * The Server version (ADR-0010) column name (e.g. `updated_at_us`) and its drizzle property key,
   * resolved from the table's managed fields. Used to capture the Base server version (ADR-0015) at
   * enqueue — the value the user's edit was authored against. `null` would mean no Server version,
   * which registry validation already forbids for a writable table.
   */
  serverVersionColumnName: string | null;
  serverVersionPropertyKey: string | null;
  /**
   * Property keys of the table's `nowMicroseconds` managed fields (governance), resolved generically
   * rather than by the `createdAtUs`/`updatedAtUs` naming convention. The optimistic overlay stamps
   * these client-side so a custom-named managed timestamp (e.g. a Server version not called
   * `updated_at_us`) is materialised correctly — closing the split interpreter between the generic
   * server applier (which reads governance) and the local path (ADR-0004).
   *
   * - `managedNowMicrosecondsPropertyKeys` — every `nowMicroseconds` field, stamped on create.
   * - `updateManagedNowMicrosecondsPropertyKeys` — those that apply on update, re-stamped each update.
   *
   * These augment, and never remove, the convention fill in `createOptimisticRecordFromContext`,
   * which remains the safety net for a `created_at_us`/`updated_at_us` column that carries a SQL
   * `DEFAULT` (unmaterialisable client-side) yet is not declared a managed field.
   */
  managedNowMicrosecondsPropertyKeys: string[];
  updateManagedNowMicrosecondsPropertyKeys: string[];
  /**
   * Property keys of the table's `authUid` managed fields that apply on create (governance). The
   * server stamps these from `auth.uid()` (the JWT `sub`), so they are stripped from the create input
   * type and never sent in the flushed payload. But the optimistic overlay still needs a value — an
   * `authUid` column is typically `NOT NULL` (an owner/author/created_by), so an unstamped overlay
   * INSERT violates the constraint. The runtime fills these client-side from the decoded auth subject
   * (the same `sub` the server will stamp), so the local row renders attributed immediately and never
   * flips on convergence.
   */
  managedAuthUidCreatePropertyKeys: string[];
  recordIncludesOverlayState: boolean;
  columns: Array<{
    propertyKey: string;
    column: ReturnType<typeof getProjectedTableColumns<AnyPgTable>>[number]["column"];
  }>;
}

export interface MutationRuntime<TRegistry extends SyncTableRegistry> {
  /** The registry fingerprint (ADR-0004) this runtime stamps onto enqueued mutations. */
  registryVersion: string;
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
  /**
   * Enqueue an atomic batch of mutations. An optional {@link WriteUnit} tags every row of the batch as one
   * dynamic write-unit (ADR-0022 §2) — the `transaction({ mode })` block passes it; the per-table
   * `create`/`update`/`delete` helpers do not (their write-mode comes from the static group at flush).
   */
  batch: (items: ReadonlyArray<MutationBatchItem<TRegistry>>, unit?: WriteUnit) => Promise<void>;
  /**
   * Discard a `conflicted` entity (ADR-0015): clear its conflicted journal entries and the kept
   * optimistic Overlay, so the Read model falls back to the synced (server) value. Use when the user
   * abandons their stale edit instead of resolving it as a new write. No-op for an entity with no
   * conflicted entry.
   */
  discardConflict: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
  ) => Promise<void>;
  flush: (table?: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * Flush one pessimistic write-unit (ADR-0022) to the authoritative endpoint and apply its per-mutation
   * result inline: `acked` clears via the synced echo, `conflicted` keeps the overlay (surfaced), and
   * `rejected` auto-discards the overlay for the whole unit (surfaced via `onReject`). A foreground
   * operation — it resolves once the server has decided. Throws on transport failure (the overlay is kept
   * for a retry). Returns the server acks. Used by the client `transaction({ mode: "pessimistic" })` block.
   */
  flushUnit: (unitId: string) => Promise<{ acks: MutationAck[] }>;
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

/**
 * Best-effort decode of a JWT's `sub` claim, for stamping `authUid` managed fields into the optimistic
 * overlay (the value the server will independently stamp from `auth.uid()`). This is **not** a
 * verification — the token is trusted only for a local, optimistic projection that the server re-stamps
 * authoritatively on apply; a forged `sub` could never make the server attribute the row differently.
 * Returns `undefined` for a malformed token or a missing/non-string `sub`.
 */
export function decodeJwtSubject(token: string): string | undefined {
  const segments = token.split(".");
  if (segments.length < 2 || !segments[1]) {
    return undefined;
  }
  try {
    const normalized = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export function computeBackoffDelayMs(attemptCount: number) {
  const exponent = Math.max(attemptCount - 1, 0);
  return Math.min(1000 * 2 ** exponent, 30_000);
}

/**
 * Retry delay with equal jitter around the {@link computeBackoffDelayMs} ceiling: half
 * the ceiling plus a random share of the other half. Spreads retries so a fleet of
 * clients does not stampede the server in lockstep after an outage (ADR-0005 congestion
 * policy). `random` is injectable for deterministic tests.
 */
export function computeRetryDelayMs(attemptCount: number, random: () => number = Math.random) {
  const ceiling = computeBackoffDelayMs(attemptCount);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function computeNextRetryAtUs(nowUs: string, attemptCount: number, random: () => number = Math.random) {
  return (BigInt(nowUs) + BigInt(computeRetryDelayMs(attemptCount, random)) * 1000n).toString();
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

  // The current auth subject (JWT `sub`) for stamping `authUid` create-managed fields into the
  // optimistic overlay. Resolved only when a create needs it (a table with such a field), so
  // tokenless registries never pay a token lookup.
  const resolveAuthSubject = async (): Promise<string | undefined> => {
    const token = await resolveAuthToken();
    return token ? decodeJwtSubject(token) : undefined;
  };

  const tableContexts = buildTableContexts(options.registry);
  const maxMutationAttempts = options.maxMutationAttempts ?? DEFAULT_MAX_MUTATION_ATTEMPTS;
  const flushBatchSize = options.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
  // The fingerprint (ADR-0004) stamped onto each enqueued mutation (ADR-0006). The runtime
  // owns the registry, so it derives this itself; an explicit override is honoured for tests.
  const registryVersion = options.registryVersion ?? fingerprintRegistry(options.registry);
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

  const normalizeBatchItem = (
    item: MutationBatchItem<TRegistry>,
    order: number,
    authSubject: string | undefined,
  ): NormalizedBatchItem => {
    const context = getTableContext(item.table as SyncTableName<TRegistry>);
    const mutationId = globalThis.crypto.randomUUID();
    const nowUs = nowMicroseconds();

    switch (item.kind) {
      case "create": {
        const strippedInput = stripReadModelOverlayFields(item.input);
        const optimisticRecord = ensureRecord(createOptimisticRecordFromContext(context, strippedInput, authSubject));
        const entityKey = buildEntityKeyFromRecord(context, optimisticRecord);

        return {
          context,
          kind: "create",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          optimisticRecord,
          input: strippedInput,
          mutationId,
          nowUs,
          order,
        };
      }
      case "update": {
        const entityKey = normalizeEntityKey(context, item.entityKey);
        const patch = ensureRecord(stripReadModelOverlayFields(item.patch));

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

  const enqueueBatch = async (
    items: ReadonlyArray<MutationBatchItem<TRegistry>>,
    unit?: WriteUnit,
  ): Promise<string[]> => {
    if (items.length === 0) {
      return [];
    }

    // The distinct pessimistic write-unit ids this enqueue tagged — returned so the caller can
    // foreground-route them to the authoritative endpoint (ADR-0022). Empty for a purely optimistic batch.
    const pessimisticUnitIds = new Set<string>();

    // Resolve the auth subject once per batch, but only if a create actually needs it (a target table
    // with an `authUid` create-managed field). Avoids a token lookup for every other write.
    const needsAuthSubject = items.some(
      (item) =>
        item.kind === "create" &&
        getTableContext(item.table as SyncTableName<TRegistry>).managedAuthUidCreatePropertyKeys.length > 0,
    );
    const authSubject = needsAuthSubject ? await resolveAuthSubject() : undefined;

    const normalizedItems = items.map((item, index) => normalizeBatchItem(item, index, authSubject));
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
              payloadJson: jsonStringifyPayload({
                kind: "create",
                value: item.input,
              }),
              nowUs: item.nowUs,
              // A create has no Base server version (ADR-0015): its conflict is a PK collision, a
              // separate concern from the stale-write check.
              baseServerVersion: null,
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

            // ADR-0015: capture the Base server version BEFORE the record is replaced by the
            // optimistic value below (which overwrites the Server version with the client clock).
            const updateBaseServerVersion = captureChainHeadBase(context, entityState);
            const overlayKind = entityState.overlayKind === "pending_create" ? "pending_create" : "pending_update";
            const optimisticRecord = ensureRecord(
              buildOptimisticRecord(
                context,
                {
                  ...entityState.record,
                  ...item.patch,
                  // Re-stamp the on-update managed timestamp(s) generically (governance-driven) — for a
                  // convention table this is exactly `updatedAtUs`, for a custom-named Server version
                  // it is that column, so the optimistic row never carries a stale managed value.
                  ...buildUpdateManagedNowStamp(context, item.nowUs),
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
              payloadJson: jsonStringifyPayload({
                kind: "update",
                patch: item.patch,
              }),
              nowUs: item.nowUs,
              baseServerVersion: updateBaseServerVersion,
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

            const deleteBaseServerVersion = captureChainHeadBase(context, entityState);
            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "delete",
              payloadJson: jsonStringifyPayload({
                kind: "delete",
                entityKey: item.entityKey,
              }),
              nowUs: item.nowUs,
              baseServerVersion: deleteBaseServerVersion,
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

      // ADR-0022: an explicit unit (from a `transaction` block) tags the whole batch; otherwise a
      // statically-`pessimistic` table earns its own per-enqueue unit, so its writes route to the
      // authoritative endpoint too. An optimistic table with no explicit unit stays untagged.
      const effectiveUnit: WriteUnit | undefined =
        unit ??
        (context.entry.writeMode === "pessimistic"
          ? { id: globalThis.crypto.randomUUID(), mode: "pessimistic" }
          : undefined);
      if (effectiveUnit?.mode === "pessimistic") {
        pessimisticUnitIds.add(effectiveUnit.id);
      }
      await insertMutationsBulk(options.db, context, plannedMutations, registryVersion, effectiveUnit);
      await upsertOverlayRecordsBulk(options.db, context, [...plannedOverlays.values()]);
    }

    return [...pessimisticUnitIds];
  };

  const runFlush = async (table?: SyncTableName<TRegistry>) => {
    const affectedContexts = new Map<string, TableContext>();
    const quarantinedMutationIds = new Set<string>();
    const conflictedMutationIds = new Set<string>();
    let processedCount = 0;

    do {
      const batchResult = await flushBatch(
        options.db,
        tableContexts as Record<string, TableContext>,
        options.writeUrl,
        maxMutationAttempts,
        flushBatchSize,
        table,
        resolveAuthToken,
      );

      processedCount = batchResult.processedCount;

      for (const context of batchResult.affectedContexts) {
        affectedContexts.set(context.key, context);
      }

      for (const mutationId of batchResult.quarantinedMutationIds) {
        quarantinedMutationIds.add(mutationId);
      }

      for (const mutationId of batchResult.conflictedMutationIds) {
        conflictedMutationIds.add(mutationId);
      }
    } while (processedCount > 0);

    for (const context of affectedContexts.values()) {
      await reconcileTable(options.db, context);
    }

    // Surface newly-quarantined mutations after reconciliation so the app never has to
    // poll for permanently-rejected writes (ADR-0006 decision 4). Never silent loss.
    if (quarantinedMutationIds.size > 0 && options.onQuarantine) {
      const details = await readMutationDetailsForContexts(
        options.db,
        [...affectedContexts.values()],
        quarantinedMutationIds,
      );

      if (details.length > 0) {
        await options.onQuarantine(details);
      }
    }

    // Surface newly-conflicted (stale) writes (ADR-0015). The optimistic Overlay is kept, so the app
    // can show a resolution/diff UI and resolve each as a new write (or discard it). Never silent.
    if (conflictedMutationIds.size > 0 && options.onConflict) {
      const details = await readMutationDetailsForContexts(
        options.db,
        [...affectedContexts.values()],
        conflictedMutationIds,
      );

      if (details.length > 0) {
        await options.onConflict(details);
      }
    }
  };

  const runtime: MutationRuntime<TRegistry> = {
    registryVersion,
    create: async (table, input) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch([{ table, kind: "create", input }]);
      });
      // A statically-`pessimistic` table foreground-routes its write to the authoritative endpoint
      // (ADR-0022) — the write is server-authoritative, so it is sent immediately, not left for the
      // optimistic convergence loop (which skips pessimistic rows).
      for (const unitId of unitIds) {
        await runtime.flushUnit(unitId);
      }
    },
    update: async (table, entityKeyInput, patch) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch([{ table, kind: "update", entityKey: entityKeyInput, patch }]);
      });
      for (const unitId of unitIds) {
        await runtime.flushUnit(unitId);
      }
    },
    delete: async (table, entityKeyInput) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch([{ table, kind: "delete", entityKey: entityKeyInput }]);
      });
      for (const unitId of unitIds) {
        await runtime.flushUnit(unitId);
      }
    },
    batch: async (items, unit) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch(items, unit);
      });
      // An explicit unit (from a `transaction` block) is flushed by the caller; only foreground-route the
      // units a plain `batch()` generated for statically-pessimistic tables.
      if (!unit) {
        for (const unitId of unitIds) {
          await runtime.flushUnit(unitId);
        }
      }
    },
    discardConflict: async (table, entityKeyInput) => {
      const context = getTableContext(table);
      const entityKey = normalizeEntityKey(context, entityKeyInput);
      const entityKeyJson = serializeEntityKey(entityKey);

      // discardConflictedEntity owns its own transaction (like reconcileTable), so it is not wrapped.
      await discardConflictedEntity(options.db, context, entityKey, entityKeyJson);
    },
    flush: async (table) => {
      const nextFlush = flushQueue.then(() => runFlush(table));
      flushQueue = nextFlush.catch(() => undefined);
      await nextFlush;
    },
    flushUnit: async (unitId) => {
      const contexts = Object.values(tableContexts).filter((context): context is TableContext => context != null);
      const unitRows = await readUnitPendingRows(options.db, contexts, unitId);
      if (unitRows.length === 0) {
        return { acks: [] };
      }

      // Prepare the unit's rows (entity key + envelope payload) and group them by table.
      const prepared: PreparedBatchRow[] = [];
      const byContext = new Map<string, PreparedBatchRow[]>();
      for (const row of unitRows) {
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
                    (rawPayload["value"] ?? rawPayload["patch"] ?? rawPayload) as Record<string, unknown>,
                    row.mutationKind as "create" | "update",
                  ),
                ),
          sqlTableName: context.entry.shape?.tableName ?? context.key,
        };
        prepared.push(preparedRow);
        const list = byContext.get(context.key);
        if (list) {
          list.push(preparedRow);
        } else {
          byContext.set(context.key, [preparedRow]);
        }
      }

      // Mark every member sending (persist the resolved Base server version, like the batch path).
      const sentAtUs = nowMicroseconds();
      for (const rows of byContext.values()) {
        await applyMutationStatusUpdates(
          options.db,
          rows[0]!.context,
          rows.map((row) => ({
            mutationId: row.mutationId,
            status: "sending" as const,
            attemptCount: row.attemptCount + 1,
            updatedAtUs: sentAtUs,
            sentAtUs,
            replaceSentAtUs: true,
            baseServerVersion: row.baseServerVersion,
            replaceBaseServerVersion: true,
            lastError: null,
            nextRetryAtUs: null,
            lastHttpStatus: null,
            conflictReason: null,
          })),
        );
      }

      const mutations = prepared.map((row) => ({
        tableName: row.sqlTableName,
        entityKey: row.entityKey,
        mutationId: row.mutationId,
        mutationSeq: row.mutationSeq,
        kind: row.mutationKind as "create" | "update" | "delete",
        payload: row.envelopePayload,
        clientTimestampUs: sentAtUs,
        ...(row.baseServerVersion != null ? { baseServerVersion: row.baseServerVersion } : {}),
      }));

      const url = resolveAuthoritativeMutationUrl(options.writeUrl);
      let acksByMutationId: Map<string, BatchMutationAck["acks"][number]>;

      try {
        const authToken = await options.getAuthToken?.();
        let response = await fetch(url, {
          method: "POST",
          headers: buildRequestHeaders(authToken),
          body: jsonStringifyPayload({ writeUnit: unitId, mutations }),
        });

        if ([401, 403].includes(response.status) && options.getAuthToken) {
          response = await fetch(url, {
            method: "POST",
            headers: buildRequestHeaders(await options.getAuthToken()),
            body: jsonStringifyPayload({ writeUnit: unitId, mutations }),
          });
        }

        if (!response.ok) {
          const text = await response.text();
          throw new MutationRequestError(
            text.length > 0 ? text : `Authoritative write responded with ${response.status}`,
            response.status,
            parseBatchRejections(text),
          );
        }

        const responseJson = (await response.json()) as BatchMutationAck;
        acksByMutationId = new Map(responseJson.acks.map((ack) => [ack.mutationId, ack]));
      } catch (error) {
        // A pessimistic write is foreground: it never reached the server (transport / non-2xx), so the
        // unit did not happen. Mark it failed — KEEPING the optimistic overlay so a retry can resend — and
        // rethrow so the caller surfaces it. There is no background retry for pessimistic units.
        const failedAtUs = nowMicroseconds();
        const httpStatus = error instanceof MutationRequestError ? error.status : null;
        const errorMessage = error instanceof Error ? error.message : "Authoritative write failed";
        for (const rows of byContext.values()) {
          await applyMutationStatusUpdates(
            options.db,
            rows[0]!.context,
            rows.map((row) => {
              const attemptCount = row.attemptCount + 1;
              const outcome = resolveBatchFailureOutcome(attemptCount, maxMutationAttempts, failedAtUs);
              return {
                mutationId: row.mutationId,
                status: outcome.status,
                attemptCount,
                updatedAtUs: failedAtUs,
                lastError: errorMessage,
                nextRetryAtUs: outcome.nextRetryAtUs,
                lastHttpStatus: httpStatus,
                conflictReason: null,
              };
            }),
          );
        }
        throw error;
      }

      // Apply each member's ack.
      const ackedAtUs = nowMicroseconds();
      const failedAtUs = nowMicroseconds();
      const rejectedIds = new Set<string>();
      const conflictedIds = new Set<string>();

      for (const rows of byContext.values()) {
        await applyMutationStatusUpdates(
          options.db,
          rows[0]!.context,
          rows.map((row) => {
            const ack = acksByMutationId.get(row.mutationId);

            if (ack?.status === "rejected") {
              // ADR-0022 §4: a business rejection. Terminal `rejected`; the overlay is auto-discarded below.
              rejectedIds.add(row.mutationId);
              return {
                mutationId: row.mutationId,
                status: "rejected" as const,
                attemptCount: row.attemptCount + 1,
                updatedAtUs: failedAtUs,
                lastError: ack.rejectionReason ?? "Rejected by the authoritative endpoint",
                nextRetryAtUs: null,
                lastHttpStatus: ack.httpStatus ?? 409,
                conflictReason: ack.rejectionReason ?? "Rejected by the authoritative endpoint",
              };
            }

            if (ack?.status === "conflicted") {
              // ADR-0015: a stale member — terminal `conflicted`, overlay KEPT (resolve as a new write).
              conflictedIds.add(row.mutationId);
              return {
                mutationId: row.mutationId,
                status: "conflicted" as const,
                attemptCount: row.attemptCount + 1,
                updatedAtUs: failedAtUs,
                serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
                replaceServerUpdatedAtUs: true,
                lastError: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
                nextRetryAtUs: null,
                lastHttpStatus: ack.httpStatus ?? 409,
                conflictReason: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
              };
            }

            if (!ack || ack.status !== "acked") {
              const attemptCount = row.attemptCount + 1;
              const outcome = resolveFailureOutcome(
                ack?.httpStatus ?? null,
                attemptCount,
                maxMutationAttempts,
                failedAtUs,
              );
              return {
                mutationId: row.mutationId,
                status: outcome.status,
                attemptCount,
                updatedAtUs: failedAtUs,
                lastError: ack?.conflictReason ?? "Authoritative write not acknowledged",
                nextRetryAtUs: outcome.nextRetryAtUs,
                lastHttpStatus: ack?.httpStatus ?? null,
                conflictReason: null,
              };
            }

            return {
              mutationId: row.mutationId,
              status: "acked" as const,
              attemptCount: row.attemptCount + 1,
              updatedAtUs: ackedAtUs,
              ackedAtUs,
              replaceAckedAtUs: true,
              serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
              replaceServerUpdatedAtUs: true,
              lastError: null,
              nextRetryAtUs: null,
              lastHttpStatus: row.mutationKind === "delete" ? 204 : 200,
              conflictReason: null,
            };
          }),
        );
      }

      // ADR-0022 §4: auto-discard the optimistic overlay for every rejected entity (the whole unit was
      // declined). The terminal `rejected` journal row is kept for diagnostics + `onReject`.
      for (const row of prepared) {
        if (rejectedIds.has(row.mutationId)) {
          await discardOverlayForSettledEntity(options.db, row.context, row.entityKey, row.entityKeyJson);
        }
      }

      const affectedContexts = [...byContext.keys()]
        .map((key) => tableContexts[key])
        .filter((context): context is TableContext => context != null);
      for (const context of affectedContexts) {
        await reconcileTable(options.db, context);
      }

      if (rejectedIds.size > 0 && options.onReject) {
        const details = await readMutationDetailsForContexts(options.db, affectedContexts, rejectedIds);
        if (details.length > 0) {
          await options.onReject(details);
        }
      }
      if (conflictedIds.size > 0 && options.onConflict) {
        const details = await readMutationDetailsForContexts(options.db, affectedContexts, conflictedIds);
        if (details.length > 0) {
          await options.onConflict(details);
        }
      }

      return { acks: [...acksByMutationId.values()] };
    },
    reconcile: async (table) => {
      const contexts = filterContexts(tableContexts, table);

      for (const context of contexts) {
        await reconcileTable(options.db, context);
      }
    },
    retryFailed: async (table) => {
      assertValidMutationTransition("failed", "pending");
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
      assertValidMutationTransition("sending", "pending");
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
        quarantinedCount: 0,
        conflictedCount: 0,
        ackedCount: 0,
      };

      for (const context of contexts) {
        const result = await options.db.query<MutationDiagnostics & Record<string, unknown>>(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS "pendingCount",
            COUNT(*) FILTER (WHERE status = 'sending')::int AS "sendingCount",
            COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedCount",
            COUNT(*) FILTER (WHERE status = 'quarantined')::int AS "quarantinedCount",
            COUNT(*) FILTER (WHERE status = 'conflicted')::int AS "conflictedCount",
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
        totals.quarantinedCount += row.quarantinedCount;
        totals.conflictedCount += row.conflictedCount;
        totals.ackedCount += row.ackedCount;
      }

      return totals;
    },
    readMutationDetails: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      return readMutationDetailsForContexts(options.db, contexts);
    },
    createOptimisticRecord: (table, input) => {
      const context = getTableContext(table);
      return createOptimisticRecordFromContext(context, input);
    },
  };

  return runtime;
}

/**
 * Read journal entries across the given contexts as {@link MutationDetail}s, newest first.
 * Shared by the public `readMutationDetails` and the flush path's quarantine surfacing,
 * optionally narrowed to a set of mutation ids.
 */
async function readMutationDetailsForContexts(
  db: MutationDb,
  contexts: TableContext[],
  mutationIds?: ReadonlySet<string>,
): Promise<MutationDetail[]> {
  const rows: MutationDetail[] = [];

  for (const context of contexts) {
    const result = await db.query<MutationDetailRow>(`
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
        updated_at_us::text AS "updatedAtUs",
        registry_version AS "registryVersion"
      FROM ${context.journalTable}
      ORDER BY updated_at_us DESC, mutation_seq DESC
    `);

    for (const row of result.rows) {
      if (mutationIds && !mutationIds.has(row.mutationId)) {
        continue;
      }

      rows.push({
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
        registryVersion: row.registryVersion,
      });
    }
  }

  return rows.sort((left, right) => Number(right.updatedAtUs) - Number(left.updatedAtUs));
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
  registryVersion: string | null;
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
  registryVersion: string | null;
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
  /**
   * The Base server version (ADR-0015) stamped at enqueue: the synced Server version the user saw,
   * for a **chain head** (the first staged write on the entity). `null` for a `create` (no base) and
   * for a **chained** write — the latter resolves its base at flush from its acked predecessor
   * (readPendingBatchRows), by Per-entity flush serialization (ADR-0014).
   */
  baseServerVersion: string | null;
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

/**
 * The Base server version (ADR-0015) to stamp at enqueue for an update/delete. Only a **chain head**
 * — the first staged write on the entity (no earlier unresolved mutation) — captures an enqueue-time
 * base: the synced Server version the user's edit was authored against, so a genuine external write
 * between view and apply is caught. A **chained** write (an earlier same-entity mutation is still
 * owed) returns `null` here; it resolves its base at flush from its acked predecessor, so an entity's
 * own successive edits never self-conflict (decision 2).
 */
function captureChainHeadBase(context: TableContext, entityState: BatchEntityState): string | null {
  if ((entityState.latestMutationSeq ?? 0) !== 0) {
    return null;
  }

  if (!context.serverVersionPropertyKey || !entityState.record) {
    return null;
  }

  // The Server version is a bigint count of microseconds, surfaced as a string/number/bigint
  // depending on the read path. Anything else (null/object) means no observable base.
  const raw = entityState.record[context.serverVersionPropertyKey];
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint") {
    return String(raw);
  }

  return null;
}

function buildTableContexts<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  const localSchema = getSyncRegistrySchema(registry);

  return Object.fromEntries(
    Object.entries(registry)
      .filter(([, entry]) => entry.mode !== "readonly")
      .map(([key, entry]) => [key, buildTableContext(key, entry, localSchema)]),
  ) as Partial<Record<SyncTableName<TRegistry>, TableContext>>;
}

function buildTableContext(key: string, entry: SyncTableEntry<AnyPgTable>, localSchema: string): TableContext {
  if (!entry.clientProjection?.overlayTable || !entry.clientProjection.journalTable) {
    throw new Error(`overlay and journal tables are required for writable table ${key}`);
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

  const serverVersionColumnName = resolveServerVersionColumnName(entry) ?? null;
  const serverVersionPropertyKey = serverVersionColumnName
    ? (columns.find((candidate) => candidate.column.name === serverVersionColumnName)?.propertyKey ?? null)
    : null;

  // Resolve the `nowMicroseconds` managed fields generically from governance, not by property name.
  // `field.column` is a drizzle property key, but tolerate a column-name declaration too.
  const resolveManagedPropertyKey = (fieldColumn: string): string | undefined =>
    columns.find((candidate) => candidate.propertyKey === fieldColumn || candidate.column.name === fieldColumn)
      ?.propertyKey;
  const nowMicrosecondsManagedFields = (entry.governance?.managedFields ?? []).filter(
    (field) => field.strategy === "nowMicroseconds",
  );
  const managedNowMicrosecondsPropertyKeys = nowMicrosecondsManagedFields
    .map((field) => resolveManagedPropertyKey(field.column as string))
    .filter((propertyKey): propertyKey is string => propertyKey !== undefined);
  const updateManagedNowMicrosecondsPropertyKeys = nowMicrosecondsManagedFields
    .filter((field) => field.applyOn.includes("update"))
    .map((field) => resolveManagedPropertyKey(field.column as string))
    .filter((propertyKey): propertyKey is string => propertyKey !== undefined);

  const managedAuthUidCreatePropertyKeys = (entry.governance?.managedFields ?? [])
    .filter((field) => field.strategy === "authUid" && field.applyOn.includes("create"))
    .map((field) => resolveManagedPropertyKey(field.column as string))
    .filter((propertyKey): propertyKey is string => propertyKey !== undefined);

  return {
    key,
    entry,
    readModel: qualifyLocalIdentifier(
      localSchema,
      entry.view != null
        ? getViewConfig(entry.view).name
        : (entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name),
    ),
    syncedTable: qualifyLocalIdentifier(
      localSchema,
      entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name,
    ),
    overlayTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.overlayTable),
    journalTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.journalTable),
    journalSequence: qualifyLocalIdentifier(localSchema, buildJournalSequenceName(entry.clientProjection.journalTable)),
    pkColumnNames: [...entry.primaryKey.columns],
    pkPropertyKeys,
    serverVersionColumnName,
    serverVersionPropertyKey,
    managedNowMicrosecondsPropertyKeys,
    updateManagedNowMicrosecondsPropertyKeys,
    managedAuthUidCreatePropertyKeys,
    recordIncludesOverlayState: "overlayTable" in (entry.clientProjection ?? {}),
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

/**
 * Materialise a column's default into a concrete JS value for the optimistic overlay
 * row. The overlay INSERT writes an explicit value for every projected column (an
 * omitted column becomes a literal `NULL`, which overrides any table-level DEFAULT), so
 * a column declared `NOT NULL DEFAULT <x>` that the caller omits would violate the
 * overlay's NOT NULL constraint unless we fill the default here — mirroring what the
 * authoritative server applies on the base table.
 *
 * Only values we can produce client-side are materialised: a value-returning `defaultFn`
 * (e.g. `$defaultFn`) or a literal `.default(value)`. SQL-expression defaults
 * (`.default(sql\`…\`)`, `defaultRandom()`, `defaultNow()`) cannot be evaluated without
 * the database, so they are left to the server (the column is then expected to be either
 * caller-supplied or nullable in the optimistic row).
 */
function materializeColumnDefault(column: TableContext["columns"][number]["column"]): {
  ok: boolean;
  value?: unknown;
} {
  if (!column.hasDefault) {
    return { ok: false };
  }

  if (typeof column.defaultFn === "function") {
    const produced = column.defaultFn();
    return is(produced, SQL) ? { ok: false } : { ok: true, value: produced };
  }

  if (column.default !== undefined && !is(column.default, SQL)) {
    return { ok: true, value: column.default };
  }

  return { ok: false };
}

function createOptimisticRecordFromContext<TCreate, TRecord>(
  context: TableContext,
  input: TCreate,
  authSubject?: string,
): TRecord {
  const record = {
    ...(isRecord(input) ? input : {}),
  };
  const nowUs = nowMicroseconds();

  // Stamp `authUid` create-managed fields (owner/author/created_by) with the current subject so the
  // optimistic overlay row is attributed locally and satisfies the column's NOT NULL — the server
  // independently stamps the same `auth.uid()` on apply, so the value never flips on convergence.
  if (authSubject != null) {
    for (const propertyKey of context.managedAuthUidCreatePropertyKeys) {
      if (record[propertyKey] === undefined) {
        record[propertyKey] = authSubject;
      }
    }
  }

  if (hasProperty(context, "createdAtUs") && record["createdAtUs"] === undefined) {
    record["createdAtUs"] = nowUs;
  }

  if (hasProperty(context, "updatedAtUs") && record["updatedAtUs"] === undefined) {
    record["updatedAtUs"] = nowUs;
  }

  // Generic managed-timestamp fill (governance-driven): stamp any `nowMicroseconds` managed field the
  // convention block above did not — e.g. a Server version column not named `updated_at_us`. Additive
  // and idempotent, so convention tables are unaffected (their fields are already filled).
  for (const propertyKey of context.managedNowMicrosecondsPropertyKeys) {
    if (record[propertyKey] === undefined) {
      record[propertyKey] = nowUs;
    }
  }

  for (const { propertyKey, column } of context.columns) {
    if (record[propertyKey] !== undefined) {
      continue;
    }

    const materialized = materializeColumnDefault(column);
    if (materialized.ok) {
      record[propertyKey] = materialized.value;
    }
  }

  return buildOptimisticRecord(context, record, {
    overlayKind: "pending_create",
    localUpdatedAtUs: nowUs,
  }) as TRecord;
}

/**
 * Stamp every on-update `nowMicroseconds` managed field with `nowUs` (governance-driven, ADR-0004),
 * keyed by drizzle property key. For a convention table this is exactly `{ updatedAtUs: nowUs }`; for
 * a custom-named Server version it targets that column — so the local optimistic path never assumes
 * the demo naming the generic server applier does not.
 */
function buildUpdateManagedNowStamp(context: TableContext, nowUs: string): Record<string, string> {
  return Object.fromEntries(
    context.updateManagedNowMicrosecondsPropertyKeys.map((propertyKey) => [propertyKey, nowUs]),
  );
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
    return record;
  }

  return {
    ...record,
    overlayKind: options.overlayKind,
    localUpdatedAtUs: options.localUpdatedAtUs,
  };
}

function buildEntityKeyFromRecord(context: TableContext, record: unknown) {
  const recordObject = ensureRecord(record);
  return normalizeEntityKey(
    context,
    Object.fromEntries(context.pkPropertyKeys.map((propertyKey) => [propertyKey, String(recordObject[propertyKey])])),
  );
}

function normalizeEntityKey(context: TableContext, input: Record<string, string>) {
  // The public API accepts the identity by drizzle property name (ergonomics); past this
  // boundary the canonical Entity identity is column-keyed (ADR-0012), matching the
  // journal/overlay PK columns, entity_key_json, and the applier's `v_entity_key->>'<column>'`.
  // pkPropertyKeys[i] ↔ pkColumnNames[i] by construction (buildTableContext), so we map once here.
  return Object.fromEntries(
    context.pkPropertyKeys.map((propertyKey, index) => {
      const value = input[propertyKey];

      if (value === undefined) {
        throw new Error(`Missing entity key property ${propertyKey} for table ${context.key}`);
      }

      return [context.pkColumnNames[index]!, String(value)];
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

async function insertMutationsBulk(
  db: MutationDb,
  context: TableContext,
  rows: ReadonlyArray<PlannedMutationInsert>,
  registryVersion: string | null,
  unit?: WriteUnit,
) {
  if (rows.length === 0) {
    return;
  }

  // ADR-0022: a dynamic write-unit tags every row of the batch with one shared unit id + mode; the
  // default path leaves both NULL (the flusher derives mode/unit from the static group). Appended after
  // the existing columns so the per-row placeholder indices above stay put.
  const writeUnit = unit?.id ?? null;
  const writeMode = unit?.mode ?? null;
  const insertColumnNames = [
    "mutation_id",
    ...context.pkColumnNames,
    "entity_key_json",
    "mutation_seq",
    "mutation_kind",
    "status",
    "registry_version",
    "base_server_version",
    "payload_json",
    "enqueued_at_us",
    "next_retry_at_us",
    "updated_at_us",
    "write_unit",
    "write_mode",
  ];
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const start = params.length;
    const values = [
      row.mutationId,
      ...context.pkColumnNames.map((columnName) => row.entityKey[columnName]),
      row.entityKeyJson,
      row.mutationKind,
      "pending",
      registryVersion,
      row.baseServerVersion,
      row.payloadJson,
      row.nowUs,
      row.nowUs,
      row.nowUs,
      writeUnit,
      writeMode,
    ];

    params.push(...values);

    const pk = context.pkColumnNames.length;
    const valuePlaceholders = [
      formatSqlValuePlaceholder(start + 1, "mutation_id"),
      ...context.pkColumnNames.map((columnName, index) => formatSqlValuePlaceholder(start + index + 2, columnName)),
      formatSqlValuePlaceholder(start + pk + 2, "entity_key_json"),
      `nextval('${escapeSqlString(context.journalSequence)}')::integer`,
      formatSqlValuePlaceholder(start + pk + 3, "mutation_kind"),
      formatSqlValuePlaceholder(start + pk + 4, "status"),
      formatSqlValuePlaceholder(start + pk + 5, "registry_version"),
      `$${start + pk + 6}::bigint`,
      formatSqlValuePlaceholder(start + pk + 7, "payload_json"),
      formatSqlValuePlaceholder(start + pk + 8, "enqueued_at_us"),
      formatSqlValuePlaceholder(start + pk + 9, "next_retry_at_us"),
      formatSqlValuePlaceholder(start + pk + 10, "updated_at_us"),
      formatSqlValuePlaceholder(start + pk + 11, "write_unit"),
      formatSqlValuePlaceholder(start + pk + 12, "write_mode"),
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
    const values = [entity.entityKeyJson, ...context.pkColumnNames.map((columnName) => entity.entityKey[columnName])];

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
  /** The resolved Base server version (ADR-0015), or null when the table predates the policy. */
  baseServerVersion: string | null;
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
  /** Mutation ids that transitioned to `quarantined` in this slice (ADR-0006), for surfacing. */
  quarantinedMutationIds: string[];
  /** Mutation ids that transitioned to `conflicted` in this slice (ADR-0015), for surfacing. */
  conflictedMutationIds: string[];
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
  baseServerVersion?: string | null;
  replaceBaseServerVersion?: boolean;
  lastError?: string | null;
  nextRetryAtUs?: string | null;
  lastHttpStatus?: number | null;
  conflictReason?: string | null;
}

/**
 * The resolved Base server version (ADR-0015) for a row at flush. A **chain head** already carries
 * `base_server_version` (stamped at enqueue), so COALESCE returns it untouched — keeping the
 * enqueue-time base means a genuine external write between view and apply is still caught. A
 * **chained** write has NULL there; it resolves to its **acked predecessor's** Server version (by
 * Per-entity flush serialization the predecessor is already acked when this row flushes), falling
 * back to the entity's current synced version once that predecessor has been reconciled away. Either
 * fallback yields the entity's own latest server state, so its own chain never self-conflicts.
 */
function buildResolvedBaseServerVersionSql(context: TableContext): string {
  const journal = context.journalTable;
  const predecessor = `(SELECT MAX(pred.server_updated_at_us) FROM ${journal} AS pred WHERE pred.entity_key_json = ${journal}.entity_key_json AND pred.mutation_seq < ${journal}.mutation_seq AND pred.status = 'acked')`;

  const syncedFallback = context.serverVersionColumnName
    ? `(SELECT synced.${quoteIdentifier(context.serverVersionColumnName)} FROM ${context.syncedTable} AS synced WHERE ${buildColumnEquality(context.pkColumnNames, "synced", journal)})`
    : null;

  const expression = syncedFallback
    ? `COALESCE(${journal}.base_server_version, ${predecessor}, ${syncedFallback})`
    : `COALESCE(${journal}.base_server_version, ${predecessor})`;

  return `${expression}::text`;
}

async function readPendingBatchRows(db: MutationDb, contexts: TableContext[], nowUs: string, batchSize: number) {
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
          ${buildResolvedBaseServerVersionSql(context)} AS "baseServerVersion",
          enqueued_at_us::text AS "enqueuedAtUs"
        FROM ${context.journalTable}
        WHERE status IN ('pending', 'failed')
          -- ADR-0022: pessimistic rows are flushed by the authoritative unit path (flushUnit), never the
          -- optimistic batch — exclude them here so a tagged write is never optimistically sent.
          AND COALESCE(write_mode, '') <> 'pessimistic'
          AND COALESCE(next_retry_at_us, 0) <= $1::bigint
          AND NOT EXISTS (
            SELECT 1
            FROM ${context.journalTable} AS earlier
            WHERE earlier.entity_key_json = ${context.journalTable}.entity_key_json
              AND earlier.mutation_seq < ${context.journalTable}.mutation_seq
              -- A still-unresolved earlier mutation blocks later same-entity ones so the
              -- server applies them in author order. The quarantined status is included: a
              -- later mutation must not flush past a prerequisite the server permanently
              -- rejected (it would itself fail); resolving the quarantine unblocks the queue.
              AND earlier.status IN ('pending', 'failed', 'sending', 'quarantined')
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
      LIMIT ${batchSize}
    `,
    [nowUs],
  );

  return result.rows;
}

/**
 * Read one pessimistic write-unit's send-eligible rows (ADR-0022) across every table, ordered by author
 * sequence. Unlike {@link readPendingBatchRows} it has no per-entity ordering gate: a unit is enqueued and
 * sent atomically, so its members go together.
 */
async function readUnitPendingRows(
  db: MutationDb,
  contexts: TableContext[],
  unitId: string,
): Promise<PendingBatchRow[]> {
  if (contexts.length === 0) {
    return [];
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
          ${buildResolvedBaseServerVersionSql(context)} AS "baseServerVersion",
          enqueued_at_us::text AS "enqueuedAtUs"
        FROM ${context.journalTable}
        WHERE write_unit = $1 AND status IN ('pending', 'failed')
      `,
    )
    .join("\nUNION ALL\n");

  const result = await db.query<PendingBatchRow>(
    `SELECT * FROM (${unionSql}) AS unit ORDER BY unit."mutationSeq" ASC`,
    [unitId],
  );

  return result.rows;
}

async function flushBatch(
  db: MutationDb,
  tableContexts: Record<string, TableContext>,
  batchWriteUrl: string,
  maxAttempts: number,
  batchSize: number,
  tableFilter?: string,
  getAuthToken?: () => Promise<string | undefined>,
): Promise<FlushBatchResult> {
  const contexts = filterContexts(tableContexts, tableFilter);
  const nowUs = nowMicroseconds();
  const quarantinedMutationIds: string[] = [];
  const conflictedMutationIds: string[] = [];

  // Collect send-eligible mutations across all target tables.
  const pendingRows = await readPendingBatchRows(db, contexts, nowUs, batchSize);
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
                (rawPayload["value"] ?? rawPayload["patch"] ?? rawPayload) as Record<string, unknown>,
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
    // If a write just enqueued and requested a pass, but this flush sees nothing, the pass raced the
    // journal commit (or everything is already in-flight/backed-off) — the write then waits for a
    // later pass. Worth seeing explicitly when chasing flush latency.
    syncDebug("flushBatch: no send-eligible mutations this pass");
    return {
      processedCount: 0,
      affectedContexts: [],
      quarantinedMutationIds,
      conflictedMutationIds,
    };
  }

  syncDebug("flushBatch sending to board-write", { count: pending.length });

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
        // Persist the resolved Base server version (ADR-0015) so a chained write's flush-resolved
        // base is durable and matches exactly what the envelope carries to the server.
        baseServerVersion: row.baseServerVersion,
        replaceBaseServerVersion: true,
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
      // ADR-0015: carry the resolved Base server version so the applier can detect a stale write.
      // Omitted for a create / a table that predates the policy (null) — then no stale check runs.
      ...(row.baseServerVersion != null ? { baseServerVersion: row.baseServerVersion } : {}),
    };
  });

  let responseOk = false;
  let acksByMutationId: Map<string, BatchMutationAck["acks"][number]> = new Map();
  const batchMutationUrl = resolveBatchMutationUrl(batchWriteUrl);

  try {
    // Resolve the auth token and the network round-trip separately: in the board, `getAuthToken` calls
    // `supabase.auth.getSession()` per send, which can itself stall (token refresh) and would otherwise
    // be invisibly folded into "the write was slow".
    const authStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const authToken = await getAuthToken?.();
    const fetchStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    syncDebug("board-write auth token resolved", { ms: Math.round(fetchStart - authStart) });

    let response = await fetch(batchMutationUrl, {
      method: "POST",
      headers: buildRequestHeaders(authToken),
      body: jsonStringifyPayload({ mutations }),
    });

    if ([401, 403].includes(response.status) && getAuthToken) {
      response = await fetch(batchMutationUrl, {
        method: "POST",
        headers: buildRequestHeaders(await getAuthToken()),
        body: jsonStringifyPayload({ mutations }),
      });
    }

    const fetchEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
    syncDebug("board-write responded", { status: response.status, ms: Math.round(fetchEnd - fetchStart) });

    if (response.ok) {
      const responseJson = (await response.json()) as BatchMutationAck;
      responseOk = true;
      acksByMutationId = new Map(responseJson.acks.map((ack) => [ack.mutationId, ack]));
      syncDebug("board-write acks", {
        acks: responseJson.acks.map((ack) => `${ack.mutationId.slice(0, 8)}:${ack.status}`),
      });
    } else {
      const text = await response.text();
      throw new MutationRequestError(
        text.length > 0 ? text : `Bulk write responded with ${response.status}`,
        response.status,
        parseBatchRejections(text),
      );
    }
  } catch (error) {
    const failedAtUs = nowMicroseconds();
    const httpStatus = error instanceof MutationRequestError ? error.status : null;
    const errorMessage = error instanceof Error ? error.message : "Unknown batch write failure";
    // The server attributed the failure to specific mutations (a structural validation
    // rejection of an atomic batch). When present, we quarantine exactly those and leave the
    // innocent siblings immediately retryable; absent (transport / 5xx / auth / malformed
    // envelope), the whole batch stays retryable under the shared attempt cap.
    const rejectionById =
      error instanceof MutationRequestError && error.rejections
        ? new Map(error.rejections.map((rejection) => [rejection.mutationId, rejection]))
        : null;

    for (const rows of pendingByTable.values()) {
      await applyMutationStatusUpdates(
        db,
        rows[0]!.context,
        rows.map((row) => {
          const attemptCount = row.attemptCount + 1;

          if (rejectionById) {
            const rejection = rejectionById.get(row.mutationId);

            if (rejection) {
              // Named as the cause: terminal quarantine (it will never succeed unchanged).
              quarantinedMutationIds.push(row.mutationId);
              return {
                mutationId: row.mutationId,
                status: "quarantined" as const,
                attemptCount,
                updatedAtUs: failedAtUs,
                lastError: rejection.reason,
                nextRetryAtUs: null,
                lastHttpStatus: httpStatus,
                conflictReason: rejection.reason,
              };
            }

            // Innocent sibling: nothing was applied (atomic batch), so make it immediately
            // retryable — no backoff (the fault was the now-quarantined mutation, not
            // congestion) — and the next flush proceeds without the poison.
            return {
              mutationId: row.mutationId,
              status: "failed" as const,
              attemptCount,
              updatedAtUs: failedAtUs,
              lastError: "Batch rejected due to a sibling mutation; retrying without it",
              nextRetryAtUs: null,
              lastHttpStatus: httpStatus,
              conflictReason: null,
            };
          }

          // Unattributed batch-level failure: stays retryable with jittered backoff; only the
          // hard attempt cap escalates to terminal quarantined. A structural 4xx is NOT
          // quarantined here (a stray 404/413/malformed envelope would otherwise permanently
          // kill unrelated valid writes).
          const outcome = resolveBatchFailureOutcome(attemptCount, maxAttempts, failedAtUs);

          if (outcome.status === "quarantined") {
            quarantinedMutationIds.push(row.mutationId);
          }

          return {
            mutationId: row.mutationId,
            status: outcome.status,
            attemptCount,
            updatedAtUs: failedAtUs,
            lastError: errorMessage,
            nextRetryAtUs: outcome.nextRetryAtUs,
            lastHttpStatus: httpStatus,
            conflictReason: null,
          };
        }),
      );
    }

    return {
      processedCount: pending.length,
      affectedContexts: [...new Set(pending.map((row) => row.context))],
      quarantinedMutationIds,
      conflictedMutationIds,
    };
  }

  if (!responseOk) {
    return {
      processedCount: pending.length,
      affectedContexts: [...new Set(pending.map((row) => row.context))],
      quarantinedMutationIds,
      conflictedMutationIds,
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

        if (ack && ack.status === "conflicted") {
          // ADR-0015: a stale write the reject-if-stale policy declined. Move to the terminal
          // `conflicted` status — NOT a failure (never retried as-is, the base is still stale) — and
          // KEEP the optimistic Overlay (reconcile only clears acked rows, so the user's edit stays
          // visible). The server's current Server version rides on the journal row for the diff UI.
          conflictedMutationIds.push(row.mutationId);
          return {
            mutationId: row.mutationId,
            status: "conflicted" as const,
            attemptCount: row.attemptCount + 1,
            updatedAtUs: failedAtUs,
            serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
            replaceServerUpdatedAtUs: true,
            lastError: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
            nextRetryAtUs: null,
            lastHttpStatus: ack.httpStatus ?? 409,
            conflictReason: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
          };
        }

        if (!ack || ack.status !== "acked") {
          const attemptCount = row.attemptCount + 1;
          const httpStatus = ack?.httpStatus ?? null;
          const outcome = resolveFailureOutcome(httpStatus, attemptCount, maxAttempts, failedAtUs);

          if (outcome.status === "quarantined") {
            quarantinedMutationIds.push(row.mutationId);
          }

          return {
            mutationId: row.mutationId,
            status: outcome.status,
            attemptCount,
            updatedAtUs: failedAtUs,
            lastError: ack?.conflictReason ?? "Batch mutation not acknowledged",
            nextRetryAtUs: outcome.nextRetryAtUs,
            lastHttpStatus: httpStatus,
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
    quarantinedMutationIds,
    conflictedMutationIds,
  };
}

/**
 * Resolve a flush failure into the durable journal outcome (ADR-0006). A structural
 * rejection ({@link classifyFailureStatus}) or hitting the hard attempt cap ends the
 * retry loop with a terminal `quarantined` (no `next_retry_at_us`); otherwise the
 * mutation stays `failed` with a jittered backoff (ADR-0005 congestion policy).
 */
function resolveFailureOutcome(
  httpStatus: number | null,
  attemptCount: number,
  maxAttempts: number,
  failedAtUs: string,
): { status: "failed" | "quarantined"; nextRetryAtUs: string | null } {
  if (classifyFailureStatus(httpStatus) === "quarantined" || attemptCount >= maxAttempts) {
    return { status: "quarantined", nextRetryAtUs: null };
  }

  return { status: "failed", nextRetryAtUs: computeNextRetryAtUs(failedAtUs, attemptCount) };
}

/**
 * Resolve a *batch-level* failure — the whole POST failed (transport error, 5xx, auth, or a
 * non-2xx the server did not attribute to a specific mutation). Unlike a per-mutation ack
 * rejection, the fault cannot be pinned on any one mutation, so a structural 4xx must NOT
 * quarantine the batch (a stray 404/413/malformed envelope would permanently kill unrelated
 * valid offline writes). These failures stay retryable `failed` with jittered backoff; only
 * the hard attempt cap escalates to terminal `quarantined`.
 */
function resolveBatchFailureOutcome(
  attemptCount: number,
  maxAttempts: number,
  failedAtUs: string,
): { status: "failed" | "quarantined"; nextRetryAtUs: string | null } {
  if (attemptCount >= maxAttempts) {
    return { status: "quarantined", nextRetryAtUs: null };
  }

  return { status: "failed", nextRetryAtUs: computeNextRetryAtUs(failedAtUs, attemptCount) };
}

function resolveBatchMutationUrl(batchWriteUrl: string): string {
  const trimmed = batchWriteUrl.replace(/\/+$/, "");

  if (trimmed.endsWith("/mutations")) {
    return trimmed;
  }

  return `${trimmed}/mutations`;
}

/** The authoritative (pessimistic) write endpoint (ADR-0022): the batch URL with `/unit` appended. */
function resolveAuthoritativeMutationUrl(batchWriteUrl: string): string {
  return `${resolveBatchMutationUrl(batchWriteUrl)}/unit`;
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

/**
 * Discard a conflicted entity (ADR-0015): clear its `conflicted` journal entries and its kept
 * optimistic Overlay row, so the Read model falls back to the synced (server) value. The overlay is
 * removed only when no other journal row still owes the entity (a pending/sending/failed/acked write),
 * mirroring reconcileTable's overlay-clear guard — so a discard never strips an overlay another
 * un-resolved write still depends on.
 */
async function discardConflictedEntity(
  db: MutationDb,
  context: TableContext,
  entityKey: Record<string, string>,
  entityKeyJson: string,
) {
  await db.exec("BEGIN");

  try {
    await db.query(`DELETE FROM ${context.journalTable} WHERE status = 'conflicted' AND entity_key_json = $1`, [
      entityKeyJson,
    ]);

    // Clear the kept overlay only when no journal row still owes this entity — so a discard never
    // strips an overlay another un-resolved write (e.g. a resolution already enqueued) depends on.
    const pkConditions = context.pkColumnNames.map((columnName, index) => `overlay.${columnName} = $${index + 1}`);
    const pkValues = context.pkColumnNames.map((columnName) => entityKey[columnName]);
    await db.query(
      `DELETE FROM ${context.overlayTable} AS overlay
       WHERE ${pkConditions.join(" AND ")}
         AND NOT EXISTS (
           SELECT 1 FROM ${context.journalTable} AS j WHERE j.entity_key_json = $${pkValues.length + 1}
         )`,
      [...pkValues, entityKeyJson],
    );

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Auto-discard the optimistic overlay for an entity whose pessimistic write-unit the authoritative endpoint
 * `rejected` (ADR-0022 §4). Unlike {@link discardConflictedEntity} this KEEPS the terminal `rejected` journal
 * row (for diagnostics + `onReject`); it only clears the overlay, and only when no still-owed
 * (`pending`/`sending`/`failed`) journal row depends on it — so a later un-sent write never loses its overlay.
 */
async function discardOverlayForSettledEntity(
  db: MutationDb,
  context: TableContext,
  entityKey: Record<string, string>,
  entityKeyJson: string,
) {
  const pkConditions = context.pkColumnNames.map((columnName, index) => `overlay.${columnName} = $${index + 1}`);
  const pkValues = context.pkColumnNames.map((columnName) => entityKey[columnName]);
  await db.query(
    `DELETE FROM ${context.overlayTable} AS overlay
     WHERE ${pkConditions.join(" AND ")}
       AND NOT EXISTS (
         SELECT 1 FROM ${context.journalTable} AS j
         WHERE j.entity_key_json = $${pkValues.length + 1}
           AND j.status IN ('pending', 'sending', 'failed')
       )`,
    [...pkValues, entityKeyJson],
  );
}

async function reconcileTable(db: MutationDb, context: TableContext) {
  // Idle fast-path. Reconcile only retires/clears journal rows in a terminal-clearable state — 'acked'
  // (clear the overlay once the echo lands) or 'conflicted' (retire once a later write resolved it). When
  // none exist — the steady state of an idle entity set — all three statements below are no-ops, so skip
  // the whole transaction. This matters because the convergence driver runs reconcile for EVERY writable
  // table on its interval (default 1.5s), and each CTE pays full PGlite plan+execute cost even against an
  // empty journal: left unguarded it is the dominant idle-CPU cost. The real-time cleanup path is the
  // <table>_reconcile_on_sync trigger; this bulk pass is a fallback, so skipping it when there is nothing
  // to clear changes no outcome. The guard is a single existence probe over the (small, usually empty)
  // journal.
  const work = await db.query<{ hasWork: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM " + context.journalTable + " WHERE status IN ('acked', 'conflicted')) AS \"hasWork\"",
  );
  if (work.rows[0]?.hasWork !== true) {
    return;
  }

  // The Convergence barrier (ADR-0010) gates the acked-row clearing below; the synced-table trigger
  // handles real-time cleanup, and this is the bulk recovery/fallback path that runs after every flush.
  await db.exec("BEGIN");

  try {
    // ADR-0015: retire a terminal `conflicted` row once the user has RESOLVED it — i.e. a LATER write
    // on the same entity has been acked (resolution is an ordinary new mutation). Without this, the old
    // conflicted row lingers forever: `<table>_sync_state.conflict_state` keeps surfacing the resolved
    // conflict and `diagnostics().conflictedCount` never drops. Run before the acked-clear below so the
    // resolving row is still present to supersede it. (`discardConflict` is the explicit throw-away path.)
    await db.query(
      "DELETE FROM " +
        context.journalTable +
        " AS conflicted " +
        "USING " +
        context.journalTable +
        " AS resolver " +
        "WHERE conflicted.status = 'conflicted' " +
        "AND resolver.entity_key_json = conflicted.entity_key_json " +
        "AND resolver.mutation_seq > conflicted.mutation_seq " +
        "AND resolver.status = 'acked'",
    );

    // Clear acknowledged non-delete mutations + matching overlays. ADR-0010: gated by the
    // Convergence barrier (same predicate as the trigger) — the acked write clears only once the
    // synced echo's Server version has reached its acked version. Joining the synced table makes
    // the comparison possible (and means an un-synced acked write is held until its echo lands).
    await db.query(
      "WITH cleared_journal AS (" +
        "DELETE FROM " +
        context.journalTable +
        " AS journal " +
        "USING " +
        context.syncedTable +
        " AS synced " +
        "WHERE journal.status = 'acked' " +
        "AND journal.server_updated_at_us IS NOT NULL " +
        "AND journal.mutation_kind <> 'delete' " +
        "AND " +
        buildColumnEquality(context.pkColumnNames, "journal", "synced") +
        " " +
        "AND " +
        buildOverlayResolutionBarrier(context.entry, { journalAlias: "journal", syncedAlias: "synced" }) +
        " " +
        "RETURNING journal.entity_key_json, " +
        context.pkColumnNames.map((cn) => "journal." + cn).join(", ") +
        ") " +
        "DELETE FROM " +
        context.overlayTable +
        " AS overlay " +
        "USING cleared_journal AS cj " +
        "WHERE " +
        buildColumnEquality(context.pkColumnNames, "overlay", "cj") +
        " " +
        "AND NOT EXISTS (" +
        "SELECT 1 FROM " +
        context.journalTable +
        " AS j " +
        "WHERE j.entity_key_json = cj.entity_key_json " +
        "AND j.status IN ('pending', 'sending', 'failed')" +
        ")",
    );

    // Clear acknowledged delete mutations where synced row is absent
    // Single compound CTE — PGlite does not support multi-statement query().
    await db.query(
      "WITH clearable_entities AS (" +
        "SELECT DISTINCT journal.entity_key_json, " +
        context.pkColumnNames.map((cn) => "journal." + cn).join(", ") +
        " FROM " +
        context.journalTable +
        " AS journal " +
        "LEFT JOIN " +
        context.syncedTable +
        " AS synced " +
        "ON " +
        buildColumnEquality(context.pkColumnNames, "journal", "synced") +
        " " +
        "WHERE journal.status = 'acked' " +
        "AND journal.mutation_kind = 'delete' " +
        "AND synced." +
        context.pkColumnNames[0] +
        " IS NULL" +
        "), " +
        "deleted_overlay AS (" +
        "DELETE FROM " +
        context.overlayTable +
        " AS overlay " +
        "USING clearable_entities AS ce " +
        "WHERE " +
        buildColumnEquality(context.pkColumnNames, "overlay", "ce") +
        ") " +
        "DELETE FROM " +
        context.journalTable +
        " AS journal " +
        "USING clearable_entities AS ce " +
        "WHERE " +
        buildColumnEquality(context.pkColumnNames, "journal", "ce") +
        " " +
        "AND journal.status = 'acked' " +
        "AND journal.mutation_kind = 'delete'",
    );
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
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
    "base_server_version",
    "replace_base_server_version",
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
      update.baseServerVersion ?? null,
      update.replaceBaseServerVersion ?? false,
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
          columnName === "base_server_version" ||
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
          columnName === "replace_server_updated_at_us" ||
          columnName === "replace_base_server_version"
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
        base_server_version = CASE
          WHEN updates.replace_base_server_version THEN updates.base_server_version::bigint
          ELSE journal.base_server_version
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
        base_server_version,
        replace_base_server_version,
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

function buildColumnEquality(columnNames: string[], leftAlias: string, rightAlias: string) {
  return columnNames.map((columnName) => `${leftAlias}.${columnName} = ${rightAlias}.${columnName}`).join(" AND ");
}

function qualifyLocalIdentifier(schemaName: string, tableName: string) {
  if (schemaName === "public") {
    // Quote-when-needed: a reserved-word or mixed-case table name (e.g. `group`)
    // MUST be quoted or the generated SQL fails to parse (ADR-0004). Normal names
    // stay bare, so existing generated SQL is unchanged.
    return maybeQuoteIdentifier(tableName);
  }

  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function buildJournalSequenceName(journalTable: string) {
  return `${journalTable}_mutation_seq`;
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

class MutationRequestError extends Error {
  readonly status: number;
  /** Per-mutation attribution the server returned for a structural rejection, or null. */
  readonly rejections: MutationRejection[] | null;

  constructor(message: string, status: number, rejections: MutationRejection[] | null = null) {
    super(message);
    this.name = "MutationRequestError";
    this.status = status;
    this.rejections = rejections;
  }
}

/**
 * Extract per-mutation attribution from a non-2xx batch-write body. The server names the
 * offending mutations on a structural (validation) rejection; an absent, non-JSON, or
 * empty-`rejections` body yields null, so the failure is treated as non-attributable
 * (whole batch stays retryable).
 */
function parseBatchRejections(body: string): MutationRejection[] | null {
  if (body.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const result = batchMutationErrorSchema.safeParse(parsed);
  const rejections = result.success ? result.data.rejections : undefined;
  return rejections && rejections.length > 0 ? rejections : null;
}
