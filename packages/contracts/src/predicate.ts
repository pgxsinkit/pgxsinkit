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

/**
 * Comparison operators for a leaf predicate.
 *
 * `like` is SQL `LIKE`: case-sensitive, `%` = any sequence, `_` = any single char. There is no
 * `notLike` op — the engine models it as `Not(Like)`, which is what {@link p.notLike} builds.
 */
export type PredicateLeafOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "like";

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
export interface SubqueryRef<TValue extends PredicateValue = PredicateValue> {
  table: string;
  project: string;
  where?: Predicate;
  /**
   * Phantom: the projected column's value type, carried so {@link p.in} can require the OUTER column
   * to be comparable with what the subquery actually projects. Never serialized — it is a type-level
   * marker only, which is why it is optional and never read.
   */
  readonly __value?: TValue;
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

/**
 * What a builder accepts, versus {@link PredicateValue} (what goes on the wire).
 *
 * `bigint` is admitted because the toolkit's own timestamp convention is a **microsecond BIGINT**, so
 * comparing against one is ordinary rather than exotic. It is narrowed to a number by `toWireValue`
 * rather than widening the wire type: Postgres `bigint` is `ColumnType::Int` to the engine, which reads
 * the JSON scalar as an `i64` — a decimal *string* would be rejected against an int column.
 */
export type PredicateValueInput = PredicateValue | bigint;

/** A column's TypeScript value type, as Drizzle carries it on the column object. */
type ColumnData<TCol extends AnyColumn> = TCol["_"]["data"];

type IsAny<T> = 0 extends 1 & T ? true : false;
/**
 * Whether a column's value type is statically unknowable — `any`, or the `unknown` that Drizzle's
 * erased column paths (`getColumns`, `PgBuildExtraConfigColumns`) yield. Those must stay PERMISSIVE:
 * narrowing an unknowable type through `Extract` collapses it to `never`, which would refuse every
 * comparison on a column the author cannot re-type.
 */
type IsUnknownData<T> = IsAny<T> extends true ? true : unknown extends T ? true : false;

/**
 * What may be compared against `TCol` — the column's OWN value type, narrowed to what this wire can
 * carry, plus `null` when the column is nullable.
 *
 * `Extract` is what refuses a column whose values have no scalar form at all: a `jsonb` column typed
 * as an object, or a `timestamp` column typed as `Date`, resolves to `never` here, so the comparison
 * is a compile error rather than the runtime throw it used to be. And because a `pgEnum` column's
 * data type is the literal union of its labels, a mistyped label is caught too — something the SQL
 * text form could never see.
 */
export type ColumnValue<TCol extends AnyColumn> =
  IsUnknownData<ColumnData<TCol>> extends true
    ? PredicateValueInput
    : Extract<ColumnData<TCol>, PredicateValueInput> | (TCol["_"]["notNull"] extends true ? never : null);

/**
 * Narrow a builder input to its wire form, refusing the one conversion that would be silently wrong.
 *
 * A `bigint` past `Number.MAX_SAFE_INTEGER` cannot survive the trip: JSON's only integer carrier here
 * is a JS `number` (an IEEE double), so serializing it would round to a nearby value and the predicate
 * would compare unequal to the row it was written for. Microsecond timestamps sit comfortably inside
 * the safe range, so this throws only for a value that genuinely cannot be expressed.
 */
function toWireValue(column: AnyColumn, value: PredicateValueInput): PredicateValue {
  if (typeof value !== "bigint") {
    assertPredicateValue(column, value);
    return value;
  }

  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(
      `[pgxsinkit] predicate on "${column.name}": ${value}n is outside the exactly-representable ` +
        `integer range, so serializing it would silently round to a different value. Compare against ` +
        `a value inside the safe-integer range, or split the test.`,
    );
  }
  return Number(value);
}

function leaf<TCol extends AnyColumn>(column: TCol, op: PredicateLeafOp, value: ColumnValue<TCol>): LeafPredicate {
  return { col: column.name, op, value: toWireValue(column, value as PredicateValueInput) };
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
  eq: <TCol extends AnyColumn>(column: TCol, value: ColumnValue<TCol>): LeafPredicate => leaf(column, "eq", value),
  ne: <TCol extends AnyColumn>(column: TCol, value: ColumnValue<TCol>): LeafPredicate => leaf(column, "neq", value),
  lt: <TCol extends AnyColumn>(column: TCol, value: ColumnValue<TCol>): LeafPredicate => leaf(column, "lt", value),
  lte: <TCol extends AnyColumn>(column: TCol, value: ColumnValue<TCol>): LeafPredicate => leaf(column, "lte", value),
  gt: <TCol extends AnyColumn>(column: TCol, value: ColumnValue<TCol>): LeafPredicate => leaf(column, "gt", value),
  gte: <TCol extends AnyColumn>(column: TCol, value: ColumnValue<TCol>): LeafPredicate => leaf(column, "gte", value),

  /** SQL `LIKE` (case-sensitive; `%` = any sequence, `_` = any single char). Text columns only. */
  like: <TCol extends AnyColumn<{ data: string }>>(column: TCol, pattern: string): LeafPredicate =>
    leaf(column, "like", pattern as ColumnValue<TCol>),
  /** SQL `NOT LIKE`. The engine has no negated-like op; it models it as `Not(Like)`, so this does too. */
  notLike: <TCol extends AnyColumn<{ data: string }>>(column: TCol, pattern: string): NotPredicate => ({
    not: leaf(column, "like", pattern as ColumnValue<TCol>),
  }),

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
  subquery: <TCol extends AnyColumn>(
    projected: TCol,
    where?: Predicate,
  ): SubqueryRef<Extract<ColumnValue<TCol>, PredicateValue>> => ({
    table: getTableName(getColumnTable(projected)),
    project: projected.name,
    ...(where !== undefined ? { where } : {}),
  }),

  in: <TCol extends AnyColumn>(
    column: TCol,
    ref: SubqueryRef<Extract<ColumnValue<TCol>, PredicateValue>>,
  ): InSubqueryPredicate => ({ col: column.name, in: ref }),
  notIn: <TCol extends AnyColumn>(
    column: TCol,
    ref: SubqueryRef<Extract<ColumnValue<TCol>, PredicateValue>>,
  ): InSubqueryPredicate => ({
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
