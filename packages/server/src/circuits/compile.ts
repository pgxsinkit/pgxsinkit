import { getTableConfig } from "drizzle-orm/pg-core";

import {
  conjoinPredicates,
  DENY_ALL_PREDICATE,
  isAndPredicate,
  isIsNullPredicate,
  isLeafPredicate,
  readShapeTier,
  type JwtClaims,
  type Predicate,
  type PredicateValue,
  type ShapeSpec,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import type { CreateShapeRequest } from "./wire";

/** What a client asks the control plane for: a declared shape, plus the inputs its tier consumes. */
export interface ShapeRequest {
  /** The shape's unique identity, exactly as declared. Never a table name the client chose. */
  shapeKey: string;
  /** Verified claims. The private tier's only subject input; the shared tier never sees them. */
  claims: JwtClaims | null;
  /**
   * SHARED TIER — the scope values, positionally matching the shape's declared `scope` columns.
   * `null` is a legal value and compiles to `IS NULL`, so an absent element and a null one are
   * different things: arity is checked strictly rather than padded.
   */
  scope?: readonly PredicateValue[];
  /** Deployment-supplied runtime params, handed to `rowFilter.customPredicate` as its second argument. */
  params?: Record<string, unknown>;
}

/**
 * The outcome of compiling a request. A denial is a first-class result rather than an exception
 * because it is an ordinary, expected outcome — an anonymous caller, a subject with no membership —
 * and because the caller's response to it (no handle, no shape, 403) is the same for every reason.
 */
export type CompiledShapeRequest =
  | { outcome: "create"; tier: "shared" | "private"; request: CreateShapeRequest }
  | { outcome: "deny"; reason: string };

/**
 * Resolve the entry a request selects by its **`shapeKey`** — not by table name, since several
 * shapes (a read projection and its owner) legitimately read one physical table under distinct keys.
 * Schema qualification is significant. Returns undefined when nothing declares that key, and the
 * caller fails closed.
 */
export function resolveEntryByShapeKey(registry: SyncTableRegistry, shapeKey: string): SyncTableEntry | undefined {
  return Object.values(registry).find((entry) => entry?.shape?.shapeKey === shapeKey);
}

/**
 * The physical table the engine reads.
 *
 * Circuits introspects `information_schema` with `table_schema = 'public'` and keys its tables by
 * bare name, so a schema-qualified registry target has no engine-side spelling. Rather than send a
 * name that would 404 deep inside shape creation, refuse here with the reason — a real limitation of
 * the engine, tracked against the fork, not something the control plane can paper over.
 */
function resolveShapeTarget(shape: ShapeSpec): { table: string } | { refusal: string } {
  const target = shape.physicalTable ?? shape.tableName;
  if (!target.includes(".")) return { table: target };
  const [schema] = target.split(".");
  if (schema === "public") return { table: target.slice("public.".length) };
  return {
    refusal:
      `shape "${shape.shapeKey}" reads "${target}", but the engine introspects the public schema ` +
      `only and names tables bare — a non-public target has no shape it can be created under.`,
  };
}

/**
 * The columns a shape EMITS, or undefined for the whole row.
 *
 * Read off `localTable` — the projected client-side table — rather than recomputed from
 * `omitColumns`, so the wire projection is by construction the same set the local schema declares.
 * A column the predicate matches on but the client never receives simply is not in it, which is what
 * makes `serverOnlyColumns` free here: the native API separates matching from emission, so the
 * ordering hazard the proxy had between egress rewriting and column omission has nothing to order.
 */
function emittedColumns(entry: SyncTableEntry): string[] | undefined {
  const explicit = entry.shape?.rowFilter?.columns;
  if (explicit != null && explicit.length > 0) return [...explicit];
  if (entry.clientProjection?.omitColumns == null) return undefined;
  return getTableConfig(entry.localTable).columns.map((column) => column.name);
}

/**
 * Compile a shape request into the engine's `POST /shapes` body, or a denial.
 *
 * The whole predicate is built here, in the control plane, from the registry — nothing predicate
 * shaped arrives on the wire. That is strictly stronger than the proxy's "discard the client's
 * `where`": there is no `where` on the wire to discard, so no parameter parsing to get right and no
 * grammar for a client to probe.
 */
export function compileShapeRequest(registry: SyncTableRegistry, request: ShapeRequest): CompiledShapeRequest {
  const entry = resolveEntryByShapeKey(registry, request.shapeKey);
  const shape = entry?.shape;
  if (entry == null || shape == null) {
    return { outcome: "deny", reason: `no shape declares shapeKey "${request.shapeKey}"` };
  }

  const target = resolveShapeTarget(shape);
  if ("refusal" in target) return { outcome: "deny", reason: target.refusal };

  const tier = readShapeTier(shape);
  const subject =
    tier === "shared" ? scopePredicate(shape, request.scope) : privatePredicate(shape, request.claims, request.params);
  if ("refusal" in subject) return { outcome: "deny", reason: subject.refusal };

  const where = conjoinPredicates(subject.predicate, shape.where);

  const narrowing = assertLocalPrimaryKeyIsPinned(entry, where);
  if (narrowing != null) return { outcome: "deny", reason: narrowing };

  const columns = emittedColumns(entry);

  return {
    outcome: "create",
    tier,
    request: {
      table: target.table,
      ...(where !== undefined ? { where } : {}),
      ...(columns !== undefined ? { columns } : {}),
    },
  };
}

/**
 * The shared tier's predicate: an `AND` of equalities over the declared scope columns, generated —
 * never authored. Every property the tier depends on comes from that generation. Two shapes of a
 * family cannot overlap, because a row carries one value per scope column. Two subscribers holding
 * the same scope values produce byte-identical requests, which is what lets Circuits collapse them
 * onto one stream and what makes the resulting stream cacheable at all.
 */
function scopePredicate(
  shape: ShapeSpec,
  values: readonly PredicateValue[] | undefined,
): { predicate: Predicate | undefined } | { refusal: string } {
  const columns = shape.scope ?? [];
  if (values == null) {
    return { refusal: `shape "${shape.shapeKey}" is shared-tier and requires ${columns.length} scope value(s)` };
  }
  if (values.length !== columns.length) {
    return {
      refusal:
        `shape "${shape.shapeKey}" takes ${columns.length} scope value(s) ` +
        `(${columns.join(", ")}) but got ${values.length}`,
    };
  }

  const equalities = columns.map((col, index): Predicate => {
    const value = values[index]!;
    // NULL is a scope value like any other, and `col = NULL` is UNKNOWN for every row — so the one
    // that would silently match nothing is the one that has to become `IS NULL`.
    return value === null ? { col, isNull: true } : { col, op: "eq", value };
  });

  return { predicate: conjoinPredicates(...equalities) };
}

/**
 * Every column pinned to exactly one value by a predicate's **top-level conjunction**.
 *
 * Conservative on purpose: only `col = value` and `col IS NULL` conjuncts pin, and only where they
 * sit in the outermost `AND` chain. A branch under `OR` or `NOT` admits more than one value for its
 * column by construction, and an `IN (subquery)` admits as many as the subquery returns — none of
 * those pin, so none are collected.
 */
function pinnedColumns(node: Predicate | undefined, into: Set<string> = new Set()): Set<string> {
  if (node == null) return into;
  if (isAndPredicate(node)) {
    for (const child of node.and) pinnedColumns(child, into);
    return into;
  }
  if (isIsNullPredicate(node)) {
    into.add(node.col);
    return into;
  }
  if (isLeafPredicate(node) && node.op === "eq") {
    into.add(node.col);
  }
  return into;
}

/**
 * Refuse a `clientProjection.localPrimaryKey` that narrows the server key without the predicate
 * pinning what it drops.
 *
 * The second of the two checks replacing ADR-0014's primary-key collision tripwire, and the one case
 * where a collision was never machinery at all. Narrowing is the point of `localPrimaryKey` — server
 * key `(owner_id, card_id)` becomes local key `(card_id)` because the caller only ever syncs their
 * own rows — and it is sound *exactly when* the shape's predicate admits one value for every dropped
 * column. Pinned, two server rows can never collapse onto one local key. Unpinned, they can, and the
 * client would silently keep whichever arrived last: under a plain INSERT that surfaced as a PK
 * collision, and under `upsert` it does not surface at all.
 *
 * Checked here rather than at `defineSyncTable` because the predicate is claims-dependent: what pins
 * `owner_id` is the subject fused into it, which does not exist until a real caller subscribes. The
 * refusal is therefore per-subscription, and lands at the same place and in the same form as every
 * other compile denial.
 */
function assertLocalPrimaryKeyIsPinned(entry: SyncTableEntry, where: Predicate | undefined): string | null {
  const localKey = entry.clientProjection?.localPrimaryKey?.columns;
  if (localKey == null || localKey.length === 0) return null;

  const localKeySet = new Set<string>(localKey);
  const dropped = entry.primaryKey.columns.filter((column) => !localKeySet.has(column));
  if (dropped.length === 0) return null;

  const pinned = pinnedColumns(where);
  const unpinned = dropped.filter((column) => !pinned.has(column));
  if (unpinned.length === 0) return null;

  return (
    `shape "${entry.shape!.shapeKey}" declares clientProjection.localPrimaryKey ` +
    `(${localKey.join(", ")}), dropping ${unpinned.join(", ")} from the server primary key ` +
    `(${entry.primaryKey.columns.join(", ")}) — but this caller's predicate does not pin ` +
    `${unpinned.length === 1 ? "that column" : "those columns"} to a single value, so two server rows ` +
    `could collapse onto one local key. Pin it with a top-level equality in the shape's rowFilter (or ` +
    `its scope), or widen localPrimaryKey to include it.`
  );
}

/** The private tier's predicate: the registry's own claims-fused filter, or a denial. */
function privatePredicate(
  shape: ShapeSpec,
  claims: JwtClaims | null,
  params: Record<string, unknown> | undefined,
): { predicate: Predicate | undefined } | { refusal: string } {
  const filter = shape.rowFilter?.customPredicate;
  if (filter == null) return { predicate: undefined };

  const resolved = filter(claims ?? {}, params);
  // Reference identity: a denied subject gets no shape at
  // all rather than an empty one, so nothing is created and nothing has to be torn down later.
  if (resolved === DENY_ALL_PREDICATE) {
    return { refusal: `shape "${shape.shapeKey}" denies this caller` };
  }
  return { predicate: resolved ?? undefined };
}
