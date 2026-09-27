import type { Pgwasm, Transaction } from "@pgxsinkit/pgwasm";
import { drizzle, type PgwasmDatabase } from "@pgxsinkit/pgwasm/drizzle";

/**
 * A Drizzle handle whose executor is an already-open PGlite connection *or* an open PGlite
 * `Transaction` — the tier-① authoring/execution surface for the sync engine's metadata-store DML
 * (ADR-0028 decision 4).
 *
 * The blocker the old convertibility report cited was "`drizzle-orm/pglite` wraps only a PGlite
 * instance, not a Transaction". That is a *type* boundary, not a runtime one: drizzle's pglite session
 * layer only ever calls `client.query(sql, params, { rowMode, parsers })` on the wrapped client (verified
 * against drizzle-orm 1.0.0-rc.4 `pglite/session.js` — the executor touches nothing but `.query`; the
 * only other member it would reach is `.transaction`, and only if someone calls `db.transaction()`).
 * PGlite's `Transaction` exposes a `query` with the identical `(sql, params, options)` shape, so a handle
 * built over a `Transaction` executes every statement **on that transaction** — participating in the
 * engine's commit boundary rather than opening its own.
 *
 * The cast to `PGlite` is the narrowest honest one: at runtime the session only calls `.query`, which
 * both `PGliteInterface` and `Transaction` satisfy; the type just does not express that union. It is the
 * expected single-expression cast for this seam.
 *
 * CONTRACT: `.transaction()` on the returned handle is **forbidden**. The engine owns transaction
 * boundaries itself (`pg.transaction(async (tx) => …)` + explicit `tx.rollback()` on unsubscribe, sync
 * index.ts); calling `db.transaction()` here would (a) require the wrapped client to be a full PGlite,
 * which a `Transaction` is not, and (b) open a nested boundary the engine does not expect. Do not expose
 * or use it.
 *
 * pgwasm.s driver takes the database as its first argument; a `Transaction` carries the `query` the
 * session needs, hence the cast.
 */

// One drizzle handle per underlying connection/transaction object. The handle for a given `Transaction`
// is short-lived (one commit) but reused across the several metadata statements that run within that
// commit — the tag-store hot path — so memoizing per handle avoids re-wrapping on every statement while
// never leaking across transactions (a `Transaction` object is a fresh identity each commit, and the
// WeakMap drops it once the commit's closure is collected).
const handles = new WeakMap<Pgwasm | Transaction, PgwasmDatabase<never>>();

/** A (memoized) Drizzle handle over an open PGlite connection or transaction — engine-internal. */
export function drizzleOverPg(pg: Pgwasm | Transaction): PgwasmDatabase<never> {
  let db = handles.get(pg);
  if (!db) {
    db = drizzle(pg as unknown as Pgwasm) as PgwasmDatabase<never>;
    handles.set(pg, db);
  }
  return db;
}
