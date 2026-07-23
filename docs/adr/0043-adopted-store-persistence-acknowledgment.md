# Adopted stores whose persistence cannot be introspected need a named acknowledgment

Status: withdrawn (2026-07-16, unimplemented — the first reopen trigger fired in the same cycle
this was proposed: ADR-0044 shipped the attach one-shot reads, and the motivating consumer is
migrating to the sanctioned worker mode rather than staying on the BYO seam, emptying the known
consumer class. See the withdrawal note in Consequences; the Decision text below is kept as the
record of what was proposed.)

ADR-0036 decision 4 gave the BYO-instance seam (`pgliteInstance` / `precreatedPglite`) a persistence
guard: at adoption the client reads the instance's `dataDir` and refuses `undefined` (PGlite's
in-memory default — the `new PGlite()` a copy-paste reaches) or a `memory://` prefix. The guard's
promise was narrow — catch the two *provably* non-persistent shapes; anything else passes. A real
consumer has now surfaced a third shape the predicate cannot see: a **worker-proxied instance**. The
consumer runs PGlite inside its own dedicated worker under a persistent `idb://` store and hands the
main thread a `PGliteWorker` proxy; the proxy class exposes no `dataDir` at all, so the guard reads
`undefined` and misclassifies a genuinely persistent store as the in-memory default.

Two things are true at once:

1. **The configuration was off-contract but legitimate — at proposal time.** The sanctioned worker
   mode (ADR-0032) runs the whole engine in the worker and attaches tabs — but the S2 attach surface
   had shipped without the one-shot Drizzle reads, so an app whose data layer does direct Drizzle
   reads over the store could not move to it without losing its read path. The consumer's bespoke
   worker topology — a read-path engine over its own `PGliteWorker` under a persistent `idb://`
   store — existed precisely to fill that gap: a workaround for the missing read surface, not an
   independent structural requirement. The seam's type (`PGliteWithLive`) is interface-shaped, so
   the proxy satisfied it and worked. ADR-0044 closed the read-path gap in the same cycle, and the
   consumer is migrating to the sanctioned worker mode rather than staying on the BYO seam.
2. **Both current exits are wrong for this consumer.** `testStoreAcknowledgment()` unlocks the refusal
   but states a falsehood — this is not a test store, and the durability caveats its JSDoc voids are
   exactly the guarantees the consumer relies on. The observed workaround —
   `Object.defineProperty(proxy, "dataDir", { value: "idb://…" })` before handing it in — tells the
   guard the truth, but by a consumer writing a foreign object's property because it knows what our
   classifier reads. That is a private seam discovered by source-diving, not a contract.

## Decision

1. **A named, public acknowledgment for adopted stores.** The main entry (not `/testing`) exports
   `adoptedStoreAcknowledgment(storePath: string)`: options to spread into `createSyncClient`
   declaring "the adopted instance persists under this plain store path; the claim is mine." Same
   mechanics as the test marker (a `Symbol.for`-keyed internal field, for the bundle-duplication
   reason documented in `store-path.ts`); `storePath` follows the ADR-0036 contract (plain name, no
   scheme — scheme-bearing input rejected with the same typed error).
2. **The acknowledgment gates only the BYO refusal.** Creation paths (`storePath`,
   `createClientPGlite`) are untouched — they resolve their own backend and never need it. The
   testing lane is untouched. An acknowledged adoption records the declared store path on the boot
   report, so diagnostics name the store the consumer claimed.
3. **The claim is the caller's own.** The helper's JSDoc carries the ADR-0036 line: a false claim
   (acknowledging a store that is actually memory-backed) voids persistent retention and the
   optimistic journal's durability backstop. Feet and guns beyond the named import are the caller's —
   the contract's promise stays "never *unintentionally*", not "never".
4. **`NonPersistentStoreError` names the third exit.** The refusal message gains the
   worker-proxy case: persist the instance, acknowledge a test store, or — for an adopted instance
   whose persistence the guard cannot see (a proxy) — spread `adoptedStoreAcknowledgment`.

## Alternatives considered

- **Structural proxy detection** (own-property probing, `instanceof PGliteWorker` duck checks).
  Unreliable — a direct instance with the in-memory default also presents `dataDir === undefined`,
  so "property absent" vs "property undefined" cannot carry the distinction — and it couples the
  guard to PGlite worker internals across versions.
- **Bless the consumer-side `dataDir` stamp.** Documenting "write our classifier's input onto the
  proxy" turns a private read into permanent API shaped like a hack; the guard could never read
  anything richer than truthiness again.
- **Upstream: `PGliteWorker` proxies the worker-side `dataDir`.** Right in the long run and worth
  filing, but not ours to schedule, and consumers on current PGlite versions would still be refused.
  If it lands, acknowledged adoptions can start cross-checking the declared path against the
  now-visible real one.
- **Loosen the guard (pass on `undefined`).** Reopens exactly the copy-paste accident ADR-0036
  closed; the false-negative it prevents is strictly worse than the false-positive it causes.

## Consequences

- **Withdrawn 2026-07-16, nothing implemented.** The first reopen/retire trigger — the attach
  surface grows one-shot reads — fired in the same cycle (ADR-0044), and it emptied the known
  consumer class rather than merely narrowing it: the bespoke `PGliteWorker` topology this ADR's
  motivating consumer ran was itself a workaround for the missing read path, not an independent
  requirement, and that consumer is migrating to the sanctioned worker mode. `adoptedStoreAcknowledgment`
  was never built; ADR-0036 decision 4's guard keeps its original two exits.
- Revive if a consumer with a genuinely independent reason to adopt a worker-proxied instance
  surfaces — the Decision above is the shape to build. The upstream alternative (PGlite exposing
  `dataDir` through the proxy, letting the guard verify claims instead of trusting them) remains
  the better fix if it lands first.
