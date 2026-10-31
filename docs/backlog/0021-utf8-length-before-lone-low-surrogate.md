# 0021 — UTF-8 length undercounts before a lone low surrogate

Status: candidate (recorded 2026-10-31)
Opened: 2026-10-31 · Area: `packages/pgwasm/src/protocol/wire/string-utils.ts`
Reopen trigger: the next wire-serialization correctness pass, or a report of malformed/truncated
parameters containing unpaired UTF-16 surrogates.

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

The current performance plan removes a duplicate length scan without changing this helper or the
existing output semantics. Fix this separately so a correctness change is explicit and independently
reviewable; do not add regression assertions that bless the faulty byte lengths.
