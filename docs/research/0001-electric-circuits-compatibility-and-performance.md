# Electric Circuits compatibility and performance investigation

**Question.** Can Electric Circuits + Durable Streams become the FOSS sync-core substrate beneath
pgxsinkit — replacing the Electric sync service — without abandoning PGlite or redesigning the
write/offline architecture? What would it require, and what fan-out characteristics would pgxsinkit
actually get?

> **Status note (added at commit).** This report measures Circuits through its **Electric
> compatibility adapter** (`GET /v1/shape`), because that is what pgxsinkit spoke at the time. The
> direction chosen afterwards is to target Circuits' **native** API instead (`POST /shapes` with a
> predicate AST, reads served from durable-streams). That path does not execute `electric.rs` at all,
> so the four defects below — and the `where`-clause shim — are not obstacles on it; they are fixes
> for compat consumers, and have been contributed upstream. The **measurements** (fan-out, memory per
> shape, cold-boot, propagation) are engine-level and carry over unchanged.

---

## Executive result

> **Viable with small fixes.**

Every defect found is in Circuits' **Electric compatibility adapter** (`apps/engine/src/electric.rs`),
not in its dataflow core. Four patches totalling **79 added lines in one file** turn every failing
scenario green: the three suites that failed un-patched (`client-contract`, `membership-fanout`,
`lazy-activation`) all pass, and the full sweep is **30 pass / 0 fail across 9 suites**, repeated on
the release build. Circuits' own 178 engine unit tests stay green and no upstream contract was broken.

The evidence for "viable":

- pgxsinkit's **client architecture is unchanged**. No client source was modified. The only pgxsinkit
  change is a 72-line, env-gated `where`-clause shim in the server proxy — and even that exists only
  because of an upstream lexer gap that should be fixed upstream instead.
- The correctness scenarios that matter — cross-table authorization, membership fan-in/fan-out (live
  and across an offline gap), transactional membership swaps, warm-store resume, mutation echo — all
  pass, on the **subquery** shapes pgxsinkit actually uses.
- On pgxsinkit's real workload (one distinct shape per user) Circuits uses **4.8× less memory per
  shape**, creates shapes **8.7× faster**, and reaches interactive **9.5× faster** on a 10 000-row cold
  boot, at equal or better propagation latency.

The evidence for "with small fixes" rather than "now": three of the four patches are load-bearing.
Un-patched Circuits **silently loses row-eviction on revocation** — a stale-authorization bug, the most
serious finding here. It must be fixed upstream before Circuits is a candidate.

This is a **compatibility-layer maturity** verdict, not an architectural one. Nothing found suggests
DBSP, the subquery registry, the membership semantics or Durable Streams are unsuited to pgxsinkit.

---

## Tested revisions

| Component           | Version / SHA                             | Notes                                     |
| ------------------- | ----------------------------------------- | ----------------------------------------- |
| pgxsinkit           | `add02ea` (2026-08-18)                    | 1 modified file (proxy shim), uncommitted |
| electric-circuits   | `b784aaf` (2026-07-23)                    | + 4 investigation patches, working tree   |
| durable-streams     | `a172acc3` (2026-07-16)                   | server binary from `~/.cargo/bin`         |
| Electric (baseline) | `electricsql/electric:1.7.11`             | subquery flags enabled                    |
| Postgres            | `supabase/postgres:17.6.1.116`            | pgxsinkit's real migrations + seed        |
| Rust                | 1.96.0 (pinned via `rust-toolchain.toml`) | see build notes                           |
| Bun                 | 1.3.14                                    |                                           |

Raw results, probes and harnesses: `tmp/agents/circuits/` (W1–W11 documents + scripts). Patches:
`tmp/agents/circuits/circuits-all-patches.patch`.

---

## Architectures

**Today (Electric):**

```
Postgres ──logical replication──> Electric (Elixir)
                                    │  shape log + snapshot, /v1/shape
                                    ▼
                          pgxsinkit proxy (sole shape authority, ADR-0003)
                                    ▼
                          @electric-sql/client MultiShapeStream
                                    ▼
                    pgxsinkit read path (ADR-0009/0014) ──> PGlite
```

**Candidate (Circuits + DS):**

```
Postgres ──logical replication──> Circuits ingestor
                                    │ appends ONE ordered `changes` stream
                                    ▼
                            Durable Streams  ──── one `shape/<id>` stream per distinct shape
                                    ▲                        │
                    DBSP circuits + subquery registry ───────┘
                                    │  /v1/shape compatibility adapter (electric.rs)
                                    ▼
                          pgxsinkit proxy ──> unchanged client ──> PGlite
```

The substitution is confined to the box above the proxy. pgxsinkit's proxy, client, journal, overlay
and PGlite apply path are untouched.

---

## The 27 questions (§24)

### Compatibility

**1. Can current pgxsinkit use Circuits through `/v1/shape` without changing its client architecture?**
**Yes.** No client-side source was changed. The full suite passes with the stock client.

**2. Can the existing `@electric-sql/client`-based code communicate with Circuits successfully?**
**Yes, after patch 3.** Un-patched it cannot complete a warm-store resume: the vanilla upstream
`ShapeStream` — with no pgxsinkit involved — errors with _"didn't include the following required
headers: electric-schema"_, delivers zero messages and never reaches up-to-date.

**3. What source/configuration changes are required?**

| #   | Change                                                                                                    | Where           | Size       | Load-bearing?                                                   |
| --- | --------------------------------------------------------------------------------------------------------- | --------------- | ---------- | --------------------------------------------------------------- |
| 1   | `StreamFold` dedup — a key that leaves and re-enters a shape was emitted twice, duplicating snapshot rows | `electric.rs`   | ~6 lines   | **Yes** — caused total data loss via the COPY tier              |
| 2   | Real `lsn` / `global_last_seen_lsn` **plus** flip stamping and a fan-out frontier                         | engine          | ~120 lines | **Yes, as a set** — the LSN change ALONE loses revocations (B6) |
| 3   | `electric-schema` on every non-live response, not only the snapshot                                       | `electric.rs`   | ~6 lines   | **Yes** — blocks all warm-store resume                          |
| 4   | Key-set rebuild by suffix subtraction (**not** snapshot-aware — see B1)                                   | `electric.rs`   | ~330 lines | **Yes** — silent revocation loss                                |
| —   | `::text` cast shim (`stripCastsForCircuits`)                                                              | pgxsinkit proxy | 72 lines   | Workaround; belongs upstream in `where_sql.rs`                  |

Configuration: set `ELECTRIC_CIRCUITS_PG_TABLES` explicitly (not `*`) and
`ELECTRIC_CIRCUITS_SUBQ_STORAGE_DIR` to physical storage.

**4. Does PGlite materialization behave identically enough?** **Yes.** Identical row sets and identical
authorization outcomes on every scenario; 10 000-row shapes materialise correctly via the ADR-0045
COPY tier (4 ms apply on both engines).

**5. Does mutation echo/convergence continue to work?** **Yes** — the §13 "critical test". Verified on a
simple shape (`client-contract`, 10/10) and on a **subquery** shape through the real proxy (3/3 runs):
optimistic create visible pre-flush, governed `owner_id` from the auth claim, and `pending=0 acked=0`
— which is reachable _only_ via the replicated echo, since `acked` clears solely on reconciliation.
Update echoes converge on the CDC path too.

**6. Do user-specific cross-table authorization shapes work correctly?** **Yes.** The membership
subquery with the role-asymmetric disjunction evaluates correctly. Manager sees 2 rows, plain member
1 — and the hidden row **never crossed the network** to the plain member (1 delivered, not 2-filtered).

**7. Do membership additions/removals correctly add/delete outer rows?** **Yes, after patch 4** — live
and across an offline gap, in both directions. Un-patched, offline-gap revocation fails ~7 times in 8.

**8. Do batched/transactional membership changes converge?** **Yes.** A single transaction revoking
workspace A and granting workspace B converges to exactly B's rows — no torn state, no lost grant, no
retained revocation. Matches Electric.

**9. Does Circuits' different tag behaviour matter in practice?** **No — it is simpler.** pgxsinkit's
`applyShapeTagSync` is guarded by `if (tags !== undefined)`, so tagless streams are safe by
construction. Circuits states eviction as an explicit `delete` where Electric requires ADR-0023 to
reconstruct it from tag patterns. Circuits' model is the easier one to consume.

**10. Electric wire-protocol assumptions Circuits does not satisfy?** Three, all found and all in the
adapter: the `electric-schema` header on resume responses (#3); LSN headers (#2); and `::text` casts in
`where` (the shim). A fourth is behavioural rather than protocol: Circuits terminates a snapshot with
`up-to-date` where Electric sends `snapshot-end` then holds a post-snapshot catch-up — pgxsinkit
handles both, and Circuits' shape is markedly faster (see Q18).

### Responsibility split

**11. Replaced by Circuits:** logical-replication ingest, shape definition//`where` evaluation,
incremental maintenance (DBSP), subquery/membership re-evaluation, snapshot materialisation, and the
`/v1/shape` HTTP surface including handles, offsets, `must-refetch` and live long-polls.

**12. Provided by Durable Streams:** the durable ordered log — one `changes` stream in, one
`shape/<id>` stream per distinct shape out — offset addressing and long-poll semantics. It is the
persistence and replay substrate; it holds no query semantics.

**13. Remains pgxsinkit's:** everything above the wire — the proxy as sole shape authority (ADR-0003),
registry-derived row filters, auth-claim resolution, the read-path fold and bulk-apply ordering
(ADR-0014), apply-mode/COPY tiering (ADR-0045), catch-up watermark alignment (ADR-0031), the mutation
journal, optimistic overlay, conflict policy, and all PGlite/local-store lifecycle.

**14. Requires external infrastructure (CDN):** cross-client HTTP request collapsing. Neither engine
collapses distinct clients' requests in-process. Circuits mints a **handle per snapshot**, so its
`live_inflight` coalescing collapses only one client's own duplicate polls. Cache-friendliness differs
materially: Electric emits `cache-control: public, max-age=…, stale-while-revalidate=…`, whereas
Circuits emits **`no-store` on every response** — so a CDN tier in front of Circuits would need that
changed upstream. Not a blocker for pgxsinkit today (the proxy is the ingress), but it is the one place
where Circuits is structurally _less_ CDN-ready than Electric.

### Fan-out and scaling

**15. How much computation is shared across parameterized per-user shapes?** **The compiled template is
shared; the parameter values are not.** `/subqueries` shows every node carrying the identical
`template: workspace_members|workspace_id|P(member_id,role)|A()` with a distinct `sig` and
`refcount: 1`. Each distinct parameter instantiates **exactly 2 subquery nodes** (the `memberOf` and
`managerOf` legs) and ~4.3 KiB of registry.

**16. How many streams for N distinct user-specific shapes?** **N.** Measured: `shapes` = baseline + N
exactly (11 → 211 at N=200), `subquery_nodes` = 2N.

**17. How does that compare with N clients on one identical shape?** **Dramatically better, and this is
the clearest result in the investigation.** 200 subscribers on one predicate added:

|                         | change                              |
| ----------------------- | ----------------------------------- |
| shapes                  | 211 → **211** (zero)                |
| subquery nodes          | 400 → **400** (zero)                |
| subquery registry bytes | 854.2 KiB → **854.2 KiB** (zero)    |
| adapter bytes           | 144 → 246 KiB (~0.5 KiB/subscriber) |

Identical predicates cost **nothing** in query computation — only per-client cursor bookkeeping.

**18. Actual CPU/RAM/storage scaling curve.** Measured RAM and time; **CPU and storage were not
measured** — stated plainly rather than estimated.

N=200 distinct shapes, both engines cold, Circuits on a **release** build:

|                       | Electric 1.7.11              | Circuits                    |
| --------------------- | ---------------------------- | --------------------------- |
| baseline RSS          | 271.8 MiB                    | **25.8 MiB**                |
| Δ RSS for 200 shapes  | 75.4 MiB (**386 KiB/shape**) | **15.8 MiB (81 KiB/shape)** |
| open 200 shapes       | 7.84 s (39 ms/shape)         | **0.90 s (4.5 ms/shape)**   |
| propagation med / p95 | 0.15 / 0.16 s                | **0.12** / 0.16 s           |

Both linear across 50→200. Client-tier (real PGlite clients, cold shape):

| rows/shape | Circuits catchup | Electric catchup |
| ---------- | ---------------- | ---------------- |
| 100        | **92 ms**        | 227 ms           |
| 1 000      | **169 ms**       | 1 038 ms         |
| 10 000     | **865 ms**       | 8 184 ms         |

The 10 000-row gap was **attributed, not assumed**: raw snapshot (0.26 s vs 0.18 s), proxy relay
(0.26 s vs 0.24 s) and PGlite apply (5 ms vs 4 ms) are all comparable. The difference is Electric
holding the client's post-snapshot catch-up at `0_inf` for ~7.9 s while the shape settles; the client
is idle, not working. Circuits closes its snapshot with `up-to-date` inline. Circuits also ships 39 %
fewer bytes for identical data.

> **Debug builds invalidate latency conclusions.** On a debug build Circuits' p95 at N=200 was
> **0.64 s**; on release, **0.16 s**. Any benchmark of this engine must use `--release`.

**19. Does Circuits materially reduce the cost of pgxsinkit's _current_ per-user model, before any
model change?** **Yes — this is the headline.** No pgxsinkit redesign is needed to get 4.8× less memory
per shape, 8.7× faster shape creation, and a 9.5× faster cold boot at realistic shape sizes. Naive
extrapolation to 10 000 users: ~0.8 GiB of shape state versus ~3.8 GiB, before the 10× smaller baseline.
(Extrapolation, not measurement — the tested range was 50→200.)

**20. How large is the gain from a future canonical/shared-shape model?** **Asymptotically total, on the
query-computation axis.** Collapsing N per-user shapes onto one shared shape drives marginal registry
and node cost to **exactly zero** (Q17), leaving only ~0.5 KiB/client of cursor state. The remaining
gain over today's Circuits per-user cost would be the full 4.3 KiB × 2-nodes × N. Worth pursuing, but
Q19 shows it is not a prerequisite.

### Recovery and durability

**21. Does Circuits recover cleanly after restart?** **Yes, with one operational caveat.** An engine
restart under a live client converges correctly, even though the startup log reports
`restore: dropping subquery shape … (inner-node state is not persisted); subscribers observe the
deleted stream and recreate` — clients re-snapshot and reconverge. **Caveat:** if the engine cannot
acquire the replication slot (rolling deploy, double-start) it enters a permanent reconnect loop while
`/v1/health` still returns **200** and snapshots still serve correct current rows. A readiness probe on
`/v1/health` would keep routing to an engine that never delivers another update. The logs are loud; the
health endpoint is wrong. Electric has no equivalent failure mode.

**22. Does Durable Streams preserve the state required for client catch-up?** **Yes**, verified with
`--durability wal`: durable-streams was killed and restarted under a live client (old pid dead, new pid
holding the port, engine untouched) and the client converged on a subsequent write. **Caveat:** all
performance numbers in this report were taken with `--durability memory`; the wal-mode performance cost
was not measured.

### Verdict

**23. Are there correctness gaps that make Circuits unsuitable today?** **Yes — un-patched, it is
unsuitable.** The decisive one: a **positioned read is not idempotent once a handle's state has
advanced**, and the resulting delete is silently dropped, so a revoked member keeps rows they are no
longer entitled to. It fails silently, in the retain-data direction. Two others (snapshot duplication;
missing `electric-schema`) each independently break the read path.

**24. Are those gaps fundamental, or small compatibility defects?** **Small compatibility defects,
without exception.** All four live in the Electric adapter; none touches DBSP, the subquery registry,
emission, or Durable Streams. Each was root-caused to a specific line and fixed in under ~20 lines.
The dataflow core produced **no** correctness failure at any waypoint.

**25. Would it be reasonable to support Electric and Circuits as interchangeable backends now?**
**Not yet — but the distance is small.** The blocker is that the fixes live in someone else's engine
and are not released. pgxsinkit should not ship a backend that depends on a locally-patched binary.

**26. What exact blockers remain?**

| #   | Blocker                                                                    | Severity                               | Owner    |
| --- | -------------------------------------------------------------------------- | -------------------------------------- | -------- |
| B1  | Key-set rebuild folds to the TAIL at every offset — silent revocation loss | **Critical** (stale authorization)     | Circuits |
| B2  | `electric-schema` missing on non-snapshot responses                        | **Critical** (no warm resume)          | Circuits |
| B3  | `StreamFold` churn duplicates                                              | **Critical** (data loss via COPY tier) | Circuits |
| B4  | `::text` casts rejected by `where_sql.rs`                                  | High (shimmable)                       | Circuits |
| B5  | `/v1/health` green while replication is dead                               | High (operational)                     | Circuits |
| B6  | LSN headers hardcoded `"0"` — **and unfixable in isolation**               | **Critical** (see below)               | Circuits |
| B10 | Flip emissions (move-in/move-out) carry no `lsn` at all                    | **Critical** (with B6)                 | Circuits |
| B11 | `private.users` served as `public.users` — schema qualifier stripped       | **Critical** (wrong rows, no error)    | Circuits |
| B7  | Per-handle live-poll head-of-line blocking                                 | Medium (bounded)                       | Circuits |
| B8  | `REPLICA IDENTITY FULL` on every table incl. `operations_log`              | Medium                                 | config   |
| B9  | `cache-control: no-store` blocks a CDN tier                                | Medium (future)                        | Circuits |

**Corrections (2026-08-20, after the fixes were implemented).** Three entries above were diagnosed
wrongly in the original report, and the errors ran in the dangerous direction — they understated a
data-loss defect and recommended deferring a fix that is harmful when shipped alone.

- **B1's root cause was not the snapshot offset.** `keys_as_of` gated its fold on
  `env.headers.offset`, a field **nothing ever populates**: every envelope construction site in
  `engine/output.rs` passes `offset: None`, and durable-streams cannot supply it — JSON messages are
  stored verbatim and a read serves a raw byte range. The gate could therefore never fire, so the
  fold ran to the **tail at every offset**, not merely at the wrong one. `apply_changes` gates its
  delete arm on `keys.remove(..)`, so every delete for a key already absent at the tail was dropped:
  a client resuming from any persisted offset never evicted a row whose access had been revoked while
  it was away. The original unit coverage passed because its fixtures invented offset stamps the
  server never sends — a fixture asserting a property of itself.

- **The remedy in §27 step 1 is not implementable as written.** "A `keys_as_of` that reconstructs
  membership at an arbitrary offset" needs per-envelope positions that do not exist. The
  implementable form is **suffix subtraction**: a read is an exact suffix from the requested offset,
  which is the only positional answer the substrate offers, so count the envelopes past the client's
  offset and fold the stream holding that many back. Exact at any offset, no stamps required, and it
  removes rather than adds per-handle state.

- **B6 is not hygiene, and must not be deferred.** Shipping real LSNs _alone_ is **worse than the
  hardcoded `"0"`**. A consumer positions its dedup frontier on the advertised watermark and discards
  anything at or below it — pgxsinkit's own ADR-0031 does exactly this — so with a real watermark and
  unstamped flip emissions (B10), every membership move-in and move-out floors to LSN 0 and is dropped
  as already-seen. That silently loses precisely the revocations B1 was fixed to deliver. The
  hardcoded `"0"` was harmless only because no consumer frontier ever moved. B6, B10 and the fan-out
  frontier are **one change**: the watermark must come from the sequencer (published per transaction,
  after its appends flush, and only while pending flips are drained), not from the ingest head.

- **B11 is not merely the packaging nit it looks like.** A qualified `table=private.users` was served
  as `public.users` — a different table's rows, with no error. Rejecting the qualifier removes the
  disclosure but does **not** add schema support: the engine keys tables by bare name throughout, so
  a schema-bound registry still has nowhere to land. That capability gap is scoped separately in
  [backlog/0009](../backlog/0009-circuits-schema-qualified-tables.md).

The measurements in this report are unaffected — all four are defects in the compatibility adapter
and the emission path, not in what was measured.

**27. Smallest concrete engineering plan to remove them.**

1. **Upstream B1–B3, B10 and B11 as bug reports with the reproductions already written.** Each has a
   minimal failing case independent of pgxsinkit (`w9-keyset-probe.py` three-arm probe; the
   vanilla-ShapeStream resume; the churn duplicate repro). B1's fix is **suffix subtraction**, not the
   `keys_as_of` variant this step originally proposed — see the corrections above.
2. **Upstream B4** as a `where_sql.rs` lexer change accepting and discarding `::type` — then delete the
   pgxsinkit shim rather than committing it.
3. **Upstream B5** — make `/v1/health` reflect replicator liveness.
4. **Fix pgxsinkit's own test hygiene now, independently:** `membership-fanout` must use fresh row ids.
   Its fixed ids turned a deterministic data-loss bug into a 1-in-4 flake — the worst possible
   signature, and the reason B1 went unnoticed for the first six waypoints.
5. **Only once B1–B4 are released**, add a `PGXSINKIT_SYNC_BACKEND` seam with a Circuits lane in the
   integration matrix. Do not commit a backend that requires a patched engine.
6. **Ship B6 + B10 + the fan-out frontier together, or ship none of them.** They are one change; the
   LSN half alone makes consumers discard revocations (see the corrections above). Defer B7–B9 only;
   none of those blocks adoption, and B9 only matters once a CDN tier is real.

---

## Reproducing

```bash
# substrate
podman run -d --name w5-pg -p 127.0.0.1:55440:5432 supabase/postgres:17.6.1.116   # + repo migrations/seed
durable-streams-server --host 127.0.0.1 --port 8791 --data-dir <dir> --durability wal
cd electric-circuits && env -u RUSTUP_TOOLCHAIN CFLAGS=-std=gnu17 cargo build --release -p electric-circuits-engine
ELECTRIC_CIRCUITS_PG_TABLES='<explicit list>' ELECTRIC_CIRCUITS_PG_SLOT=circuits \
  ./target/release/electric-circuits-engine

# suite against either backend
DATABASE_URL=… ELECTRIC_URL=http://127.0.0.1:7010/v1/shape PGXSINKIT_SYNC_BACKEND=circuits \
  bun test tests/integration/<suite>.integration.test.ts
```

Build notes (both upstream-relevant): dbsp→mimalloc vendors C using `ATOMIC_VAR_INIT`, removed in C23 —
GCC 15 defaults to gnu23, so `CFLAGS=-std=gnu17` is required. A globally exported
`RUSTUP_TOOLCHAIN` silently overrides `rust-toolchain.toml` and ICEs dbsp; 1.97.1 ICEs as well as the
1.97.0 named in the pin comment.

Harnesses (`tmp/agents/circuits/`): `w9-flake-repro.ts`, `w9-keyset-probe.py`, `w9-fanout.py`,
`w11-client-tier.ts`, `w12-txn-and-restart.ts`, `w8-echo-subquery.ts`, `w8-tap.ts`.

## Completion against §30

Built and ran Circuits (178/178 unit tests) ✓ · ran Durable Streams in both durability modes ✓ ·
exercised `/v1/shape` ✓ · real pgxsinkit integration ✓ · existing suite against it (30/30) ✓ ·
investigated every failure to root cause ✓ · Electric baseline throughout ✓ · comparable Circuits
performance ✓ · shared-vs-per-user shape behaviour measured ✓ · restart/recovery tested ✓ · raw results
preserved ✓ · reproducible commands left ✓ · report + go/no-go stated ✓.

**Not done, and why:** CPU and storage scaling curves (only RAM and latency were instrumented);
multi-node behaviour (single host); throughput under sustained write load (all measurements are
cold-boot/steady-state); genuine multi-client client-tier numbers (five PGlite instances in one Bun
process contend for one thread, so that row is not evidence); and wal-mode performance (perf ran on
`memory`).
