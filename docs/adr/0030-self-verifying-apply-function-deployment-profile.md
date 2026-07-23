# Self-verifying apply function and the serverless deployment profile

Status: accepted (2026-07-03)

Field measurement on the board demo (Supabase Cloud edge functions, `ap-southeast-1`, ~70ms RTT)
attributed a ~4.4s mutation ack almost entirely to **per-worker startup**: the platform serves one
worker per request (`booted`/`shutdown` around every invocation), so every write replays the whole
startup gate — a fresh pooler TLS connect plus three classes of sequential verification round trips —
before the first useful statement:

| component (measured, two independent writes)                    | ms          |
| ---------------------------------------------------------------- | ----------- |
| startup gate: connect + apply-fn verify + RLS verify + ops-log    | ~3,180–3,210 |
| `authMs` (JWKS verify; cold-fetch variance)                       | 45–753      |
| `applyMs` (the actual mutation transaction)                       | 347–406     |
| edge routing + network (client-observed minus function total)     | ~600–900    |

The ADR-0018 drift guarantee — a stale apply function must never serve writes — is right; its
**enforcement point** (process startup) assumed long-lived processes. On per-request workers the
startup check multiplies into a per-write tax, and even `applyFunctionDriftCheck: "off"` still paid
the presence query. Any read-comment-then-call design also carries a TOCTOU window: under READ
COMMITTED, `CREATE OR REPLACE` can land between the verify statement and the call it guards.

## Decision

1. **The apply function verifies itself — full replacement of the startup check.**
   `pgxsinkit_apply_mutations` gains a trailing `p_expected_fingerprint text` parameter. Before
   touching any table, the body compares it against `obj_description(<own oid>, 'pg_proc')` — the
   ADR-0018 comment anchor, written atomically with the function by the same migration — and raises
   SQLSTATE `PXS01` on mismatch (message carries installed vs expected). The check is **atomic with
   execution** (the check *is* the call — no TOCTOU), costs **zero additional round trips** (the
   argument rides the existing call; the comparison is one text equality in-process), and holds under
   every worker model. `executePlpgsqlBatch` always passes `expectedApplyFingerprint(registry)`
   (computed once per server instance). The runtime startup verification
   (`verifyPlpgsqlBatchFunction` at boot) is **deleted from every path**; `pgxsinkit-generate
   --check` remains the deploy-time half, unchanged (ADR-0018 §3).

2. **`applyFunctionDriftCheck` is removed from the public options.** Enforcement is always-on — a
   tri-state made sense only while the check was a separable startup step. Two hard edges are
   accepted deliberately:
   - An **unstamped** hand-installed function is **refused** — no
     comment means no match. This supersedes ADR-0018 §2's warn-and-continue posture for absent
     comments; regeneration via `pgxsinkit-generate` is the supported path.
   - An **old-signature** function fails even louder, at call resolution (undefined function).
   The route maps `PXS01` (via `readSqlState`) to the same actionable operator message the startup
   error gave: regenerate the sync-function migration and apply it before serving writes.

3. **A `deployment` profile owns the remaining startup posture.**

   ```ts
   createSyncServer({
     deployment: {
       startupVerification: "in-process" | "deploy-time", // default "in-process"
       operationsLog: "probe" | "enabled" | "disabled",   // default "probe"
     },
   })
   ```

   - `startupVerification` now governs only the **RLS auth-helper verify** (the sole remaining
     startup query class after decision 1): `"in-process"` runs the boot-time check and its
     clear startup error; `"deploy-time"` skips it — the migration pipeline owns that guarantee.
   - `operationsLog` replaces the startup **probe** with a declaration where wanted: `"probe"` is
     ensure-then-warn-disable; `"enabled"` assumes the table exists (no query; absence then
     fails writes loudly); `"disabled"` turns logging off with no query.
   - The zero-startup-query serverless posture is
     `{ startupVerification: "deploy-time", operationsLog: "enabled" | "disabled" }` — the first
     statement a fresh worker sends is the mutation transaction itself.
   - The defaults (`"in-process"` + `"probe"`) are the safe degradation posture: a host that
     declares nothing gets the self-verifying boot check and the ensure-then-warn-disable probe, so
     a misconfigured deployment fails loudly at startup rather than silently at first write.

4. **The board demo adopts the serverless posture** — `board-write` sets
   `{ startupVerification: "deploy-time", operationsLog: "disabled" }` and warms the GoTrue JWKS at
   module scope (the observed 45–753ms `authMs` variance is the cold key fetch; warming overlaps it
   with the connect). Expected ack on this platform: ~4.4s → ~1.2–1.5s (connect ~0.3s + apply ~0.4s
   + routing ~0.7s). The residual floor is the platform's per-request worker model and is accepted
   for the demo; hosts needing lower write latency run the write path on persistent workers (the
   reference write-api shape).

## Consequences

- **ADR-0018 is partially superseded**: the fingerprint scheme, comment anchor, and CLI/CI check are
  unchanged; the runtime enforcement point moves from process startup into the call itself; the
  absent-comment posture flips from allow-with-warning to refuse.
- **emergent (next dep bump)**: direct callers of `pgxsinkit_apply_mutations` (the `/unit` applier's
  derived-child-envelope tier) add the fingerprint argument — `expectedApplyFingerprint` is exported
  for exactly this — and delete their `applyFunctionDriftCheck` usage. The signature change makes a
  missed update loud (undefined function), never silent.
- **Artifacts regenerate** (both `infra/` histories — ephemeral, per the regeneration runbook); the
  cloud demo redeploys via the Demo reset action plus `board:cloud:functions`.
- The per-request worker measurement methodology (client `syncDebug` rail + server
  `[pgxsinkit-timing]` lines) stays in place; regressions in the write floor are visible in one log
  line per write.
