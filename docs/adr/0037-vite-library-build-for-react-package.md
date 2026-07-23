# Vite library build for the React package

Status: accepted (2026-07-11). Supersedes
[ADR-0008](0008-docs-prove-interface.md) Decision 4 for the React package — its "a Vite / React
Native bundler can consume it unchanged, so `target: "bun"` stays" conclusion was drawn from
evidence that never covered `react` and is falsified below; it stands for the other packages.

`scripts/build-public-packages.ts` bundled all four public packages with `Bun.build({ target: "bun", packages: "external" })`. For the three runtime-agnostic packages that path is fine, but for `@pgxsinkit/react` it shipped a broken production artifact twice over:

1. **Development JSX runtime in the published bundle.** `Bun.build()` compiled the package's JSX
   (`SyncClientProvider`) against `react/jsx-dev-runtime`, and no probed combination of
   `NODE_ENV=production`, `minify: true`, or `jsx: { development: false }` on the current
   `Bun.build()` API changed that. A downstream Vite PRODUCTION build rewrites the dev-runtime
   module to `jsxDEV = undefined` while keeping the bundle's `jsxDEV(...)` call, so the published
   component imports cleanly, passes every `typeof` probe — and throws
   `TypeError: (0, import_jsx_dev_runtime.jsxDEV) is not a function` the first time it renders.
   Confirmed against a real downstream production deployment and its local `vite preview`.
2. **Inlined dependencies.** Despite `packages: "external"`, the emitted bundle carried a full copy
   of `@pgxsinkit/client` (a declared dependency the consumer installs anyway) and, transitively,
   drizzle-orm's entity machinery — a second copy of the client in every downstream app bundle, and
   bare imports (`zod`, `@electric-sql/client`) the react manifest never declared.

## Decision

1. **The React package builds through Vite library mode; the other public packages stay on
   `Bun.build`.** `packages/react/vite.config.ts` owns the library-mode contract; the build list in
   `scripts/build-public-packages.ts` carries a per-package `bundler` field and spawns the vite bin
   for `packages/react` exactly as it already spawns `tsc` for declarations. The browser-oriented
   React package is not forced onto a `target: "bun"` bundler for uniformity's sake; equally,
   nothing else moves to Vite without its own reason.
2. **The artifact contract is pinned by a built-artifact test.**
   `tests/unit/react-package-build.test.ts` builds the real bundle through the same code path and
   asserts: production JSX runtime only (`react/jsx-runtime`, never `jsxDEV` /
   `react/jsx-dev-runtime`); every static import is declared in the package manifest (react stays
   external and un-duplicated, `@pgxsinkit/client` stays external, no inlined drizzle-orm); an
   external source map. The declaration emit (`tsconfig.dts.json` via tsc) and the package
   `exports` map are unchanged.
3. **The production JSX transform is pinned twice, independent of ambient env.** Vite derives the
   dev JSX transform from the ambient `NODE_ENV` (a build spawned under `bun test` inherits
   `NODE_ENV=test` and silently re-emits `jsxDEV`), so the vite config hard-sets
   `oxc.jsx.development: false` AND the build script pins `NODE_ENV=production` on the spawned
   process.
4. **The packed-downstream fixture (ADR-0008) gains a production Vite consumer that RENDERS.**
   `scripts/fixture-smoke.ts` now builds a consumer app through a real production Vite pipeline
   against the packed tarballs and executes `renderToString(<SyncClientProvider …>)` from the
   produced bundle. Import-time probes cannot catch this failure class — only a production-built
   render can — and this is the lane that would have caught the bug before publish.
5. **The fixture also typechecks the consumer and derives its peer table.** A strict `tsc --noEmit`
   over the fixture app proves the PUBLISHED type surface — the packed d.ts graph as a downstream
   use site consumes it — which every runtime lane is blind to (Bun strips types). Its first run
   caught a real one: `client.views.<name>` (the documented reactive-read surface) had never
   compiled for any consumer, because `defineSyncTable` added `view` via a conditional spread and
   the optional property failed `RegistryViews`' `extends { view: AnyPgView }` filter — fixed by
   capturing the mode literal and making `view` an always-present, conditionally-typed key
   (`tests/registry-views-types.ts` pins it). The fixture's peer-dependency table is now derived
   from the package manifests (conflicting ranges fail the smoke) instead of a manual list that had
   already drifted once.
