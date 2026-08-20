import { getColumnTable, getTableName, type AnyColumn } from "drizzle-orm";

/**
 * The **native predicate AST** — the wire form a shape's `where` takes on the Circuits-native read
 * path (ADR-0055), replacing the Electric path's SQL `where` **text**.
 *
 * This matters beyond serialization. The Electric path compiled a Drizzle `SQL` fragment down to a
 * string that the engine then re-lexed (`where_sql.rs`); the native path never produces text at all,
 * so there is no lexer on our path and no grammar to keep two implementations agreeing on. It is
 * also what makes the repo's SQL-tier rule reachable at tier ① here: authoring is real column
 * objects and typed values end to end, with no string to escape and nothing to interpolate.
 *
 * These types mirror `@electric-circuits/protocol`'s `Predicate` union exactly. They are restated
 * rather than imported: this is the wire contract pgxsinkit commits to, the protocol package is
 * alpha, and a published library should not put an alpha peer in its public types. Any divergence
 * is a bug here — the engine's serde definitions are authoritative.
 */
export type PredicateValue = string | number | boolean | null;

/** Comparison operators for a leaf predicate. */
export type PredicateLeafOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

/** `col <op> value`. Three-valued: never TRUE on a NULL cell — use {@link IsNullPredicate} for that. */
export interface LeafPredicate {
  col: string;
  op: PredicateLeafOp;
  value: PredicateValue;
}

/**
 * `col IS NULL` / `col IS NOT NULL`. A separate leaf because it is the one test that is TRUE on a
 * NULL cell, and the only two-valued one — so it is also the only leaf that composes soundly under
 * {@link NotPredicate}.
 */
export interface IsNullPredicate {
  col: string;
  isNull: boolean;
}

export interface AndPredicate {
  and: Predicate[];
}

export interface OrPredicate {
  or: Predicate[];
}

export interface NotPredicate {
  not: Predicate;
}

/**
 * The inner half of an `IN` test: the set of `project` values over `table`'s rows matching `where`.
 * `where` may itself contain subquery leaves. Single column only — the engine has no composite
 * `(a, b) IN (…)`. Subqueries must stay **uncorrelated**: the inner `where` references the inner
 * table's columns only, never the outer row's.
 */
export interface SubqueryRef {
  table: string;
  project: string;
  where?: Predicate;
}

/**
 * `outer.col IN (SELECT project FROM table WHERE …)`, or `NOT IN` when `negated`. The engine
 * maintains the inner set incrementally and shares it across every shape referencing the same
 * subquery, which is why an entitlement-shaped subquery costs one index rather than one per shape.
 */
export interface InSubqueryPredicate {
  col: string;
  in: SubqueryRef;
  negated?: boolean;
}

/** A restricted boolean predicate over one table's columns, plus single-column `IN`/`NOT IN`. */
export type Predicate =
  | LeafPredicate
  | IsNullPredicate
  | AndPredicate
  | OrPredicate
  | NotPredicate
  | InSubqueryPredicate;

export function isLeafPredicate(node: Predicate): node is LeafPredicate {
  return "col" in node && "op" in node;
}
export function isIsNullPredicate(node: Predicate): node is IsNullPredicate {
  return "col" in node && "isNull" in node;
}
export function isAndPredicate(node: Predicate): node is AndPredicate {
  return "and" in node;
}
export function isOrPredicate(node: Predicate): node is OrPredicate {
  return "or" in node;
}
export function isNotPredicate(node: Predicate): node is NotPredicate {
  return "not" in node;
}
export function isInSubqueryPredicate(node: Predicate): node is InSubqueryPredicate {
  return "in" in node && "col" in node;
}

/**
 * Values reach the engine as JSON scalars, so a Drizzle column whose TS type is richer than the
 * four Circuits column types (`int`/`text`/`bool`/`float`) has no automatic rendering here.
 *
 * `Date` is the case that actually turns up, and it is deliberately **not** coerced: a timestamp
 * column syncs as `text`, and JS's ISO rendering is not Postgres's, so a silent `toISOString()`
 * would produce a predicate that compares unequal to every row it was meant to match. Render it the
 * way the column does and pass the string.
 */
function assertPredicateValue(column: AnyColumn, value: unknown): asserts value is PredicateValue {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return;

  const shown = value instanceof Date ? "Date" : kind === "object" ? "object" : kind;
  throw new Error(
    `[pgxsinkit] predicate on "${column.name}": ${shown} is not a predicate value — the wire form ` +
      `carries JSON scalars (string | number | boolean | null). Render it to the text form the ` +
      `column itself stores and pass that, rather than relying on a coercion that may not match.`,
  );
}

function leaf(column: AnyColumn, op: PredicateLeafOp, value: PredicateValue): LeafPredicate {
  assertPredicateValue(column, value);
  return { col: column.name, op, value };
}

/**
 * The predicate builder — the tier-① authoring surface for a native `where`.
 *
 * Deliberately namespaced rather than exported as bare `eq`/`and`/`or`/`not`, which would collide
 * with `drizzle-orm`'s operators of the same names in exactly the files that use both (a registry
 * authoring RLS policies with Drizzle's `eq` and a shape `where` with this one). The shapes are
 * intentionally the same so the two read alike; only the AST-versus-`SQL` return type differs.
 *
 * ```ts
 * where: (c) => p.and(p.eq(c.published, true), p.isNotNull(c.releasedAt))
 * ```
 */
export const p = {
  eq: (column: AnyColumn, value: PredicateValue): LeafPredicate => leaf(column, "eq", value),
  ne: (column: AnyColumn, value: PredicateValue): LeafPredicate => leaf(column, "neq", value),
  lt: (column: AnyColumn, value: PredicateValue): LeafPredicate => leaf(column, "lt", value),
  lte: (column: AnyColumn, value: PredicateValue): LeafPredicate => leaf(column, "lte", value),
  gt: (column: AnyColumn, value: PredicateValue): LeafPredicate => leaf(column, "gt", value),
  gte: (column: AnyColumn, value: PredicateValue): LeafPredicate => leaf(column, "gte", value),

  isNull: (column: AnyColumn): IsNullPredicate => ({ col: column.name, isNull: true }),
  isNotNull: (column: AnyColumn): IsNullPredicate => ({ col: column.name, isNull: false }),

  and: (...nodes: Predicate[]): AndPredicate => ({ and: nodes }),
  or: (...nodes: Predicate[]): OrPredicate => ({ or: nodes }),
  not: (node: Predicate): NotPredicate => ({ not: node }),

  /**
   * The inner set for an `IN` test, named by the column it projects — the table is read off that
   * column, so there is no table name to get wrong and no way to project a column the named table
   * does not have.
   */
  subquery: (projected: AnyColumn, where?: Predicate): SubqueryRef => ({
    table: getTableName(getColumnTable(projected)),
    project: projected.name,
    ...(where !== undefined ? { where } : {}),
  }),

  in: (column: AnyColumn, ref: SubqueryRef): InSubqueryPredicate => ({ col: column.name, in: ref }),
  notIn: (column: AnyColumn, ref: SubqueryRef): InSubqueryPredicate => ({
    col: column.name,
    in: ref,
    negated: true,
  }),
} as const;

/**
 * Conjoin, dropping absent branches and collapsing the trivial cases. `undefined` when nothing is
 * left, which is the AST's own spelling of "all rows" (an omitted `where`) — so a caller never has
 * to invent an always-true leaf to stand in for one.
 */
export function conjoinPredicates(...nodes: (Predicate | undefined)[]): Predicate | undefined {
  const present = nodes.filter((node): node is Predicate => node !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { and: present };
}
