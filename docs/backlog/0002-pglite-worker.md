# 0002 — Move the client onto PGliteWorker

Status: promoted → adr/0032
Superseded: ADR-0032 decides the FULL move — the whole engine (not just PGlite) runs in a SharedWorker; this item's evidence (main-thread costs) is the measurement record.
Opened: 2026-07-03 · Area: client-sync
Reopen trigger: main-thread jank attributable to PGlite shows up in a real consumer (long tasks
during reconcile/first paint in profiles), or PGlite's worker + extensions story simplifies enough
to make the migration cheap.

## Problem / evidence

PGlite executes **on the main thread** in this stack: `@electric-sql/pglite` 0.5.4's entry spawns
no Worker, and neither `packages/client` nor `apps/board` uses `PGliteWorker`. Consequences
measured on the board demo (2026-07-03 boot-latency lane):

- initdb + IDBFS open ≈ **1.9s** of main-thread WASM per store creation (now hidden behind
  login-screen think-time by the spare-store pattern, and gated so it never runs behind a live
  board — but any consumer without that pattern pays it on-thread);
- every PGlite query carries ~**50ms** of WASM work on that same thread (documented in
  operating-in-production);
- the board's **first** reconcile measured 1,485ms vs ~160ms steady-state, with React's initial
  render sharing the thread.

Two concurrent PGlite instances (e.g. the spare store + the active store) are fully independent
engines — separate WASM memories and IndexedDB stores — so the only coupling is main-thread time.

## Next step when reopened

> **Shipped in ADR-0032 (S1–S4).** The scoping below is the pre-implementation plan, kept as the
> reasoning record — the actual build decoupled the engine from the create-time extension (S1) and moved
> the _whole_ engine (not just PGlite) into a `SharedWorker` (S2–S4), which is why every seam it flags
> below (the extension coupling, the `live` notifications crossing the boundary, the spare-store /
> `precreatedPglite` equivalents) was resolved.

Scope the migration honestly before committing — it is a project, not a patch:

- the sync engine is a **PGlite extension** (`extensions: { electric: … }`), so it rides into the
  worker context; PGliteWorker requires extensions to be registered in the worker script, which
  moves `createElectricExtension` (and the network fetch loop) off-main-thread too — likely a
  feature, but every main-thread seam (syncDebug rail, fetchClient instrumentation, auth token
  callback) needs a message-boundary story;
- the `live` extension's change notifications cross the worker boundary (PGliteWorker supports
  this; verify with the react hooks' remap layer);
- Vite worker bundling for consumers (the board is the reference), and the spare-store /
  `createClientPGlite` / `precreatedPglite` seams need worker-compatible equivalents.
