# Ordinary writes activate their lazy group; claims-dependent groups warn on anonymous activation

Status: accepted (2026-07-13).

Two lazy-group footguns were documented on 2026-07-13 (write-path "Lazy read/write groups need an
echo"; registry-entry-options "Gate authenticated lazy groups until auth is resolved") and both turned
out to be library-fixable rather than docs-only:

1. **A write is a reference, but only reads activated.** ADR-0021 established that *referencing* a
   `lazy` relation activates its whole consistency group — the compiled-SQL scan makes every read do
   this implicitly. An ordinary optimistic `create`/`update`/`delete` is a reference too, yet the
   mutation path never activated: the server could accept the write while the acked journal row sat
   waiting for a committed echo no open shape could deliver. The documented workaround — mount a
   non-rendering "activator" live query before first write — is the user hand-implementing what the
   read path already does automatically.
2. **Anonymous first activation of an authenticated-only group is silent.** A live query mounted while
   auth is still resolving activates its lazy group with the claims of that moment; a row filter that
   denies anonymous callers then opens an empty subscription (persisted across boots under
   `persistent` retention), and a later auth change has to rotate/refetch the shape. Nothing surfaced
   this at the moment it happened — the symptom was "no rows", later and elsewhere.

## Decision

1. **Ordinary optimistic enqueue activates the target's consistency group.** The mutation runtime
   exposes an internal enqueue hook reporting the distinct **non-blind** table keys of every planned
   batch (the per-table helpers and the `transaction` block both funnel through batch planning, so one
   choke point covers every path in both direct and worker mode). The client wires it to a
   **fire-and-forget** `ensureSynced` — enqueue never blocks on the network; the group only has to be
   open by the time the echo returns, and a failed start self-heals exactly like any lazy activation
   (the acked row retires whenever the group next activates).
2. **`updateBlind` stays exempt.** A blind write plans a journal row only — no overlay, retired on the
   authoritative ack with no echo barrier (ADR-0022 addendum). Activating would destroy the write-only
   pattern (a fully provisioned local table that never streams a row), which is that API's purpose.
3. **Claims-dependence is probed, not declared.** A row filter is *claims-dependent* when its
   `customWhere`, evaluated with empty claims (`{}` — exactly what the proxy passes for an
   unauthenticated request), returns the `DENY_ALL` sentinel (reference identity) or throws.
   `ownershipFilter` and the other contracts helpers already return the shared sentinel, and returning
   `DENY_ALL` is already the documented deny-anonymous pattern — so the common case needs no new
   registry surface at all. The probe is legitimate because `customWhere` is already required to be
   pure (the proxy calls it fresh on every shape request); its JSDoc now says so explicitly.
4. **Anonymous activation of a claims-dependent group warns, never blocks.** When a lazy group is
   activated (by read, or now by write) and any member's filter probes claims-dependent, the client
   checks the auth token fire-and-forget; if none is available it emits a `console.warn` (plus a
   `syncDebug` line) naming the group and pointing at `ready`-gating. Warning-grade only: anonymous
   access is a first-class configuration, and the library cannot know intent — but activating a
   deny-anonymous group with no token is *always* a misstep (the subscription is empty by
   construction), so the warning is unconditional, not debug-gated.

## Rejected alternatives

- **A lint rule** (the repo already ships an oxlint plugin): auth timing is a runtime property —
  whether a `ready` expression actually gates on session resolution is invisible statically. Either
  noisy or blind.
- **A tri-state auth signal** (`unresolved | anonymous | authenticated`) with activation gating: the
  "correct" fix, but new provider-contract surface disproportionate to what decisions 3–4 achieve
  with none.
- **A declared `authenticated: true` registry flag**: subsumed by the sentinel probe for every helper
  path; a custom filter that denies anonymously via anything other than `DENY_ALL` should switch to
  the sentinel (machine-visible, and already the documented pattern) rather than grow a parallel flag.
- **Contract note "`getAuthToken` may stay pending until auth resolves"**: works (Electric resolves
  header functions per request), but it is documentation again, and a broken provider wedges every
  shape silently.
