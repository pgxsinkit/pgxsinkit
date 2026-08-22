# 0016 — Runtime `params` are declared end to end and wired nowhere

Status: candidate (recorded 2026-08-22)
Opened: 2026-08-22 · Area: `packages/server/src/index.ts` (`createSyncServer` →
`readPath.resolveShapeParams`), `packages/server/src/circuits/{subscribe,edge,compile}.ts` (`params`),
`packages/contracts/src/config.ts` (`customPredicate(claims, params?)`, `RowTransformContext.params`),
`packages/test-utils/src/native-read-path.ts`
Reopen trigger: a registry author writes a `customPredicate` or a `rowTransform` that reads `params`,
or a deployment needs a per-environment value in a predicate that is not a claim (a tenant allow-list,
a flag) — or the next time either contract type is touched for any other reason.

## The fact

- The contract offers `params` twice: `rowFilter.customPredicate(claims, params?)` and
  `RowTransformContext.params`.
- The server offers three ways to supply them: `createSyncServer({ readPath: { resolveShapeParams } })`
  (per request), `SubscribeOptions.params` at handler level (`createSubscribeHandler`,
  `createRefreshHandler` and `refreshStreamToken` all forward it into compile), and
  `StreamGateOptions.params` (forwarded into the egress transform's context).
- None is connected. `createSyncServer` declares `resolveShapeParams` and never reads it — the
  `subscribeOptions` it builds carry no `params`. No mount — `startNativeReadPath`, board-api, the
  placement fixture, the perf lab — passes `params` to `createStreamGate`; `startNativeReadPath` even
  accepts `resolveShapeParams` and forwards it into `readPath`, where it is dead. No predicate or
  transform in this repository or in its consumers reads `params` (2026-08-22).
- So a predicate or transform that did read `params` would see `undefined` on every path —
  subscribe, re-mint, egress — silently: `params?.x ?? fallback` takes the fallback everywhere, and
  nothing refuses. A deployment that wired one side by hand (the handler-level option is public)
  would hand one registry entry two runtime environments, which the docstring on
  `StreamGateOptions.params` warns against without anything enforcing it.

## Why it is more than plumbing

The three supply points disagree on shape: per request (`resolveShapeParams(request)`), per handler
(static), per gate (static). Per-request params collide with the private-tier fingerprint (ADR-0055
d6, amended 2026-08-22): the fingerprint is taken over the compiled shape request, so params that
differ between a subject's subscribe and its re-mint read as "predicate changed for this subject" and
revoke on every TTL. Params therefore have to be a function of the deployment — never of the
individual request — or the fingerprint has to exclude them, which reopens what the fingerprint is
for.

## The fix (one of two)

- **A. Make them real and deployment-scoped.** One static `readPath.params` on `createSyncServer`,
  forwarded into subscribe/refresh AND handed to `createStreamGate` by the same mount from the same
  object; delete `resolveShapeParams`. The fingerprint stays sound because params are constant per
  deployment. Document the second argument in registry-authoring as "deployment constants".
- **B. Remove the surface.** Delete `params` from `customPredicate`, `RowTransformContext`, the three
  option types and `startNativeReadPath`. Nothing uses it; the documented model is claims-driven
  predicates, and a deployment constant can be closed over where the registry is built.

B is the smaller change and the honest one given zero use, but `customPredicate` and
`RowTransformContext` are public contract types, so either way it is a breaking commit. Whichever is
taken, the dead `resolveShapeParams` on `createSyncServer` goes: an option the server silently
ignores is worse than no option.
