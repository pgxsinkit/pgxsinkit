import {
  getSyncRegistrySchema,
  type MutationDiagnostics,
  quoteIdentifier,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import type { MutationDb } from "./mutation";
import { buildWipeLocalStoreSql, generateLocalSchemaSql, LOCAL_META_TABLE, REGISTRY_FINGERPRINT_KEY } from "./schema";

/**
 * The fingerprint-keyed local store (ADR-0006). The registry fingerprint the local PGlite
 * database was provisioned under is recorded in the local-meta table; comparing it to the
 * current fingerprint on boot is how a registry change is *detected* (rather than a
 * hand-bumped `idb://…-vN` suffix), which drives the drain-then-drop read-cache rebuild.
 */

/** A boot-time registry-version reconciliation outcome (ADR-0006 drain-then-drop). */
export interface LocalStoreVersionEvent {
  status: "rebuilt" | "deferred";
  previousFingerprint: string;
  nextFingerprint: string;
  /** Mutations still owed to the server (pending + sending + failed + quarantined). */
  owedMutations: number;
}

/** The minimal mutation-runtime surface the version reconciliation needs. */
interface VersionReconcileRuntime {
  registryVersion: string;
  readMutationStats: () => Promise<MutationDiagnostics>;
}

function metaTableRef(localSchema: string): string {
  return localSchema === "public"
    ? LOCAL_META_TABLE
    : `${quoteIdentifier(localSchema)}.${quoteIdentifier(LOCAL_META_TABLE)}`;
}

/** The registry fingerprint the local store was last provisioned under, or null if unstamped. */
export async function readStoredRegistryFingerprint(
  db: MutationDb,
  registry: SyncTableRegistry,
): Promise<string | null> {
  const meta = metaTableRef(getSyncRegistrySchema(registry));
  const result = await db.query<{ value: string }>(`SELECT value FROM ${meta} WHERE key = $1 LIMIT 1`, [
    REGISTRY_FINGERPRINT_KEY,
  ]);

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
  const meta = metaTableRef(getSyncRegistrySchema(registry));
  const result = await db.query<{ key: string }>(`SELECT key FROM ${meta} WHERE key LIKE $1`, [
    `${LAZY_ACTIVATION_PREFIX}%`,
  ]);
  return new Set(result.rows.map((row) => row.key.slice(LAZY_ACTIVATION_PREFIX.length)));
}

/** Persist a `lazy + persistent` group's activation, so the next boot promotes it to eager (ADR-0021 §2). */
export async function writeLazyGroupActivation(
  db: MutationDb,
  registry: SyncTableRegistry,
  groupKey: string,
): Promise<void> {
  const meta = metaTableRef(getSyncRegistrySchema(registry));
  await db.query(
    `INSERT INTO ${meta} (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [`${LAZY_ACTIVATION_PREFIX}${groupKey}`, "1"],
  );
}

/** Clear a persisted lazy activation — an explicit `desync` reverts the group to dormant next boot (ADR-0021 §2). */
export async function clearLazyGroupActivation(
  db: MutationDb,
  registry: SyncTableRegistry,
  groupKey: string,
): Promise<void> {
  const meta = metaTableRef(getSyncRegistrySchema(registry));
  await db.query(`DELETE FROM ${meta} WHERE key = $1`, [`${LAZY_ACTIVATION_PREFIX}${groupKey}`]);
}

/** Stamp the local store with the fingerprint it is now provisioned under. */
export async function writeStoredRegistryFingerprint(
  db: MutationDb,
  registry: SyncTableRegistry,
  fingerprint: string,
): Promise<void> {
  const meta = metaTableRef(getSyncRegistrySchema(registry));
  await db.query(
    `INSERT INTO ${meta} (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [REGISTRY_FINGERPRINT_KEY, fingerprint],
  );
}

/**
 * Reconcile the local store against the current registry fingerprint (ADR-0006). A fresh
 * (unstamped) store is stamped; an unchanged fingerprint is a no-op. On a change, the read
 * cache is dropped and rebuilt at the new shape **only when nothing is owed locally** —
 * otherwise the rebuild is deferred (and retried on a later boot) so un-flushed/quarantined
 * writes are never silently dropped. The drain happens across sessions: pending writes flush
 * and reconcile during normal use, and the rebuild completes once the journal is clear.
 *
 * An unstamped store is always treated as brand-new. There is no pre-fingerprint-store path:
 * the fingerprint mechanism shipped before launch, so every store in existence was
 * provisioned with it (and a stamped store's journal therefore always has `registry_version`).
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

/**
 * The drain-then-drop core (ADR-0006): rebuild the read cache at the current shape when
 * nothing is owed locally, otherwise defer so un-flushed/quarantined writes are never
 * dropped (the drain completes on a later boot).
 */
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
  const event: LocalStoreVersionEvent = {
    status: "rebuilt",
    previousFingerprint,
    nextFingerprint: current,
    owedMutations: 0,
  };
  await onSchemaChange?.(event);
  return event;
}
