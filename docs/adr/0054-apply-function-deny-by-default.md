# The apply function is deny-by-default

Status: accepted (2026-08-01)

## Context

The generated `pgxsinkit_apply_mutations` is SECURITY INVOKER and takes `p_user_claims jsonb` as
an argument it trusts: the body copies those claims into `request.jwt.claims` and switches `role`
before running RLS-governed DML. That trust is correct for the one legitimate caller — the
consumer server, which passes claims it VERIFIED — and catastrophic for anyone else: a caller who
can invoke the function directly chooses its own claims, so owner-scoped RLS evaluates as any
person the caller cares to name, on every writable table of every consumer, with every API-layer
business refusal bypassed (the API was bypassed).

Until now the artifact emitted no ACL statements at all. Postgres grants EXECUTE on new functions
to PUBLIC by default, and Supabase-shaped clusters go further: this repo's own bootstrap carries
`ALTER DEFAULT PRIVILEGES … IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated,
service_role` (for both `postgres` and `supabase_admin`). Worse, the artifact begins with
`DROP FUNCTION IF EXISTS`, so every install RESETS the ACL to those defaults — a manually
hardened function un-hardens itself on the next regenerate. Where a PostgREST-style SQL-RPC
surface exposes `public` functions, this is a remotely reachable forged-claims impersonation RPC
(the emergent Phase-2 adversarial reviews that surfaced it were release-blocking); without such a
surface it remains a lateral-movement primitive for anything holding one of those role
memberships.

## Decision

1. **The artifact revokes before it grants, on every install.** Immediately after
   `CREATE OR REPLACE FUNCTION`, the renderer emits: an unconditional
   `REVOKE ALL … FROM PUBLIC`; guarded revokes for `anon`, `authenticated`, and `service_role`
   (the roles Supabase default privileges re-grant at creation — guarded with the repo's
   established `DO $$ … IF EXISTS (SELECT 1 FROM pg_roles …)` idiom, because PGlite lanes and
   non-Supabase clusters lack them); then a guarded `GRANT EXECUTE` per configured role. The
   revokes are unconditional per install because the `DROP FUNCTION` reset means every install
   RECREATES the exposure — convergence must not depend on install history.

2. **Who may execute is named explicitly, and the default is nobody.**
   `grantExecuteTo?: readonly string[]` on the renderer options (beside `functionSchema`) and a
   repeatable `--grant-execute-to` on `pgxsinkit-generate`; default `[]` = owner-only. This is a
   deliberate breaking change: a deployment whose server connects as a non-owner role gets
   `insufficient_privilege` after regenerating until it names that role. Fail-closed and loud at
   the first request beats any guessed default — a default grant to a conventional role name
   (`authenticated`) would rebuild the vulnerability as a default.

3. **The ACL lives INSIDE the fingerprinted body.** The apply-function fingerprint is the only
   enforcement left (ADR-0030 deleted startup verification; the function self-verifies per call),
   and it hashes exactly `buildApplyFunctionBody`. Emitting the grants outside it (like the
   `COMMENT`) would let a stale, PUBLIC-executable install run forever while `--check` stays
   green. In-body, the security posture is part of the artifact's identity: an install without
   the revokes IS a different fingerprint and is refused at call time. A `grantExecuteTo` change
   is a contract change to who may write, and correctly forces the regenerate-and-commit flow.

4. **The mismatch RAISE keeps naming both fingerprints.** Once EXECUTE is owner-plus-named-roles,
   the message's audience is the trusted server; degrading it would cost the one signal that
   makes artifact drift debuggable, to defend against a caller the ACL now excludes.

5. **`public.pgxsinkit_clock_us()` is hardened in the same pass** — same class of exposure
   (PUBLIC + default-privilege grants), trivially closed the same way. It is a harmless
   monotonic-clock read, so it keeps a guarded grant to the Supabase trio (callers legitimately
   include RLS-context sessions); the point is that no pgxsinkit-emitted function relies on
   default privileges.

6. **The ACL is deliberately independent of deployment shape.** pgxsinkit needs no PostgREST, and
   the board stack intentionally omits it — removing the RPC surface entirely is good deployment
   guidance (now recorded in the deploying skill). But the library cannot verify a consumer's
   topology, a "no PostgREST" rule is unenforceable documentation, and lateral movement needs no
   HTTP surface at all — so the control that ships is the ACL, which holds under every topology.

## Consequences

- Every consumer regenerates the sync artifact once (the fingerprint moves) and must pass
  `--grant-execute-to <server role>` unless their server connects as the function owner or a
  superuser. The migration runbook and the deploying skill carry the flag prominently; the
  regenerate flow is the one consumers already run for any artifact change.
- The forged-claims call from a granted server role remains possible BY DESIGN — the server is
  the component trusted to verify claims before passing them. The grant list is therefore the
  entire trust boundary and must name only server roles, never client-facing ones; the deploying
  skill says so in exactly those words.
- Integration coverage now includes the refusal itself: a `SET ROLE authenticated` caller
  invoking the installed function directly gets `insufficient_privilege`, and the same call
  succeeds only after an explicit `grantExecuteTo: ["authenticated"]` install (proving the grant
  path, and documenting the trust semantics of a grant).

## Considered and rejected

- **SECURITY DEFINER with an internal claims check.** Rejected: the function must run
  RLS-governed DML AS the switched role — definer semantics are the wrong tool, and the defense
  is the ACL, not body logic an attacker never reaches.
- **A default grant to `authenticated`** (compatibility-preserving). Rejected: it is precisely
  the exposure being closed; compatibility with a vulnerability is not compatibility worth
  keeping.
- **Emitting the ACL outside the hashed body.** Rejected: grants invisible to the fingerprint
  are grants invisible to the only drift enforcement the system has.
- **Prohibiting PostgREST instead of fixing the ACL.** Rejected: unenforceable from a library,
  fragile in practice (Studio's table editor wants PostgREST back), and irrelevant to
  lateral movement. Recorded as guidance, not as the control.
- **Degrading the fingerprint-mismatch message.** Rejected: post-ACL its audience is trusted,
  and it is load-bearing ops diagnostics.
- **Schema-qualifying the function by default** (it is currently emitted unqualified,
  search_path-resolved; `pgxsinkit_clock_us` is `public.`-qualified). Deferred, not decided
  here: `functionSchema` already exists for deployments that want it, and changing the default
  is a separate behavioral change with its own blast radius. The ACL does not depend on it.
