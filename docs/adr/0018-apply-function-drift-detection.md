# Apply-function drift detection via an embedded fingerprint

Status: accepted (2026-06-25); runtime enforcement amended by ADR-0030 (2026-07-03)

The write path is a single in-database function, `pgxsinkit_apply_mutations`, generated from the
registry by `pgxsinkit-generate` and installed as an ordinary migration. Checking only that a
function with the expected **signature** exists cannot establish that the installed **body** matches
the registry the server is running.

That leaves the library's most likely production footgun unguarded: change the registry (or bump
`@pgxsinkit/server`, whose codegen emits different SQL), regenerate the TypeScript, but ship without
applying the new migration. The signature check passes, and the server then applies writes against a
stale set of table branches — silently, until a write hits a missing branch or a since-changed column.

A drift signal already exists in spirit: `fingerprintRegistry` (ADR-0004) is the canonical "has the
shape changed" hash. But it is *shape-only* — it deliberately cannot see a pure codegen change (a new
`@pgxsinkit/server` that emits different SQL for the same shape), which is exactly one of the drift
classes we need to catch.

## Decision

1. **Fingerprint the generated DDL body, not just the shape.** `buildPlpgsqlBatchFunctionDdl` computes
   `hashString` (the shared FNV-1a, now exported from `@pgxsinkit/contracts`) over the exact `DROP …;
   CREATE …` body and appends a `COMMENT ON FUNCTION … IS 'pgxsinkit:fp1:<hash>'`. The hash therefore
   shifts on **registry shape changes**, on **applier codegen changes**, and on the **function schema** —
   the three things that make an installed function stale. It does not depend on TS-side row-filter /
   `customWhere` logic, which never enters the apply function (that shapes the read proxy, not writes).
   The `fp1:` prefix lets the stored format evolve. `expectedApplyFingerprint(registry, options)` exposes
   the value for the runtime and CI checks. A `COMMENT` is the store of record because it is
   function-scoped, replaced atomically with the function, and read back in one line via
   `obj_description(...,'pg_proc')`.

2. **Enforce it in the apply call, always.** ADR-0030 places the expected fingerprint in the
   `pgxsinkit_apply_mutations` call. The function compares it with its own comment before touching any
   table and raises `PXS01` on a mismatch. An absent or unknown-format comment also fails; regeneration
   via `pgxsinkit-generate` is the supported installation path. There is no runtime compatibility mode
   or `applyFunctionDriftCheck` option.

3. **Catch it before deploy, with the same shipped tool.** `pgxsinkit-generate --check` computes the
   expected fingerprint and asserts that a committed migration already embeds it — read-only, no
   drizzle-kit, safe for CI. It is the same generic CLI consumers already use to generate, pointed at
   their own registry, drizzle config, and (optionally) function schema; it is **not** a repo-private
   script. pgxsinkit dogfoods it via `bun run sync:function:check` against its demo and board registries.

## Consequences

- The drift the server enforces at startup is now also catchable in CI, before a stale migration ships.
  The two checks share one fingerprint definition, so they cannot disagree.
- **The detector immediately found real drift.** `sync:function:generate` was generating the
  `infra/drizzle` function from `demoSyncRegistry` (authors/todos) while the write-api runs the superset
  `demoMembershipSyncRegistry` (the membership tables exist in the schema but had no apply branches). The
  generator now passes `--export demoMembershipSyncRegistry`; regenerating the function migration (a
  gated step) both embeds the fingerprint and fixes that pre-existing inconsistency.
- `sync:function:check` verifies that the baseline migrations contain the expected function
  fingerprints; a stale, unstamped, or wrong-signature function cannot serve writes.
