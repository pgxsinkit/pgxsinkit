# pgwasm TypeScript performance candidates

Status: measured; reader and live-diff changes retained, serializer optimization deferred.
Reviewed: 2026-10-31, `port-19` at `aabc6ec`, with the uncommitted result-parser improvement present.

## Scope and evidence

Anton requested a brief review of other critical TypeScript paths for algorithms or data structures
that improve speed or memory without worsening the other or correctness. The initial review was
source inspection; subsequent implementation measurements are recorded below. The earlier parser
measurements do not establish gains for these candidates.

The existing vocabulary remains in [CONTEXT.md](../../CONTEXT.md): pgwasm is the runtime, a Postgres
build supplies its byte channel, and worker live-query delivery belongs to the toolkit client. No new
domain terms or architectural decisions are needed for these reversible experiments.

## Candidates, in recommended investigation order

### 1. Decode text from a temporary byte view

[`BufferReader.string`](../../packages/pgwasm/src/protocol/wire/buffer-reader.ts) calls `bytes`, which
copies the field with `ArrayBuffer.slice`, before immediately decoding it. Each non-NULL DataRow field
takes this path. Decode a bounded view synchronously instead; retain owning copies in `bytes` for
binary values that escape the call.

This removes one backing-buffer allocation and payload copy per decoded field. Decoding still takes
O(text bytes); it does not eliminate the resulting JavaScript string or promise a completely copy-free
decoder. The platform accepts typed-array views and returns a string synchronously
([TextDecoder documentation](https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/decode)).

Check Unicode, empty fields, nonzero offsets, fragmented packets, source-buffer reuse and invalid
lengths: view construction and `slice` differ on invalid ranges. Benchmark full wire decoding of
1/1,000/10,000 rows with short ASCII, long Unicode and JSON text, then real queries.

### 2. Measure parameter UTF-8 length once

[`writeValues`](../../packages/pgwasm/src/protocol/wire/serializer.ts) measures each string parameter
with `byteLengthUtf8`; [`Writer.addString`](../../packages/pgwasm/src/protocol/wire/buffer-writer.ts)
immediately repeats the measurement before encoding. A length-prefixed string writer can own the
measurement, prefix and encoding together, removing one full scan without a cache or larger buffer.

Check exact output bytes, Unicode including lone surrogates, mapper call order/count, NULL and binary
parameters, and parameter limits. Existing UTF-8 behavior must be inspected rather than assumed
correct; any discovered correctness change should be identified separately. Benchmark small binds
as well as many parameters and large text/JSON values. The overall algorithm remains linear.

### 3. Remove duplicate live-diff storage and an intermediate array

This is **adjacent client scope**, not pgwasm core.
[`computeLiveDiff`](../../packages/client/src/worker/live-diff.ts) maintains a Set and a Map with the
same next-result keys. Use the existing Map for duplicate/removal membership, eliminating the Set
and its insertions. `LiveRowsMaterializer.apply` can replace `map(...).filter(...)` with one pass into
the final array, eliminating one temporary array.

The work remains O(rows); transient storage falls by one hash container and one array in their
respective paths. Preserve first-duplicate-wins, missing-key skipping, result order, fresh output
arrays and unchanged row identity. Benchmark unchanged, one-row-change and reorder/removal refreshes
at small and large sizes; compare output and object identity. Map-versus-Set timing still needs
measurement despite the clear reduction in redundant storage.

### 4. Decode bytea directly into its final typed array

[`types.bytea.parse`](../../packages/pgwasm/src/types.ts) uses a callback, a two-character substring
and `parseInt` for each byte. An indexed character-code decoder could remove those intermediates.
Prioritize only if binary-heavy reads matter; ordinary scalar lists gain nothing from this change.

The parser is public: preserve uppercase, odd-length and malformed-input behavior, or identify a
separate correctness decision. A validated fast path with a fallback may cost enough to erase the
benefit on small values. Benchmark empty/tiny values through 1 MiB payloads, including query time.

### 5. Borrow complete incoming packets; copy only incomplete tails

[`Parser.parse`](../../packages/pgwasm/src/protocol/wire/parser.ts) currently copies typed-array
chunks before parsing. Complete packets could sometimes be decoded from the borrowed input, with
owned storage for unfinished tails. However, the
[`WireSession` contract](../../packages/pgwasm/src/build/seam.ts) lends chunks only during the callback.
Reentrant callbacks, heap growth, escaping binary values and arbitrary fragmentation make this a
larger change. Defer until profiling shows the remaining whole-chunk copy matters. A blanket
`slice` → `subarray` replacement is unsafe.

### 6. Slice unescaped quoted array elements once

The array parser in [`types.ts`](../../packages/pgwasm/src/types.ts) appends quoted characters one at
a time. Tracking a span and building escape-decoding chunks only when needed may reduce temporary
string work. JavaScript engines can use ropes, so the existing path is not established to be
quadratic. Nested arrays, delimiters, quoted NULL, escapes and custom parser order make this a less
attractive first experiment. Revisit for large text-array workloads.

## Existing choices to retain

- The wire carry buffer already grows geometrically; raw reply concatenation is linear and has a
  single-chunk fast path. Ordinary queries already stream protocol decoding.
- The mutex uses a promise tail, and live-query debouncing coalesces pending calls. There is no
  unbounded array-shifting queue to replace on those paths.
- Worker subscriptions already share registrations and send changed row bodies; COPY/export paths
  already use transferable buffers. Columnar transport adds conversion work and new contracts.
- Buffer pools and metadata caches can trade time for retained memory. The earlier parser metadata
  cache already showed mixed runtime results and was omitted.
- Incremental live queries retain database state and do extra diff work. The existing
  [backlog assessment](../backlog/0005-incremental-live-queries-for-large-lists.md) requires a measured
  workload before adoption. Storage durability and the persistent format are outside this survey.

## Agreed scope and evaluation rule

Anton agreed to include candidate 3, the adjacent worker live-diff improvements, after candidates
1 and 2. Candidates 4–6 remain outside the first implementation pass, with the revisit conditions
above. The [implementation plan](pgwasm-typescript-performance-plan.md) records the sequence.

Agreed acceptance: identical observable behavior and ownership/lifetime guarantees; a repeatable
gain in time or allocation/peak memory; no reproducible regression beyond measurement noise in the
other on representative tiny and large workloads across Bun, Chromium and WebKit. Include retained
memory after a large-result/small-result sequence, not only allocation counts. Smaller allocations
alone do not prove lower peak heap or faster queries. This finite evidence cannot establish that no
possible workload regresses.

The interview has no remaining design decisions for this bounded pass. Anton requested a written
plan and a model-change stop, then authorized implementation on resumption.
No ADR is warranted: these are local reversible candidates, not a settled architectural trade-off.

## Implementation evidence

The reader now decodes valid bounded ranges through a temporary byte view, with the original
copying path retained for malformed ranges to preserve clipping/coercion and offset behavior.
Binary `bytes()` still returns an owning copy. The worker diff uses its Map for membership and
materializes rows in one pass. Tests cover every packet split of Unicode fields, input reuse,
malformed ranges, cstrings/replacement decoding, binary ownership, duplicate keys, missing/repeated
order entries and stable row identity.

Baseline source snapshots include the already improved result parser. Two rotated nine-sample
batches on Bun 1.4.4, Chromium 156.0.8078.4 and WebKit 27.2 compared full DataRow wire decoding,
bind serialization, diff generation and materialization. A second baseline timing slot estimates
run noise. For non-tiny workloads, observed candidate/baseline time ranges were:

| Operation            |       Bun |  Chromium |    WebKit |
| -------------------- | --------: | --------: | --------: |
| Wire decoding        | 0.36–0.65 | 0.32–0.56 | 0.47–0.80 |
| Live diff generation | 0.80–0.96 | 0.79–0.91 | 0.81–0.96 |
| Materialization      | 0.52–0.80 | 0.69–0.78 | 0.57–0.88 |

Focused empty-wire timing did not reproduce an initial WebKit slowdown. Chromium allocation
sampling for the combined reader/live workload fell from approximately 94 MB to 62–63 MB across
three trials. Those are sampled allocated bytes, not peak heap. Browser module-retained heap after
discarding large work and collecting was comparable; that diagnostic does not retain one live
materializer across large/small calls. Bun's same-materializer reset also showed comparable retained
heap. These checks support the structural reduction in temporary storage; precise peak heap and
WebKit heap measurement remain limitations. No additional retained cache or capacity was introduced.

Actual Bun WASM execution followed by wire decoding improved for 1,000/10,000-row results, but those
measurements exclude public result conversion and query-lock scheduling. MessageChannel delivery
gains were smaller; its diagnostic does not model a complete worker subscription lifecycle. No
application-level speedup is claimed.

Raw results, source hashes, typechecked harnesses, exact commands and the detailed report are in
`tmp/agents/pgwasm-performance/` (`report.md`, `results.json`, `extras.json`,
`chromium-memory.json`). These ignored artifacts support the durable findings recorded here.

An existing surrogate-related UTF-8 length defect was recorded separately in
[backlog 0021](../backlog/0021-utf8-length-before-lone-low-surrogate.md); it is outside this
performance pass.

### Serializer experiment: deferred

Two implementations removed the duplicate UTF-8 length scan: one shared encoding through a private
helper, then a second restored the original `addString` and inlined the narrow prefixed-string
operation. Larger binds improved, but tiny WebKit binds did not establish non-regression. The first
attempt's focused ratios were 1.33 and 1.15 times baseline, with substantial control drift in the
second batch. The second attempt produced 1.40 in one batch with a 1.04 control ratio; the other
batch improved but its baseline control also drifted approximately 29%. These results do not justify
accepting the optimization under the agreed criterion, nor prove that the additional helper call
was the cause. Both attempts and source hashes are retained in the scratch report.

Writer and serializer production sources were restored to their pre-experiment content. Revisit this
candidate only with a shape that establishes stable tiny-bind non-regression, using longer or better
isolated measurements rather than accepting large-bind gains as compensation. No broader serializer
redesign is required to complete this pass.

### Validation

`bun run validate` passed with 1,679 tests and zero failures; `bun run validate:full` passed with
866 tests and zero failures. Formatting, all six typecheck projects, lint and artifact checks passed
(the final gate reused unchanged cached stages). No uncached-test override was used. Five new
regression tests cover the retained reader/live behavior. The previous uncommitted parser change
and its tests were preserved; these totals include that work.
