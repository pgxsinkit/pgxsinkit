# 0021 — UTF-8 length undercounts before a lone low surrogate

Status: resolved (2026-10-31)
Opened: 2026-10-31 · Area: `packages/pgwasm/src/protocol/wire/string-utils.ts`
Taken up on Anton's instruction after the performance commit on 2026-10-31.

## Finding

`byteLengthUtf8` scans backwards and skips the preceding code unit whenever it encounters a low
surrogate, without checking that the preceding code unit is a high surrogate. The base string length
already counts ASCII, so ASCII followed by a lone low surrogate is not sufficient to expose the bug.
A preceding multibyte character exposes the skipped byte increments:

- `"\u0800\udc00"`: calculated length 4, but `TextEncoder` produces 6 bytes.
- `"©\udc00"`: calculated length 4, but `TextEncoder` produces 5 bytes.

The writer uses the calculated length both for the wire prefix and to advance its output position.
This can truncate a parameter or overwrite its tail. Ordinary valid Unicode, including valid
surrogate pairs, does not trigger this specific defect. This is malformed JavaScript UTF-16 input,
not evidence that normal non-ASCII text is broken.

## Resolution direction

Match `TextEncoder` replacement semantics: skip a preceding code unit only for a valid surrogate
pair. Cover lone low surrogates after ASCII, two-/three-byte characters and other surrogates, both
in the length helper and through exact wire serialization and actual parameterized queries.

The performance investigation tried removing a duplicate length scan, then deferred that optimization
because tiny WebKit binds did not establish non-regression. Its changes were committed separately
as `4c52f74`. This correctness fix changes the helper independently of that experiment.

## Resolution

Only skip the preceding code unit when a low surrogate has a preceding high surrogate. Every
unpaired surrogate retains the three bytes used by `TextEncoder` for U+FFFD. This preserves the
allocation-free linear scan and fixes both the declared wire length and the writer's advancing offset.

The pre-fix helper was reproduced independently: `"\u0800\udc00"` returned 4 versus 6 encoded bytes,
and `"©\udc00"` returned 4 versus 5. Regression coverage compares representative short UTF-16
combinations with `TextEncoder`, checks exact bind bytes with a following parameter, and runs
parameterized queries against the actual WASM build. `bun run validate` passed with 1,632 tests and
zero failures, including all three new regression tests. `bun run validate:full` also passed with
866 tests and zero failures. No test-cache bypass was used.
