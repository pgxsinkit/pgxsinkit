# 0015 — Entitlement gain is not surfaced mid-session (a re-mint only narrows)

Status: candidate (recorded 2026-08-22)
Opened: 2026-08-22 · Area: `packages/server/src/circuits/subscribe.ts` (`refreshStreamToken`),
`packages/client/src/circuits/group-sync.ts` (`scheduleRestart`, the zero-grant ready branch),
`packages/contracts` (`EntitlementSet`)
Reopen trigger: a consumer needs a scope granted **after** a session started to appear without a
reload or an app-level stop/start. The first such need is any membership flow — a learner added to a
class while their tab is open.

## The fact

- Subscribe is the only place a grant is **created**. `refreshStreamToken` walks
  `verified.claims.grants` and can only drop entries: it re-authorizes the shared tier against
  `permits` and the private tier against the grant's fingerprint, then mints a token for the
  survivors. It never runs `expandToScopes` again, so a scope the subject acquired after subscribe is
  in no re-mint answer.
- The client restarts a group — which is the boot path again: subscribe, reconcile, open readers —
  on exactly three causes: a stream ending, a re-mint that revoked something, a restart that itself
  failed. Nothing fires on "there may be more now".
- A group granted nothing at subscribe reports ready with nothing (deliberately: a boot must not hang
  on an entitlement the subject does not hold) and holds no token — subscribe answers no token for
  zero grants, so there is no re-mint loop either. It has no stream whose death could restart it and
  no re-mint that could be taught to say "re-subscribe": it is the one configuration with no channel
  at all.

So losing a scope is bounded by the token TTL (ADR-0055 d6); gaining one is bounded by the session.
The local store is always a correct **subset** — nothing is applied that the subject may not read —
but the subset is frozen at the last subscribe.

One widening already works, by a side effect of the fingerprint: a private-tier claims change that
compiles to a different predicate fails the re-mint comparison, is revoked, and the restart
re-subscribes with the new claims. What is frozen is shared-tier scope gain, and any shape — either
tier — that was refused at subscribe (there is no grant to revoke, so nothing triggers the restart).

## Options

1. **The re-mint expands.** `refreshStreamToken` re-derives the subject's scopes for every shape the
   session asked for and answers `granted` beside `revoked`; the client opens readers for what is
   new. Cost: the token names grants, not requests, so the refresh body (or the token) has to carry
   the requested shape list; and the client's refresh path grows most of subscribe's machinery
   (handle comparison and reader open — not the reconcile). Each new grant is one engine join, the
   same as at subscribe, so this lands on 0013's ledger too.
2. **Timed restart.** The restart is already a complete re-subscribe, and its close releases the
   previous session's claims, so it is claim-neutral. Cost: one reconcile transaction and handle
   comparison per tick for no change most of the time, and the cadence is a guess — and it does
   nothing for the zero-grant group unless that group, too, is put on the timer.
3. **The re-mint says "changed".** The entitlement set is already a live shape on the edge
   (ADR-0055 d7), so it can know when a subject's scopes changed; the re-mint answer carries a
   `resubscribe` flag when they changed since the token's `iat`, and the client treats it exactly like
   a revocation — restart the group. No new client path; one interface addition on `EntitlementSet`
   (a per-subject version, or `changedSince(subject, at)`). It still needs an answer for the
   zero-grant group, which has no re-mint: subscribe mints an **empty** token so the refresh loop
   runs, or that group alone gets a timed re-subscribe.

Option 3 is the recommended shape: the trigger is a fact the edge already holds, the client does
nothing it does not already do, and the cost is one contract-level addition. Options 1 and 2 buy the
same result with either a second subscribe-like path or a guessed cadence.

## Why it is a candidate rather than a plan

No consumer has yet needed the gain to land in an open tab; a reload, or an app-level stop and start,
shows the new scope. Until a flow needs more, the frozen-subset behaviour is stated where a reader
would look for it (ADR-0055 d6 and the operating-in-production page) rather than closed.
