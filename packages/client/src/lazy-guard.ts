import { getTableConfig, getViewConfig } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

/**
 * Lazy-relation safety (ADR-0021).
 *
 * A `lazy` relation is held out of the eager boot and only subscribed on first reference. The hazard is
 * a query reading it *before* it is hydrated — which silently returns empty/stale rows. This pure,
 * React-free core detects which lazy relations a query reads by scanning its **compiled** SQL, so the
 * caller can activate them (and hydrate-then-run) before the query executes.
 *
 * Why a single SQL scan is sufficient (and why there is no Proxy / builder-AST walk): Drizzle compiles
 * a query to parameterised SQL — values are bound (`$1`, `$2`), never inlined — and emits every relation
 * as a **quoted** identifier (`"name"`, or `"schema"."name"` when it carries a schema). So the compiled
 * SQL is ground truth: a relation the query reads must appear there by name, and the only things in the
 * text are quoted identifiers, keywords and `$n` placeholders. The index is built from the *same* Drizzle
 * objects that emit the SQL (`getTableConfig`/`getViewConfig`), so a token matches emission by
 * construction — schema and all. See "Known limitations" in ADR-0021 for the residual edges.
 */

/** Static index of a registry's synced relations and the exact quoted tokens their reads compile to. */
export interface LazyGuardIndex {
  /** Registry keys whose subscription timing is `lazy`. */
  readonly lazyKeys: ReadonlySet<string>;
  /**
   * Per lazy key, the exact quoted reference token(s) the compiled SQL emits when reading it: the synced
   * table (and, for readwrite, its read-model view) as `"name"` or `"schema"."name"` — or, for a read
   * PROJECTION (ADR-0025), its DISTINCT local identity (`localTable`, the `as` name) rather than the
   * owner's physical table. Schema-qualified when the Drizzle object carries a schema — which makes the
   * token collision-proof against bare aliases/CTEs.
   */
  readonly lazyTokens: ReadonlyMap<string, readonly string[]>;
  /**
   * EVERY synced relation key (eager AND lazy). {@link lazyKeys} is a subset. Drives the hydration
   * guarantee (ADR-0021/0032): a live subscription must gate `hydrating` on every consistency group it
   * reads, not only the lazy ones — an eager group can still be catching up on a cold boot.
   */
  readonly allKeys: ReadonlySet<string>;
  /**
   * Per synced key (eager AND lazy), the exact quoted reference token(s) its reads compile to — the same
   * token rules as {@link lazyTokens}, just spanning every subscription timing. {@link lazyTokens} is a
   * subset restricted to the lazy keys (activation stays lazy-only; hydration spans all).
   */
  readonly allTokens: ReadonlyMap<string, readonly string[]>;
}

/**
 * The exact quoted reference token(s) a compiled read of `entry` emits — the synced base table (and, for
 * readwrite, its read-model view), or a read PROJECTION's (ADR-0025) DISTINCT local identity. Shared by
 * the lazy-only and all-relations index builds so a token matches emission by construction.
 */
function tokensForEntry(entry: SyncTableRegistry[string]): string[] {
  const tokens: string[] = [];
  if (entry.readProjection) {
    // A read PROJECTION (defineReadProjection, ADR-0025) owns no physical table: its `entry.table` is the
    // OWNER's physical table, but a consumer reads it ONLY through its DISTINCT local identity
    // `entry.localTable` (the `as` name — where Electric syncs the projection's rows). Token that, NOT the
    // owner's physical name: a read of the projection's own local table then resolves to it, while a read of
    // the owner's table resolves the OWNER entry (which carries the owner token) without falsely resolving
    // this projection. (A projection is always readonly and has no read-model view.)
    const localTable = getTableConfig(entry.localTable);
    tokens.push(quotedRef(localTable.name, localTable.schema));
  } else {
    // A regular entry is read through the synced base table (and, for readwrite, its read-model view);
    // `entry.localTable` shares the base table's name here, so no extra token is needed.
    const table = getTableConfig(entry.table);
    tokens.push(quotedRef(table.name, table.schema));
    if (entry.view != null) {
      const view = getViewConfig(entry.view);
      tokens.push(quotedRef(view.name, view.schema));
    }
  }
  return tokens;
}

/** Build the {@link LazyGuardIndex} for a registry. Cheap and pure — cache it per client. */
export function buildLazyGuardIndex(registry: SyncTableRegistry): LazyGuardIndex {
  const lazyKeys = new Set<string>();
  const lazyTokens = new Map<string, readonly string[]>();
  const allKeys = new Set<string>();
  const allTokens = new Map<string, readonly string[]>();

  for (const [key, entry] of Object.entries(registry)) {
    const tokens = tokensForEntry(entry);
    allKeys.add(key);
    allTokens.set(key, tokens);
    // ACTIVATION stays lazy-only (ADR-0021): eager groups start at boot, so only lazy keys enter the lazy
    // maps the `prepareQuery`/`ensureSynced` guard scans. Hydration (all keys) is a superset.
    if (entry.subscription === "lazy") {
      lazyKeys.add(key);
      lazyTokens.set(key, tokens);
    }
  }

  return { lazyKeys, lazyTokens, allKeys, allTokens };
}

/** The quoted identifier Drizzle emits for a relation: `"schema"."name"` when schema-qualified, else `"name"`. */
function quotedRef(name: string, schema: string | undefined): string {
  return schema != null && schema.length > 0 ? `"${schema}"."${name}"` : `"${name}"`;
}

/**
 * The compiled-SQL scan: the lazy registry keys whose quoted reference token appears in `sql`. Because
 * the token is fully quoted it is self-delimiting (`"a"` cannot match inside `"ab"`), so a substring test
 * is exact. A *bare* token sitting in alias position (`… as "name"`, which Drizzle emits for `.as("name")`)
 * is excluded — the one realistic collision for a schema-less relation; a schema-qualified token cannot be
 * aliased and so needs no such guard.
 */
export function findReferencedLazyKeysInSql(sql: string, index: LazyGuardIndex): Set<string> {
  const found = new Set<string>();
  for (const [key, tokens] of index.lazyTokens) {
    if (tokens.some((token) => sqlReferencesToken(sql, token))) found.add(key);
  }
  return found;
}

/**
 * The compiled-SQL scan across EVERY synced relation (eager AND lazy): the registry keys whose quoted
 * reference token appears in `sql`. Same exact-token matching as {@link findReferencedLazyKeysInSql}, just
 * over {@link LazyGuardIndex.allTokens}. Drives the hydration guarantee — the caller maps each key to its
 * consistency group and gates a live subscription's `hydrating` on every group still catching up.
 */
export function findReferencedSyncedKeysInSql(sql: string, index: LazyGuardIndex): Set<string> {
  const found = new Set<string>();
  for (const [key, tokens] of index.allTokens) {
    if (tokens.some((token) => sqlReferencesToken(sql, token))) found.add(key);
  }
  return found;
}

function sqlReferencesToken(sql: string, token: string): boolean {
  for (let from = 0; ;) {
    const at = sql.indexOf(token, from);
    if (at === -1) return false;
    // Exclude an alias occurrence: `<expr> as "token"`. Only a bare token can be an alias, so this never
    // rejects a real (schema-qualified or FROM/JOIN) reference. Window comfortably covers Drizzle's ` as `.
    if (!/\bas\s+$/i.test(sql.slice(Math.max(0, at - 16), at))) return true;
    from = at + token.length;
  }
}

/**
 * The activation backstop (ADR-0021): throw if a query references a lazy relation that is still not
 * active. Called *after* the referenced lazy relations have been activated, so in the normal path every
 * scanned relation is now active and this passes. It fires only when activation could not make a
 * referenced relation active (a start that failed, or a lazy relation with no consistency group) —
 * converting a would-be silent empty/stale read into a loud error.
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

/** Thrown by the backstop ({@link assertLazyRefsActivated}) when a referenced lazy relation could not be activated. */
export class LazyRelationNotActivatedError extends Error {
  /** The lazy registry keys that were referenced but could not be activated. */
  readonly relations: readonly string[];

  constructor(relations: readonly string[]) {
    const quoted = relations.map((r) => `"${r}"`).join(", ");
    super(
      `[pgxsinkit] query references lazy-synced relation(s) ${quoted} that could not be activated (ADR-0021), ` +
        `so it would read empty/stale data. This is usually a failed initial sync or a lazy relation with no ` +
        `consistency group. Activate it explicitly — client.ensureSynced([${quoted}]) — or check the sync ` +
        `status. See "Known limitations" in ADR-0021.`,
    );
    this.name = "LazyRelationNotActivatedError";
    this.relations = relations;
  }
}
