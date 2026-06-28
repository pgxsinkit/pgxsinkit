import { is } from "drizzle-orm";
import { getTableConfig, getViewConfig, PgTable, PgView } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

/**
 * Lazy-relation safety (ADR-0021).
 *
 * A `lazy` relation is held out of the eager boot and only subscribed on first reference. The hazard
 * is a query reading it *before* it is hydrated — which silently returns empty/stale rows. This module
 * is the pure, React-free core that prevents that, with three layers that stack:
 *
 *  - **(A) build-time detection** ({@link createRecordingClient}) — a Proxy over the client's
 *    `views`/`tables` accessors records every relation reached *through the client* (any position:
 *    FROM, JOIN, subquery, WHERE). Blind only to relations imported as Drizzle objects directly.
 *  - **(C) structural detection** ({@link detectKeysFromBuilder}) — walks a Drizzle select builder's
 *    FROM + JOIN config. Catches directly-imported tables/views in those positions; blind to relations
 *    nested only in subqueries/WHERE.
 *  - **the tripwire** ({@link assertLazyRefsActivated}) — scans the *compiled* SQL (ground truth) for
 *    every lazy relation's physical name and throws if any referenced one is not active. This never
 *    misses a real reference; it is the guaranteed floor under both (A) and (C).
 *
 * (A) ∪ (C) drive precise *auto-activation* (no false positives → no spurious subscriptions); the
 * tripwire converts whatever they miss from a silent wrong result into a loud, actionable error.
 * Known residual gaps are enumerated in ADR-0021 → "Known limitations".
 */

/** Static index of a registry's lazy relations and the physical names they compile to. */
export interface LazyGuardIndex {
  /** Registry keys whose subscription timing is `lazy`. */
  readonly lazyKeys: ReadonlySet<string>;
  /** Physical relation name (synced table name and read-model view name, lowercased) → registry key. */
  readonly nameToKey: ReadonlyMap<string, string>;
  /** Per lazy key, the physical names (synced table + read-model view) to scan compiled SQL for. */
  readonly lazyNames: ReadonlyMap<string, readonly string[]>;
}

/** Build the {@link LazyGuardIndex} for a registry. Cheap and pure — cache it per client. */
export function buildLazyGuardIndex(registry: SyncTableRegistry): LazyGuardIndex {
  const lazyKeys = new Set<string>();
  const nameToKey = new Map<string, string>();
  const lazyNames = new Map<string, readonly string[]>();

  for (const [key, entry] of Object.entries(registry)) {
    const names: string[] = [];

    const tableName = getTableConfig(entry.table).name.toLowerCase();
    names.push(tableName);
    nameToKey.set(tableName, key);

    if (entry.view != null) {
      const viewName = getViewConfig(entry.view).name.toLowerCase();
      names.push(viewName);
      nameToKey.set(viewName, key);
    }

    if (entry.subscription === "lazy") {
      lazyKeys.add(key);
      lazyNames.set(key, names);
    }
  }

  return { lazyKeys, nameToKey, lazyNames };
}

/**
 * (C) Structural detection: the registry keys a Drizzle select builder references in its FROM and JOIN
 * positions, covering both base tables and read-model views. Cannot see relations that appear only in
 * subqueries or WHERE — those are the tripwire's job. Resilient to Drizzle internal-shape drift: an
 * unrecognised node is skipped, never thrown on (pinned by the lazy-guard tests).
 */
export function detectKeysFromBuilder(builder: unknown, index: LazyGuardIndex): Set<string> {
  const keys = new Set<string>();
  const config = readBuilderConfig(builder);
  if (config == null) return keys;

  addRelationKey(config.table, index, keys);
  for (const join of config.joins ?? []) {
    addRelationKey(join?.table, index, keys);
  }
  return keys;
}

interface BuilderConfigShape {
  readonly table?: unknown;
  readonly joins?: ReadonlyArray<{ readonly table?: unknown } | null | undefined>;
}

function readBuilderConfig(builder: unknown): BuilderConfigShape | null {
  if (builder == null || typeof builder !== "object") return null;
  const config = (builder as { config?: unknown }).config;
  if (config == null || typeof config !== "object") return null;
  return config as BuilderConfigShape;
}

function addRelationKey(node: unknown, index: LazyGuardIndex, keys: Set<string>): void {
  const name = relationName(node);
  if (name == null) return;
  const key = index.nameToKey.get(name);
  if (key != null) keys.add(key);
}

/** The physical name of a FROM/JOIN node, or null for anything that is not a plain table/view. */
function relationName(node: unknown): string | null {
  try {
    if (is(node, PgTable)) return getTableConfig(node).name.toLowerCase();
    if (is(node, PgView)) return getViewConfig(node).name.toLowerCase();
  } catch {
    // Defensive: an unrecognised/internal node shape must never crash detection — fall through to the
    // tripwire, which reads the compiled SQL.
    return null;
  }
  return null;
}

/** Minimal shape of the client wrapped by {@link createRecordingClient}. */
interface RecordableClient {
  readonly views?: Record<string, unknown>;
  readonly tables?: Record<string, unknown>;
}

/**
 * (A) Build-time detection: wrap a client so reading `c.views.x` / `c.tables.x` records the registry
 * key `x`. Returns the wrapped client to hand to the caller's `buildQuery`, plus the live `accessed`
 * set. React-agnostic — works for any build callback that reaches relations through the client.
 */
export function createRecordingClient<TClient extends RecordableClient>(
  client: TClient,
): { client: TClient; accessed: Set<string> } {
  const accessed = new Set<string>();

  const recordAccessors = <T extends object>(accessorMap: T): T =>
    new Proxy(accessorMap, {
      get(target, prop, receiver) {
        // Only own keys are registry relations; skip inherited props (`toString`, …) and symbols.
        if (typeof prop === "string" && Object.hasOwn(target, prop)) accessed.add(prop);
        return Reflect.get(target, prop, receiver);
      },
    });

  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "views" || prop === "tables") && value != null && typeof value === "object") {
        return recordAccessors(value as Record<string, unknown>);
      }
      return value;
    },
  });

  return { client: wrapped, accessed };
}

/**
 * The tripwire (ADR-0021): scan a COMPILED SQL string for the physical names of every lazy relation,
 * returning the lazy registry keys whose name appears. The compiled SQL is ground truth — a relation
 * Postgres will read must appear here — so this never misses a real reference. It errs toward
 * over-matching on a name that also appears in a string literal / column alias (the safe direction;
 * see ADR-0021 → "Known limitations").
 */
export function findReferencedLazyKeysInSql(sql: string, index: LazyGuardIndex): Set<string> {
  const found = new Set<string>();
  const haystack = sql.toLowerCase();
  for (const [key, names] of index.lazyNames) {
    if (names.some((name) => containsIdentifier(haystack, name))) found.add(key);
  }
  return found;
}

/** True if `name` appears in `haystack` as a whole identifier token (optionally double-quoted). */
function containsIdentifier(haystack: string, name: string): boolean {
  for (let from = 0; ; ) {
    const at = haystack.indexOf(name, from);
    if (at === -1) return false;
    if (!isIdentChar(haystack[at - 1]) && !isIdentChar(haystack[at + name.length])) return true;
    from = at + name.length;
  }
}

function isIdentChar(ch: string | undefined): boolean {
  if (ch == null) return false;
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
}

/**
 * Throw if a query references a lazy relation that is not active (ADR-0021). Converts the dangerous
 * silent failure — reading an un-hydrated lazy table and getting empty/stale rows — into a loud,
 * actionable error. Call after the auto-detected/declared lazy groups have been activated.
 */
export function assertLazyRefsActivated(args: {
  sql: string;
  index: LazyGuardIndex;
  isActive: (key: string) => boolean;
}): void {
  const referenced = findReferencedLazyKeysInSql(args.sql, args.index);
  const missing = [...referenced].filter((key) => !args.isActive(key));
  if (missing.length > 0) throw new LazyRelationNotActivatedError(missing);
}

/** Thrown by the tripwire ({@link assertLazyRefsActivated}) when a lazy relation is read while dormant. */
export class LazyRelationNotActivatedError extends Error {
  /** The lazy registry keys that were referenced but not active. */
  readonly relations: readonly string[];

  constructor(relations: readonly string[]) {
    const quoted = relations.map((r) => `"${r}"`).join(", ");
    super(
      `[pgxsinkit] query references lazy-synced relation(s) ${quoted} that are not active, so it would ` +
        `read empty/stale data (ADR-0021). Activate them first: use the safe facade — ` +
        `query({ use: [${quoted}], build }) / useLiveQuery({ use: [${quoted}], build }) — or call ` +
        `client.ensureSynced([${quoted}]). This fires when a lazy relation is reached in a way pgxsinkit ` +
        `cannot auto-detect (a subquery/WHERE reference, raw SQL, or a directly-imported Drizzle table). ` +
        `See "Known limitations" in ADR-0021.`,
    );
    this.name = "LazyRelationNotActivatedError";
    this.relations = relations;
  }
}
