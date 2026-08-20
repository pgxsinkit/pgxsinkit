import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { DENY_ALL_PREDICATE, type JwtClaims } from "./config";
import { isOrPredicate, type Predicate } from "./predicate";
import { getSyncRegistryRowClasses, type SyncTableEntry, type SyncTableRegistry } from "./registry";

/**
 * Registry invariants (ADR-0052): assert a claim about the RENDERED authorization artifacts of every entry
 * a classification binds, evaluated against named claims personas — the whole-registry counterpart to
 * `assertReadContractPreserved`'s per-table read-contract check.
 *
 * It exists because a privacy/visibility invariant spanning many entries drifts in two structural ways that
 * per-entry review cannot catch:
 *
 * 1. **Read/write asymmetry** — the shape's row filter and the Postgres RLS policies are two engines, so one
 *    can be tightened (or loosened) without the other. The assertion audits BOTH surfaces of every bound
 *    entry in one predicate, so "readable but unwritable" (or the reverse) is a test failure, not a bug report.
 * 2. **Under-enumeration** — an invariant expressed over a hand-maintained list of tables silently stops
 *    covering the registry the moment someone adds an entry. Binding by {@link SyncTableEntry.rowClass}
 *    inverts that: with a declared `rowClasses` vocabulary, a new entry cannot even be registered without
 *    being classified, so it joins its class's invariants by construction.
 *
 * It audits RESOLVED output, so it sees things the fingerprint structurally cannot (the `customPredicate`
 * BODY is a closure — only its presence and `RowFilterSpec.revision` are hashed). The trade: it sees exactly
 * the claims fixtures you give it, and nothing else.
 */

/**
 * Whether a predicate admits no row at all — the read half of "this persona sees nothing".
 *
 * Recognises the {@link DENY_ALL_PREDICATE} singleton by reference AND any structurally empty `or`,
 * because both are always-FALSE on the wire and an invariant is asking about the outcome, not about
 * which spelling produced it.
 */
export function deniesAllRows(predicate: Predicate | null): boolean {
  if (predicate === DENY_ALL_PREDICATE) return true;
  return predicate != null && isOrPredicate(predicate) && predicate.or.length === 0;
}

/** One rendered write policy on a bound entry's Postgres table, as the invariant predicate sees it. */
export interface RenderedPolicy {
  /** The policy name as declared (e.g. `widgets_select_owner_or_admin`). */
  name: string;
  /** The command the policy governs: `select` | `insert` | `update` | `delete`, or `all` when undeclared. */
  command: string;
  /** The `USING` predicate rendered to inline SQL text, or `null` when the policy declares none. */
  using: string | null;
  /** The `WITH CHECK` predicate rendered to inline SQL text, or `null` when the policy declares none. */
  withCheck: string | null;
}

/** One (entry × claims fixture) cell handed to a {@link RegistryInvariantSpec.holds} predicate. */
export interface RegistryInvariantCell {
  /** The entry's key in the registry. */
  key: string;
  entry: SyncTableEntry;
  /** The entry's classification, or `undefined` when it carries none (possible only for a `appliesTo` predicate). */
  rowClass: string | undefined;
  /** The fixture's name, as declared in {@link RegistryInvariantSpec.claimsFixtures}. */
  fixtureName: string;
  claims: JwtClaims;
  /**
   * The read predicate this entry resolves to FOR THESE CLAIMS — the real read pipeline's output, exactly
   * what the control plane compiles into the shape at subscribe.
   *
   * `null` means **unfiltered**, and covers both ways that arises: the entry declares no shape/`rowFilter`
   * at all, or its `customPredicate` returned `null` for these claims (the documented "bypass filtering,
   * every row is visible" answer — e.g. an admin persona). Both are the same statement about what the
   * client receives, which is what an invariant reasons about; distinguish them via
   * `entry.shape?.rowFilter` if a predicate genuinely needs to.
   *
   * An AST, not SQL text: an invariant matches on structure ({@link deniesAllRows}, the `isXPredicate`
   * guards) rather than on a rendered string that could drift on formatting alone.
   */
  readPredicate: Predicate | null;
  /** Every RLS policy attached to the entry's Postgres table, rendered to inline SQL text. */
  renderedPolicies: RenderedPolicy[];
}

export interface RegistryInvariantSpec {
  /** Human name for the invariant, used as the error header (e.g. "private rows never leave their owner"). */
  name: string;
  /**
   * Which entries the invariant binds: a list of {@link SyncTableEntry.rowClass} values (the normal form —
   * coverage then grows with the registry), or a predicate over the entry for the rare case a class cannot
   * express. When the registry declares its `rowClasses`, a class named here that is not in that vocabulary
   * throws immediately — a typo would otherwise bind nothing and pass vacuously.
   */
  appliesTo: readonly string[] | ((entry: SyncTableEntry, key: string) => boolean);
  /**
   * The claims personas the invariant is evaluated against, by name (`{ anonymous: {}, owner: {...} }`). Every
   * bound entry is checked against every fixture; the names appear in the failure report.
   */
  claimsFixtures: Record<string, JwtClaims>;
  /**
   * The invariant itself, over ONE (entry × fixture) cell's rendered artifacts. Return `true` when it holds,
   * `false` or a reason string when it does not — a reason string is reproduced verbatim in the error, so
   * prefer it.
   */
  holds: (cell: RegistryInvariantCell) => boolean | string;
}

// Policy predicates are rendered with values INLINED, matching how `CREATE POLICY` DDL carries them (and how
// supabase-rls.ts's own text builders render): a `$n` bind would be meaningless to compare against.
const policyDialect = new PgDialect();

function renderPolicyPredicate(fragment: SQL | undefined): string | null {
  return fragment == null ? null : policyDialect.sqlToQuery(fragment.inlineParams()).sql;
}

/**
 * The write policies attached to an entry's Postgres table, rendered to inline SQL text. Read straight off
 * drizzle's own table config, so it sees exactly what the migration will emit — including policies passed
 * through `defineSyncTable`'s `policies:`/`extras:` options, which are merged into the `pgTable` extras.
 *
 * A read PROJECTION's `table` IS its owner's, so a projection reports the OWNER's policies. That is correct:
 * a projection owns no table and adds no DDL, so the owner's policies are the ones governing its rows.
 */
function renderPolicies(entry: SyncTableEntry): RenderedPolicy[] {
  return getTableConfig(entry.table).policies.map((policy) => ({
    name: policy.name,
    // drizzle leaves `for` undefined when the policy does not narrow the command, which is Postgres's `ALL`.
    command: policy.for ?? "all",
    using: renderPolicyPredicate(policy.using),
    withCheck: renderPolicyPredicate(policy.withCheck),
  }));
}

/** The read predicate for these claims, through the real pipeline the control plane uses. */
function resolvePredicate(entry: SyncTableEntry, claims: JwtClaims): Predicate | null {
  return entry.shape?.rowFilter?.customPredicate?.(claims) ?? null;
}

function boundEntries(
  registry: SyncTableRegistry,
  appliesTo: RegistryInvariantSpec["appliesTo"],
): Array<[string, SyncTableEntry]> {
  const entries = Object.entries(registry) as Array<[string, SyncTableEntry]>;
  if (typeof appliesTo === "function") {
    return entries.filter(([key, entry]) => appliesTo(entry, key));
  }
  const classes = new Set(appliesTo);
  return entries.filter(([, entry]) => entry.rowClass != null && classes.has(entry.rowClass));
}

/**
 * Assert a {@link RegistryInvariantSpec} over a registry: for every entry the invariant binds, and every
 * claims fixture, evaluate `holds` against the entry's RENDERED read filter and write policies. Pure audit —
 * it renders through the production code paths but changes no runtime behaviour.
 *
 * Call it at module eval beside the registry (or in a test), the same way {@link assertReadContractPreserved}
 * is called, so a violation fails closed rather than shipping.
 *
 * ```ts
 * assertRegistryInvariant(registry, {
 *   name: "private rows are never visible to an anonymous caller",
 *   appliesTo: ["private"],
 *   claimsFixtures: { anonymous: {}, member: { sub: "u-1" } },
 *   holds: ({ fixtureName, readPredicate }) =>
 *     fixtureName !== "anonymous" || deniesAllRows(readPredicate) || "anonymous read is not denied",
 * });
 * ```
 *
 * Two deliberate fail-closed behaviours:
 * - An `appliesTo` class the registry's declared vocabulary does not contain throws immediately (a typo must
 *   not pass as "nothing to check").
 * - An invariant that binds ZERO entries throws. A spec that checks nothing is a bug in the spec — nearly
 *   always a wrong class name or an invariant left behind after its class was renamed — and silently passing
 *   is the exact failure mode this whole mechanism exists to remove.
 *
 * Every failing cell is collected and reported together: the header names the invariant, then one
 * `entry (fixture): reason` line per violation. Never first-failure-only — you fix a classification-wide
 * problem in one pass, not one re-run per entry.
 */
export function assertRegistryInvariant(registry: SyncTableRegistry, spec: RegistryInvariantSpec): void {
  const declaredClasses = getSyncRegistryRowClasses(registry);
  if (Array.isArray(spec.appliesTo) && declaredClasses != null) {
    const unknown = spec.appliesTo.filter((rowClass) => !declaredClasses.includes(rowClass));
    if (unknown.length > 0) {
      throw new Error(
        `registry invariant "${spec.name}" applies to unknown row class(es): ${unknown.join(", ")}. This ` +
          `registry declares [${declaredClasses.join(", ")}] — a misspelled class would bind no entries and ` +
          `pass vacuously, so it is rejected here.`,
      );
    }
  }

  const bound = boundEntries(registry, spec.appliesTo);
  if (bound.length === 0) {
    const binding = Array.isArray(spec.appliesTo) ? `row class(es) ${spec.appliesTo.join(", ")}` : "its predicate";
    throw new Error(
      `registry invariant "${spec.name}" binds no entries (${binding}). An invariant that checks nothing ` +
        `passes vacuously, which defeats the point — check the class name(s) against the entries' rowClass, ` +
        `or drop the invariant if its rows are gone.`,
    );
  }

  const fixtures = Object.entries(spec.claimsFixtures);
  if (fixtures.length === 0) {
    throw new Error(
      `registry invariant "${spec.name}" declares no claims fixtures: the invariant is evaluated per persona, ` +
        `so with none it checks nothing. Declare at least one (e.g. { anonymous: {} }).`,
    );
  }

  const violations: string[] = [];
  for (const [key, entry] of bound) {
    const renderedPolicies = renderPolicies(entry);
    for (const [fixtureName, claims] of fixtures) {
      const verdict = spec.holds({
        key,
        entry,
        rowClass: entry.rowClass,
        fixtureName,
        claims,
        readPredicate: resolvePredicate(entry, claims),
        renderedPolicies,
      });
      if (verdict === true) {
        continue;
      }
      violations.push(`${key} (${fixtureName}): ${typeof verdict === "string" ? verdict : "invariant does not hold"}`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `registry invariant "${spec.name}" is violated by ${violations.length} of ${bound.length * fixtures.length} ` +
        `checked cells:\n  ${violations.join("\n  ")}`,
    );
  }
}
