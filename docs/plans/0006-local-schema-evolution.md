# Plan — ADR-0006: Local schema evolution & mutation compatibility

Implements [ADR-0006](../adr/0006-local-schema-evolution.md). Goal: a defined,
bounded, non-lossy-by-default local upgrade; a fingerprint-stamped journal with a
transient/permanent failure split; an authoring-time registry-diff gate; and a
default-safe runtime that respects the library/consumer boundary.

Depends on: [ADR-0004](../adr/0004-one-registry-interpreter.md) fingerprint.

## Phase 1 — Versioned local store + drain-then-drop

- Derive the local-DB version key from the registry fingerprint (replace the manual
  `idb://…-v1`). On boot, compare the stored fingerprint to the current one.
- On mismatch (online): **drain** (flush + confirm acks), then **drop+resync the
  read cache only** — preserve the journal/overlay tables; do not nuke the whole DB.
- Add a `dropReadCache(registry)` primitive (the drop reused by ADR-0005
  `destroy()`).
- Tests (PGlite harness): fingerprint change triggers read-cache rebuild; journal
  survives; a clean (no-pending) upgrade round-trips.

## Phase 2 — Journal version-stamp + transient/permanent failure split

- Add a `registry_version` column to the journal DDL (`client/src/schema.ts`);
  stamp it at enqueue from the current fingerprint.
- Split `failed`: a 4xx structural rejection → `quarantined` (terminal, not
  retried); network/5xx → `failed` (retryable, as today). Drive off
  `last_http_status`.
- Surface quarantined mutations via a client callback / diagnostics
  (`readMutationDetails` already carries `last_error`/`last_http_status`).
- Tests: a boundary-crossing mutation is detectable pre-send; a 4xx → quarantined,
  not retry-looped; a 5xx → retried.

## Phase 3 — Registry-diff classifier + check (mechanism, library-owned)

- New `compareRegistries(previous, next)` in `contracts` → per-change detail +
  classification `compatible | risky | breaking`. Breaking = dropped/renamed/
  repurposed column, new `NOT NULL` w/o default, PK change, table removal.
- A runnable check (bin + exported fn): `registry-check --against <lock>` exits
  non-zero on breaking; writes/updates a `registry.lock` (fingerprint + shape
  snapshot) the consumer commits.
- Tests: classifier truth table over representative diffs; check exit codes; lock
  round-trip.
- Docs: the consumer wires the check + commits the lock; pgxsinkit does not enforce
  their CI (see ADR-0006 decision 7).

## Phase 4 — Expand/contract guidance + default-safe runtime

- Document expand/contract as _the_ registry-evolution discipline (a runbook).
- Confirm the runtime default on fingerprint mismatch is quarantine + surface +
  continue (never refuse-to-start); add an opt-in hard-block flag for consumers who
  want it.

## Deferred (out of scope)

Lossless offline upgrade: block-until-drained (needs old schema retained) or offline
journal replay/re-mapping across a registry boundary (needs journal identity stable
across renames). Revisit on real demand.

## Acceptance

- `compareRegistries` + `runRegistryCheck` + `registry.lock` shipped with tests; the
  silent-repurposing case is caught at authoring time; expand/contract documented.
  **(Phase 3 + Phase 4 done — `registry-diff.ts`, `tests/unit/registry-diff.test.ts`,
  `docs/registry-evolution.md`)**
- Fingerprint-keyed store; drain-then-drop preserves the journal; tests green.
  **(Phase 1 done — `local-store.ts` + `pgxsinkit_local_meta`; unit + cross-boot integration)**
- Journal stamped; transient vs permanent split; quarantine surfaced. **(Phase 2 done —
  `registry_version` column + `classifyFailureStatus` + `onQuarantine` + the hard attempt
  cap; `tests/unit/mutation-quarantine.test.ts`)**
- `dropReadCache` primitive **(done — `buildDropReadCacheSql` + `client.dropReadCache()`).**
