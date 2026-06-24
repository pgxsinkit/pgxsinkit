# Consumer review log (docs dogfooding)

Running log of every moment building `apps/board` required reading `@pgxsinkit/*`
**source** because the docs/`llms.txt` did not answer the question — i.e. a
documentation gap a real external consumer would also hit. See
[ADR-0006](./adr/0006-docs-dogfooding-gate.md) for the process. Fixes land in the
toolkit docs (Starlight content + source JSDoc); `llms.txt` regenerates from them.

Status: `open` → `resolved` (doc/JSDoc updated) · `n/a-internal` (consumer never
needs it) · `ergonomics` (a real API gap, fixed upstream).

## Phase 1 — board-schema (registry, RLS, conflict policy, consistency groups)

Gate resolved in the toolkit docs; verified by `bun run --cwd apps/docs build` (the
new material appears in the regenerated `llms-full.txt`).

1. **RLS read/write two-subject split** — write-path policies key on `auth.uid()`
   (Postgres-with-JWT) but the read-path `customWhere` must key on the literal
   `claims.sub` because **Electric** runs the `where`, not Postgres. Getting this
   wrong silently breaks security. → **resolved**: new "Two execution contexts
   enforce the same authorization" note in `start/getting-started`.
2. **Local schema emits no FK** → a child grouped with its parent needs no
   `deferrableConstraints` (that setting is a write-path/server concern only). →
   **resolved**: new practical-implications bullet in
   `concepts/local-schema-ddl-parity`.
3. **`conflictPolicy` is a required hard-error** on writable tables. → **resolved**:
   the `start/getting-started` registry example now declares it, plus a "Writable
   tables have two hard requirements" caution. (The example was previously _invalid_
   — it would have thrown.)
4. **The membership RLS builder gates writes to owner-or-manager**; collaborative
   any-member writes are hand-authored from `pgPolicy` + the predicate builders. →
   **resolved**: RLS-helpers + hand-author pointer added to the security note in
   `start/getting-started`.
5. **The server is a runtime-portable `fetch` handler** (Deno / Supabase Edge
   Functions / Workers, not only Bun). → **resolved**: prerequisite softened + an
   inline deploy note on `server.fetch` in `start/getting-started`.
6. **Managed fields + Server version** — every writable table needs a
   `nowMicroseconds`-on-update managed field (the Server version); `authUid` stamps
   are server-assigned and rejected in client payloads. → **resolved**: the
   `start/getting-started` registry example now shows the managed-field block + the
   two-hard-requirements caution.
