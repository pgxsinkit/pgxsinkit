// Live-query setup-cost decomposition bench (ADR-0040 decision 5). Manually run — NOT part of the test
// suites: `bun scripts/bench-live-query-setup.ts`. It answers WHERE the ~400 ms live-query setup cost the
// GenreTV profiling saw actually lives — is `live.query` registration ≈ a plain execution of the same SQL,
// or is there large live-extension overhead on top? — before any nonzero keep-alive default is reconsidered.
//
// The MOTIVATING path is KEYLESS `live.query` — the React hooks never pass `pkColumns`, so that is the path a
// GenreTV-shaped hook takes. `live.incrementalQuery` (single-PK) is measured alongside as a COMPARISON only.
//
// Setup lanes, on an in-memory PGlite with a representative joined aggregate (empty AND ~1.5k result rows):
//   (a) plain `pglite.query(materialSql)` execution
//   (b) `live.query` registration end-to-end (KEYLESS — the motivating hook path)
//   (b') `live.incrementalQuery` registration end-to-end (single-PK — comparison)
//   (c) manager.subscribe on a fresh fingerprint, KEYLESS (registration + seed + first snapshot)
//   (c') manager.subscribe on a fresh fingerprint, single-PK (comparison)
//   (d) manager.subscribe joining an EXISTING entry (dedup hit — no registration)
//   (e) retained rejoin (resubscribe a kept-alive zero-subscriber entry)
//
// The write→diff propagation lane (1-vs-N subscribers, shared vs independent registrations) is OPT-IN via
// `--propagation` — it waits on real PGlite live-notification timing under writes, so it takes minutes and
// must never sit on a blocking path. Heap scaling stays in the perf lab (native memoryUsage would not model
// the browser/WASM deployment). See tmp/agents/live-query-setup-decomposition-results.md.

import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";

import { createLiveQueryManager, type LiveSubscriber } from "../packages/client/src/worker/live-query-manager";

const AGGREGATE_SQL = `
  select a.id as author_id, a.name as author_name,
         count(distinct b.id) as book_count,
         coalesce(avg(r.rating), 0)::float8 as avg_rating
  from author a
  left join book b on b.author_id = a.id
  left join review r on r.book_id = b.id
  group by a.id, a.name
  order by a.id
`;

const noopSubscriber: LiveSubscriber = { deliverInitial: () => {}, deliverDiff: () => {} };

async function createSchema(pg: PGlite): Promise<void> {
  await pg.exec(`
    create table author (id int primary key, name text not null);
    create table book (id int primary key, author_id int not null, title text not null);
    create table review (id int primary key, book_id int not null, rating int not null);
  `);
}

async function seed(pg: PGlite, authors: number): Promise<void> {
  if (authors === 0) return;
  const authorRows: string[] = [];
  const bookRows: string[] = [];
  const reviewRows: string[] = [];
  let bookId = 0;
  let reviewId = 0;
  for (let a = 1; a <= authors; a++) {
    authorRows.push(`(${a}, 'Author ${a}')`);
    for (let b = 0; b < 3; b++) {
      bookId++;
      bookRows.push(`(${bookId}, ${a}, 'Book ${bookId}')`);
      for (let r = 0; r < 2; r++) {
        reviewId++;
        reviewRows.push(`(${reviewId}, ${bookId}, ${1 + ((reviewId * 7) % 5)})`);
      }
    }
  }
  await pg.exec(`insert into author (id, name) values ${authorRows.join(",")};`);
  await pg.exec(`insert into book (id, author_id, title) values ${bookRows.join(",")};`);
  await pg.exec(`insert into review (id, book_id, rating) values ${reviewRows.join(",")};`);
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function timed(fn: () => Promise<void>, iterations: number): Promise<{ median: number; min: number }> {
  // One warm-up (JIT + PGlite lazy paths) before measuring.
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return { median: median(samples), min: Math.min(...samples) };
}

async function measure(authors: number): Promise<Record<string, { median: number; min: number }>> {
  const pg = await PGlite.create({ extensions: { live } });
  await createSchema(pg);
  await seed(pg, authors);

  // (a) plain execution.
  const plain = await timed(async () => {
    await pg.query(AGGREGATE_SQL);
  }, 15);

  // (b) KEYLESS live.query registration end-to-end (the motivating hook path).
  const liveQueryKeyless = await timed(async () => {
    const q = await pg.live.query(AGGREGATE_SQL, []);
    await q.unsubscribe();
  }, 15);

  // (b') live.incrementalQuery registration end-to-end (single-PK — comparison).
  const liveIncremental = await timed(async () => {
    const q = await pg.live.incrementalQuery(AGGREGATE_SQL, [], "author_id");
    await q.unsubscribe();
  }, 15);

  // (c) manager fresh KEYLESS subscribe (fresh manager each iteration so it is always a cold registration).
  const managerFreshKeyless = await timed(async () => {
    const manager = createLiveQueryManager({ live: pg.live });
    const sub = await manager.subscribe({ materialSql: AGGREGATE_SQL, params: [] }, noopSubscriber);
    await sub.unsubscribe();
    await manager.dispose();
  }, 15);

  // (c') manager fresh single-PK subscribe (comparison).
  const managerFreshPk = await timed(async () => {
    const manager = createLiveQueryManager({ live: pg.live });
    const sub = await manager.subscribe(
      { materialSql: AGGREGATE_SQL, params: [], pkColumns: ["author_id"] },
      noopSubscriber,
    );
    await sub.unsubscribe();
    await manager.dispose();
  }, 15);

  // (d) manager dedup-hit: a pre-existing (keyless) entry, measure the JOINING subscribe (no registration).
  const dedupManager = createLiveQueryManager({ live: pg.live });
  const anchor = await dedupManager.subscribe({ materialSql: AGGREGATE_SQL, params: [] }, noopSubscriber);
  const dedupHit = await timed(async () => {
    const sub = await dedupManager.subscribe({ materialSql: AGGREGATE_SQL, params: [] }, noopSubscriber);
    await sub.unsubscribe();
  }, 15);
  await anchor.unsubscribe();
  await dedupManager.dispose();

  // (e) retained rejoin: keep-alive holds the zero-subscriber (keyless) entry; measure the resubscribe.
  const retainManager = createLiveQueryManager({ live: pg.live, policy: { defaultKeepAliveMs: 60_000 } });
  const retainRejoin = await timed(async () => {
    const sub = await retainManager.subscribe({ materialSql: AGGREGATE_SQL, params: [] }, noopSubscriber);
    await sub.unsubscribe(); // retained (not torn) — the next iteration rejoins it
  }, 15);
  await retainManager.dispose();

  await pg.close();
  return {
    "(a) plain query": plain,
    "(b) live.query register [keyless — hook path]": liveQueryKeyless,
    "(b') live.incrementalQuery register [comparison]": liveIncremental,
    "(c) manager fresh subscribe [keyless]": managerFreshKeyless,
    "(c') manager fresh subscribe [single-PK comparison]": managerFreshPk,
    "(d) manager dedup hit": dedupHit,
    "(e) retained rejoin": retainRejoin,
  };
}

function printTable(label: string, results: Record<string, { median: number; min: number }>): void {
  console.log(`\n### ${label}`);
  console.log("| case | median (ms) | min (ms) |");
  console.log("| --- | ---: | ---: |");
  for (const [name, stat] of Object.entries(results)) {
    console.log(`| ${name} | ${stat.median.toFixed(2)} | ${stat.min.toFixed(2)} |`);
  }
}

// The write→diff propagation lane (`--propagation`): after a dependent-table write, how long until EVERY
// subscriber has its diff — one shared deduped registration fanning out to N, versus N independent
// registrations each rerunning the SQL. This is the write-side cost retention/dedup trades against. Heavy
// (real PGlite live-notification latency × N × iterations), so it is opt-in and expected to take minutes —
// run it in the background, never on a conversational blocking path.
async function measurePropagation(
  authors: number,
  fanout: number,
  iterations: number,
): Promise<Record<string, { median: number; min: number }>> {
  const makeCountingSubscriber = (onDiff: () => void): LiveSubscriber => ({
    deliverInitial: () => {},
    deliverDiff: () => onDiff(),
  });

  const run = async (independent: boolean): Promise<{ median: number; min: number }> => {
    const pg = await PGlite.create({ extensions: { live } });
    await createSchema(pg);
    await seed(pg, Math.max(authors, 1)); // at least one review row must exist to update
    const manager = createLiveQueryManager({ live: pg.live });
    let pendingResolve: (() => void) | null = null;
    let remaining = 0;
    const onDiff = () => {
      remaining--;
      if (remaining <= 0) pendingResolve?.();
    };
    const subs = [];
    for (let i = 0; i < fanout; i++) {
      // Independent mode defeats dedup with a per-subscriber SQL comment → N registrations, N reruns per
      // write. Shared mode subscribes the identical SQL → ONE registration fanning out to N.
      const sql = independent ? `${AGGREGATE_SQL} -- variant ${i}` : AGGREGATE_SQL;
      subs.push(await manager.subscribe({ materialSql: sql, params: [] }, makeCountingSubscriber(onDiff)));
    }
    let reviewId = 0;
    const stat = await timed(async () => {
      remaining = fanout;
      const settled = new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
      reviewId = (reviewId % 3) + 1;
      await pg.query(`update review set rating = 1 + ((rating) % 5) where id = ${reviewId}`);
      await settled; // resolves when the LAST subscriber has received its diff
    }, iterations);
    for (const sub of subs) await sub.unsubscribe();
    await manager.dispose();
    await pg.close();
    return stat;
  };

  return {
    [`shared registration, fan-out ${fanout}`]: await run(false),
    [`${fanout} independent registrations`]: await run(true),
  };
}

// The fixed journal columns the `pgxsinkit_all_mutations` status view unions:
// the shared columns MINUS payload_json/PK, mirroring ALL_MUTATIONS_JOURNAL_COLUMNS (schema.ts).
const JOURNAL_VIEW_COLUMNS = [
  "mutation_id",
  "entity_key_json",
  "mutation_seq",
  "mutation_kind",
  "status",
  "registry_version",
  "base_server_version",
  "write_unit",
  "write_mode",
  "attempt_count",
  "last_error",
  "last_http_status",
  "conflict_reason",
  "server_updated_at_us",
  "enqueued_at_us",
  "next_retry_at_us",
  "sent_at_us",
  "acked_at_us",
  "updated_at_us",
];

const SUMMARY_SQL = "select status, count(*)::int as count from pgxsinkit_all_mutations group by status";
const STATUSES = ["pending", "sending", "acked", "failed", "conflicted", "rejected", "quarantined"];

// Build `tables` journal-shaped tables + the UNION ALL `pgxsinkit_all_mutations` view, pre-seeded with
// `rowsPerTable` rows each, exactly the shape `client.mutations.subscribeSummary` reruns on every write.
async function createUnionRegistry(pg: PGlite, tables: number, rowsPerTable: number): Promise<void> {
  const branches: string[] = [];
  for (let t = 0; t < tables; t++) {
    const journal = `j${t}`;
    await pg.exec(`
      create table ${journal} (
        mutation_id uuid primary key,
        entity_key_json text not null,
        mutation_seq int not null,
        mutation_kind varchar(24) not null,
        status varchar(24) not null,
        registry_version text,
        base_server_version bigint,
        write_unit text,
        write_mode varchar(24),
        payload_json text not null,
        attempt_count int not null default 0,
        last_error text,
        last_http_status int,
        conflict_reason text,
        server_updated_at_us bigint,
        enqueued_at_us bigint not null,
        next_retry_at_us bigint,
        sent_at_us bigint,
        acked_at_us bigint,
        updated_at_us bigint not null
      );
      create index ${journal}_status_idx on ${journal} (status, enqueued_at_us);
    `);
    branches.push(`select '${journal}' as table_key, ${JOURNAL_VIEW_COLUMNS.join(", ")} from ${journal}`);

    const rows: string[] = [];
    for (let r = 0; r < rowsPerTable; r++) {
      const status = STATUSES[(t + r) % STATUSES.length];
      rows.push(`(gen_random_uuid(), '{"id":"${t}-${r}"}', ${r}, 'create', '${status}', '{}', ${r}, ${r}, ${r})`);
    }
    if (rows.length > 0) {
      await pg.exec(
        `insert into ${journal} (mutation_id, entity_key_json, mutation_seq, mutation_kind, status, payload_json, enqueued_at_us, updated_at_us, attempt_count) values ${rows.join(",")};`,
      );
    }
  }
  await pg.exec(`create temp view pgxsinkit_all_mutations as\n${branches.join("\nunion all\n")};`);
}

// The summary-subscription rerun cost under a write burst (slice 4's measurement requirement): ONE live
// summary subscription over the union view, then time how long from a journal write until the subscriber has
// its recomputed diff. This is the shared aggregate rerun `subscribeSummary` pays per relevant write.
async function measureUnionSummary(
  tables: number,
  rowsPerTable: number,
  iterations: number,
): Promise<Record<string, { median: number; min: number }>> {
  const pg = await PGlite.create({ extensions: { live } });
  await createUnionRegistry(pg, tables, rowsPerTable);
  const manager = createLiveQueryManager({ live: pg.live });

  let pendingResolve: (() => void) | null = null;
  const sub = await manager.subscribe(
    { materialSql: SUMMARY_SQL, params: [] },
    { deliverInitial: () => {}, deliverDiff: () => pendingResolve?.() },
  );

  let n = 0;
  const rerun = await timed(async () => {
    const settled = new Promise<void>((resolve) => {
      pendingResolve = resolve;
    });
    const journal = `j${n % tables}`;
    n++;
    await pg.query(
      `insert into ${journal} (mutation_id, entity_key_json, mutation_seq, mutation_kind, status, payload_json, enqueued_at_us, updated_at_us) values (gen_random_uuid(), '{"id":"burst-${n}"}', ${1000 + n}, 'create', 'pending', '{}', ${n}, ${n})`,
    );
    await settled; // resolves when the summary subscriber has its recomputed diff
  }, iterations);

  await sub.unsubscribe();
  await manager.dispose();
  await pg.close();
  return { [`summary rerun / write (${tables} tables × ${rowsPerTable} rows)`]: rerun };
}

async function main(): Promise<void> {
  console.log("Live-query setup-cost decomposition (ADR-0040 decision 5)");
  console.log(`Bun ${Bun.version}, @electric-sql/pglite in-memory`);
  if (process.argv.includes("--union-summary")) {
    // The registry-wide mutation-summary rerun cost (slice 4): the shared aggregate `subscribeSummary` reruns
    // per journal write. Small on purpose; expected ~tens of ms per write (per the ADR-0040 aggregate findings).
    for (const tables of [16, 50]) {
      printTable(
        `Union summary rerun, ${tables} writable tables (10 iterations)`,
        await measureUnionSummary(tables, 20, 10),
      );
    }
    return;
  }
  if (process.argv.includes("--propagation")) {
    // Opt-in heavy lane (see the note above measurePropagation) — minutes, run in the background.
    for (const fanout of [1, 10, 50]) {
      printTable(
        `Write→diff propagation, populated 1500, N=${fanout} (5 iterations)`,
        await measurePropagation(1500, fanout, 5),
      );
    }
    return;
  }
  const empty = await measure(0);
  printTable("Empty aggregate (0 authors → 0 result rows)", empty);
  const populated = await measure(1500);
  printTable("Populated aggregate (1500 authors → 1500 result rows)", populated);
  console.log("\n(write→diff propagation lane: opt-in via --propagation — heavy, run it in the background)");
  console.log("(union mutation-summary rerun lane: opt-in via --union-summary — slice 4 measurement)");
}

await main();
