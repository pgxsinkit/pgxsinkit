import { and, eq, like, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { type MutationDiagnostics, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { syncDebug } from "./debug";
import { getJournalTable, getLocalMetaTable } from "./local-tables";
import type { MutationDb } from "./mutation";
import {
  buildWipeLocalStoreSql,
  computeLocalSchemaFingerprint,
  generateLocalSchemaSql,
  LOCAL_SCHEMA_FINGERPRINT_KEY,
  REGISTRY_FINGERPRINT_KEY,
} from "./schema";

// Statements are AUTHORED as Drizzle builders over the meta-table object (rename-safe, typed,
// schema-qualification handled by the table object) and rendered to text+params here, because they
// EXECUTE through the caller's raw `MutationDb` seam — the one connection the mutation runtime and
// its tests own (and mock).
const metaQueryBuilder = drizzle.mock();

/** A boot-time registry-version reconciliation outcome (ADR-0006 drain-then-drop). */
export interface LocalStoreVersionEvent {
  status: "rebuilt" | "deferred";
  previousFingerprint: string;
  nextFingerprint: string;
  /** Mutations still owed to the server (pending + sending + failed + quarantined). */
  owedMutations: number;
}

/** The mutation-runtime surface required by registry reconciliation. */
interface VersionReconcileRuntime {
  registryVersion: string;
  readMutationStats: () => Promise<MutationDiagnostics>;
}

/** The registry fingerprint under which the local store was provisioned, or null if unstamped. */
export async function readStoredRegistryFingerprint(
  db: MutationDb,
  registry: SyncTableRegistry,
): Promise<string | null> {
  const meta = getLocalMetaTable(registry);
  const query = metaQueryBuilder
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, REGISTRY_FINGERPRINT_KEY))
    .limit(1)
    .toSQL();
  const result = await db.query<{ value: string }>(query.sql, query.params as unknown[]);

  return result.rows[0]?.value ?? null;
}

/** Meta-key prefix for a persisted `lazy + persistent` group activation (ADR-0021 §2). */
const LAZY_ACTIVATION_PREFIX = "lazy_active:";

/**
 * The consistency-group keys of `lazy + persistent` groups that were activated on a previous boot
 * (ADR-0021 §2). On boot these are promoted into the eager subscription set, so a once-activated durable
 * lazy group resumes permanently with no per-session re-evaluation. (`ephemeral` activation is never
 * persisted, so it never appears here.)
 */
export async function readActivatedLazyGroups(db: MutationDb, registry: SyncTableRegistry): Promise<Set<string>> {
  const meta = getLocalMetaTable(registry);
  const query = metaQueryBuilder
    .select({ key: meta.key })
    .from(meta)
    .where(like(meta.key, `${LAZY_ACTIVATION_PREFIX}%`))
    .toSQL();
  const result = await db.query<{ key: string }>(query.sql, query.params as unknown[]);
  return new Set(result.rows.map((row) => row.key.slice(LAZY_ACTIVATION_PREFIX.length)));
}

/** Upsert one meta key — the shared write shape for activations, schema identity, and safety markers. */
async function upsertMetaValue(db: MutationDb, registry: SyncTableRegistry, key: string, value: string): Promise<void> {
  const meta = getLocalMetaTable(registry);
  const query = metaQueryBuilder
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .toSQL();
  await db.query(query.sql, query.params as unknown[]);
}

/** Persist a `lazy + persistent` group's activation, so the next boot promotes it to eager (ADR-0021 §2). */
export async function writeLazyGroupActivation(
  db: MutationDb,
  registry: SyncTableRegistry,
  groupKey: string,
): Promise<void> {
  await upsertMetaValue(db, registry, `${LAZY_ACTIVATION_PREFIX}${groupKey}`, "1");
}

/** Clear a persisted lazy activation — an explicit `desync` reverts the group to dormant next boot (ADR-0021 §2). */
export async function clearLazyGroupActivation(
  db: MutationDb,
  registry: SyncTableRegistry,
  groupKey: string,
): Promise<void> {
  const meta = getLocalMetaTable(registry);
  const query = metaQueryBuilder
    .delete(meta)
    .where(eq(meta.key, `${LAZY_ACTIVATION_PREFIX}${groupKey}`))
    .toSQL();
  await db.query(query.sql, query.params as unknown[]);
}

/** Stamp the local store with the registry fingerprint it is provisioned under. */
export async function writeStoredRegistryFingerprint(
  db: MutationDb,
  registry: SyncTableRegistry,
  fingerprint: string,
): Promise<void> {
  await upsertMetaValue(db, registry, REGISTRY_FINGERPRINT_KEY, fingerprint);
}

/**
 * The durable-schema fingerprint the local store was last provisioned under, or null
 * when initial provisioning has not completed.
 */
export async function readStoredLocalSchemaFingerprint(
  db: MutationDb,
  registry: SyncTableRegistry,
): Promise<string | null> {
  const meta = getLocalMetaTable(registry);
  const query = metaQueryBuilder
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, LOCAL_SCHEMA_FINGERPRINT_KEY))
    .limit(1)
    .toSQL();
  const result = await db.query<{ value: string }>(query.sql, query.params as unknown[]);

  return result.rows[0]?.value ?? null;
}

/**
 * Stamp the durable-schema fingerprint the store is now provisioned under (slice 3). Called ONLY after a
 * successful durable-schema exec — every full durable exec (initial provisioning,
 * `dropReadCache`) and its stamp travel together, so the fingerprint never claims a schema that was not run.
 */
export async function writeStoredLocalSchemaFingerprint(
  db: MutationDb,
  registry: SyncTableRegistry,
  fingerprint: string,
): Promise<void> {
  await upsertMetaValue(db, registry, LOCAL_SCHEMA_FINGERPRINT_KEY, fingerprint);
}

/**
 * The durable recovery-required marker. Its
 * `pgxsinkit_local_meta` value is `"true"` while a `sending` journal row MAY have been committed since the
 * last clean settle, and `"false"` once pgxsinkit has PROVEN no `sending` row remains. Absent means the
 * store has not initialized the marker yet: run one conservative recovery pass, then initialize it.
 *
 * The invariant the whole slice protects: **the marker is never `"false"` while a committed `sending`
 * journal row exists.** It is upheld by marker-first ordering — {@link writeMutationRecoveryRequired}(true)
 * is awaited (and auto-commits) strictly BEFORE the first pending→sending transition of a dirty epoch — and
 * by the self-verifying clear ({@link clearMutationRecoveryMarkerIfSettled}), which only writes `"false"`
 * when NOT EXISTS any `sending` row across every writable journal.
 */
export const MUTATION_RECOVERY_REQUIRED_KEY = "mutation_recovery_required";

/**
 * Read the durable recovery-required marker: `true`/`false` for the stored value, or `null` when the key is
 * absent (the marker has not been initialized).
 *
 * FIX 4 (fail closed): the marker is a SAFETY marker — `false` is the ONLY value that skips recovery, so any
 * present value that is not exactly `"true"` or `"false"` (corruption, a future encoding, stray whitespace, a
 * partial/manual edit) must NOT be decoded as clean. It is logged on the debug rail and treated as `true`
 * (recovery required); the recovery pass then rewrites a well-formed value.
 */
export async function readMutationRecoveryRequired(
  db: MutationDb,
  registry: SyncTableRegistry,
): Promise<boolean | null> {
  const meta = getLocalMetaTable(registry);
  const query = metaQueryBuilder
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, MUTATION_RECOVERY_REQUIRED_KEY))
    .limit(1)
    .toSQL();
  const result = await db.query<{ value: string }>(query.sql, query.params as unknown[]);
  const value = result.rows[0]?.value;
  if (value == null) {
    return null;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  // Unexpected durable value → fail CLOSED: run recovery (which rewrites a well-formed marker afterward).
  syncDebug("mutation recovery marker has an unexpected value — treating as recovery-required (fail closed)", {
    value,
  });
  return true;
}

/**
 * Upsert the durable recovery-required marker to `"true"`/`"false"` unconditionally. The `true` write is the
 * marker-first SET (awaited before the first `sending` transition of a dirty epoch); the `false` write
 * initializes an absent marker AFTER a conservative recovery pass has guaranteed no `sending` row remains.
 */
export async function writeMutationRecoveryRequired(
  db: MutationDb,
  registry: SyncTableRegistry,
  required: boolean,
): Promise<void> {
  await upsertMetaValue(db, registry, MUTATION_RECOVERY_REQUIRED_KEY, required ? "true" : "false");
}

/** The writable (non-`readonly`) table keys of a registry — the journals a recovery/clear pass spans. */
function writableTableKeys(registry: SyncTableRegistry): string[] {
  return Object.keys(registry).filter((key) => registry[key]?.mode !== "readonly");
}

/**
 * Self-verifying clear: set the marker to `"false"` in ONE guarded, Drizzle-composed
 * statement — but only where NOT EXISTS any `sending` row in ANY writable journal (the EXISTS-union is built
 * from the registry's journal Drizzle objects via {@link getJournalTable}). Correct regardless of JS
 * bookkeeping: a concurrent enqueue that committed a `sending` row makes the guard fail, so the marker stays
 * `"true"`. Returns `{ cleared }` from the statement's affected-row count (PGlite reports `affectedRows`) —
 * `true` when the guard passed (an existing marker row flipped/held at `"false"`), `false` when a `sending`
 * row blocked it OR no marker row exists yet. Off the boot path AND at the end of a boot recovery pass.
 *
 * The marker row must already exist for this UPDATE to take effect; the absent-store INIT is a distinct
 * unconditional {@link writeMutationRecoveryRequired}(false) after the initialization pass (a pure guarded UPDATE
 * cannot create the row, and drizzle-rc.4 cannot render a from-less guarded insert-select).
 */
export async function clearMutationRecoveryMarkerIfSettled(
  db: MutationDb,
  registry: SyncTableRegistry,
): Promise<{ cleared: boolean }> {
  const meta = getLocalMetaTable(registry);
  const noSendingConditions = writableTableKeys(registry).map((key) => {
    const journal = getJournalTable(registry, key);
    return notExists(
      metaQueryBuilder
        .select({ one: sql`1` })
        .from(journal)
        .where(eq(journal.status, "sending")),
    );
  });
  const query = metaQueryBuilder
    .update(meta)
    .set({ value: "false" })
    .where(and(eq(meta.key, MUTATION_RECOVERY_REQUIRED_KEY), ...noSendingConditions))
    .toSQL();
  const result = (await db.query(query.sql, query.params as unknown[])) as { affectedRows?: number };
  return { cleared: (result.affectedRows ?? 0) > 0 };
}

/**
 * Reconcile a store created by a supported release against the current registry fingerprint. An unstamped
 * store is stamped; an unchanged fingerprint is a no-op. On a change, the read cache is rebuilt only when
 * no mutations are owed. Otherwise the rebuild is deferred until a later boot, preserving local writes.
 */
export async function reconcileLocalStoreVersion<TRegistry extends SyncTableRegistry>(args: {
  db: MutationDb;
  registry: TRegistry;
  runtime: VersionReconcileRuntime;
  onSchemaChange?: (event: LocalStoreVersionEvent) => void | Promise<void>;
}): Promise<LocalStoreVersionEvent | null> {
  const { db, registry, runtime } = args;
  const stored = await readStoredRegistryFingerprint(db, registry);
  const current = runtime.registryVersion;

  if (stored === current) {
    return null;
  }

  if (stored === null) {
    await writeStoredRegistryFingerprint(db, registry, current);
    return null;
  }

  return rebuildReadCacheOrDefer(args, stored);
}

/** Rebuild the read cache after a clean drain, or defer while mutations remain owed. */
async function rebuildReadCacheOrDefer<TRegistry extends SyncTableRegistry>(
  args: {
    db: MutationDb;
    registry: TRegistry;
    runtime: VersionReconcileRuntime;
    onSchemaChange?: (event: LocalStoreVersionEvent) => void | Promise<void>;
  },
  previousFingerprint: string,
): Promise<LocalStoreVersionEvent> {
  const { db, registry, runtime, onSchemaChange } = args;
  const current = runtime.registryVersion;
  const stats = await runtime.readMutationStats();
  const owedMutations = stats.pendingCount + stats.sendingCount + stats.failedCount + stats.quarantinedCount;

  if (owedMutations > 0) {
    const event: LocalStoreVersionEvent = {
      status: "deferred",
      previousFingerprint,
      nextFingerprint: current,
      owedMutations,
    };
    await onSchemaChange?.(event);
    return event;
  }

  await db.exec(buildWipeLocalStoreSql(registry));
  await db.exec(generateLocalSchemaSql(registry));
  await writeStoredRegistryFingerprint(db, registry, current);
  await writeStoredLocalSchemaFingerprint(db, registry, computeLocalSchemaFingerprint(registry));
  const event: LocalStoreVersionEvent = {
    status: "rebuilt",
    previousFingerprint,
    nextFingerprint: current,
    owedMutations: 0,
  };
  await onSchemaChange?.(event);
  return event;
}
