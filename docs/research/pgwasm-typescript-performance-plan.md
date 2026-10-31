# Plan: pgwasm TypeScript performance improvements

Status: complete; reader/live changes retained, serializer deferred; validation passed.
Date: 2026-10-31.
Evidence: [source review](0002-pgwasm-typescript-performance-candidates.md).

## Agreed outcome

Investigate three bounded improvements, in order:

1. Decode text fields from temporary byte views rather than copying each field first.
2. Calculate string-parameter UTF-8 length once during serialization.
3. Remove redundant worker live-diff key storage and the materializer's intermediate array.

Anton explicitly agreed to include the adjacent client work in item 3 and to judge performance by
representative small and large workloads: no reproducible speed or memory regression beyond
measurement noise. Correctness and buffer ownership/lifetimes must remain intact. A finite benchmark
cannot establish that every possible workload improves.

Each item is an experiment, not a commitment to land its code. Keep only candidates with a
repeatable benefit in time or allocation/peak memory, without a regression in the other. Record
inconclusive or rejected candidates and their evidence; do not compensate for a regression in one
candidate with an improvement in another.

## Starting state and boundaries

Work in `/home/anton/dev/pgxsinkit/pgxsinkit`, currently on `port-19` at `aabc6ec`. Recheck the branch
and worktree on resumption. The earlier parser improvement is uncommitted and must be preserved:

- `packages/pgwasm/src/core/parse.ts`
- `tests/unit/pgwasm-parse.test.ts`
- `tests/unit/pgwasm-basic.test.ts`
- Its entry in `docs/testing-strategy.md`.

Use the current parser-improved worktree as the performance baseline, not bare HEAD. Record source
hashes for baseline and candidates so earlier parser gains cannot be attributed to this pass.

Do not change C/WASM, storage durability, persistent formats, public query contracts, dependency
versions, release pins or branches as part of this plan. No commit, publish or cross-branch port is
part of the present handoff. No new glossary terms or ADR are needed. Bytea decoding, packet borrowing
and quoted-array parsing remain deferred under the review's workload/evidence triggers.

## Execution and ownership

Use bounded implementer agents, with the coordinator retaining design, source review and acceptance.
The coordinator owns benchmark orchestration and documentation. Implementers return changed paths,
a diff summary, key decisions and any unresolved correctness concerns. Inspect their actual changes
before accepting them.

Run the three implementation steps sequentially. The two wire steps share tests; do not assign
overlapping test files to concurrent agents. Every brief must state that other changes exist and
must not be reverted. Every brief must also carry the latest-published-version rule for any dependency
or tool touched; no dependency/tool change is anticipated.

Every brief must include the repository's hard prohibition on cache bypass: no direct `bun test`,
`test:unit:nocache`, `validate:refresh`, `PGXSINKIT_FORCE`, `NO_CACHE`, or equivalent without explicit
per-run permission. Use sanctioned package scripts. Benchmarks must not be used to rerun the test
suite outside its selector/cache.

### Step 1: text decoding

Ownership: `packages/pgwasm/src/protocol/wire/buffer-reader.ts` and relevant coverage in
`tests/unit/pgwasm-protocol-wire.test.ts`.

Change only the synchronous string-decoding path to use a bounded byte view. Keep `bytes()` owning
its output, preserving escaping COPY/authentication data. Do not change the parser's whole-chunk
ownership or introduce pooled storage.

Verify ASCII, multibyte Unicode, replacement behavior, empty strings, NULL fields, cstrings, nonzero
offsets and fragmented messages. Mutate/reuse the source after parsing to prove returned values are
independent. Characterize malformed lengths before editing: view constructors and `slice()` have
different range behavior. Preserve observable behavior or stop that candidate and explain the
required correctness decision; do not silently fold in protocol-hardening changes.

Benchmark full wire decoding, not just `TextDecoder`, followed by real query consumption. Compare
0/1/1,000/10,000 rows, 4/12 columns, short ASCII, longer Unicode and JSON text, with NULL mixtures.

### Step 2: parameter serialization

Ownership: `packages/pgwasm/src/protocol/wire/buffer-writer.ts`, `serializer.ts` and the wire tests.

Add a narrow writer operation that owns the string length prefix and payload encoding together,
calculating UTF-8 length once. Avoid a cache or worst-case oversized retained buffer. Keep the change
internal; existing serialized bytes and mapper behavior remain the contract.

Verify exact bytes, empty strings, ASCII, multibyte characters, surrogate pairs and lone surrogates;
NULL/binary parameters; mapper invocation order/count; and parameter boundaries. If the current
UTF-8 helper is incorrect for an input, document a separate correctness issue rather than silently
changing semantics or blessing incorrect output as the desired contract. Pause the affected
candidate if correctness prevents an isolated optimization.

Benchmark 1/100/1,000 parameters with short strings, 1 KiB values and selected large values. Avoid a
needlessly huge Cartesian product. Include real parameterized reads/writes so serialization gains
are distinguished from total query time.

### Step 3: worker live diffs

Ownership: `packages/client/src/worker/live-diff.ts` and `tests/unit/worker-live-diff.test.ts`.

Use `nextMap.has()` in place of the parallel `nextKeys` Set. Rebuild the materialized output with one
pass that skips missing keys, replacing `map(...).filter(...)`.

Verify duplicate keys remain first-wins during diffing; removals, missing order entries, reordering,
empty results and repeated refreshes; fresh result arrays; and unchanged row object identity. Keep
key encoding, equality, subscription sharing and transport payloads unchanged.

Benchmark 0/1/1,000/10,000 rows with no changes, one changed row, and removals plus reordering.
Measure diff generation and materialization separately and together. Include a worker delivery
scenario to establish whether the isolated savings matter beyond the helper itself.

## Measurement and acceptance

- Keep scripts, baseline snapshots and raw measurements under `tmp/agents/pgwasm-performance/`.
  Use TypeScript with typecheck coverage. Reuse the earlier parser benchmark's approach where useful,
  but do not overwrite its evidence.
- Run Bun, Chromium and WebKit serially, recording versions and workload/source identities. Warm up,
  rotate baseline/candidate order and use multiple samples. Calibrate noise with baseline-versus-
  baseline runs; rerun apparent wins/regressions in an independent batch before deciding.
- Compare each candidate with its immediate baseline, and the final accepted combination with the
  original parser-improved baseline. Consume results; check equivalence outside timed regions.
- Separate isolated operation time from end-to-end query/refresh time. Report medians and spread;
  do not extrapolate parsing or serialization percentages into application speedup claims.
- Assess allocation volume, peak memory and retained memory after a large-then-small workload.
  Count eliminated allocations/copies separately from measured heap. Use supported profiling
  facilities and document limitations; noisy process RSS alone cannot establish a small heap win.
  If suitable tooling is missing, ask for it rather than inventing an unreliable substitute.
- Reject or defer reproducible regressions. If memory or timing evidence is insufficient to apply
  the agreed criterion, report the candidate as unresolved rather than calling it accepted. An
  optimization can be rejected without expanding the task into a larger redesign.

## Validation and completion

The coordinator runs tests serially, checking `podman ps`, `podman compose ls` and prior test processes
before starting a suite. Use `bun run test:unit` for selected/content-cached unit checks and the
repository's `bun run validate` and `bun run validate:full` for final validation. Cached passes count;
do not bypass them. Add focused regressions for ownership, byte equivalence and identity boundaries,
not tests that merely repeat the new loops. Browser benchmarks complement rather than replace
correctness coverage; run a relevant existing browser contract lane if changes expose a browser-only
behavior that unit coverage cannot establish.

Document results in the source review, including rejected experiments, runtime-specific outcomes,
measurement limitations and exact commands. Add any relevant coverage/behavior record to
`docs/testing-strategy.md`. Inspect the final diff, preserve the pre-existing parser work, and report
which candidates were accepted and why, checks run, and remaining limits.

## Model-change handoff

The two grilling decisions are settled; there are no remaining product/design questions for this
bounded plan. At this handoff only the review and this plan have been written. No new implementation,
benchmark or test run has started. Stop here as Anton requested, and wait for continuation after the
model change.

## Implementation outcome

After the model-change stop, Anton authorized execution. Steps 1 and 3 were retained after source
review and repeated Bun/Chromium/WebKit measurements. Step 2 was tried in two helper shapes and
deferred because tiny WebKit binds did not establish non-regression; writer/serializer production
sources were restored. The [review results](0002-pgwasm-typescript-performance-candidates.md#implementation-evidence)
record timing ranges, memory evidence and limitations, rejected variants and revisit criteria.
The separately discovered UTF-8 helper correctness defect is [backlog 0021](../backlog/0021-utf8-length-before-lone-low-surrogate.md).

Validation: `bun run validate` passed (1,679 tests, zero failures); `bun run validate:full` passed
(866 tests, zero failures, unchanged typecheck/lint reused from cache, artifact checks passed).
The gates ran sequentially, with no test-cache bypass. No separate browser correctness lane was
needed: retained code uses existing synchronous decoding/Map contracts covered by the owned unit
tests, with Chromium/WebKit execution additionally exercised in the performance harness. Precise
browser peak-memory measurements remain a documented limit, not a correctness-test failure.
