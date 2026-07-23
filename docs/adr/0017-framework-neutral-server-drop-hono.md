# Framework-neutral server: drop the Hono dependency

Status: accepted (2026-06-25)

`@pgxsinkit/server` was built on [Hono](https://hono.dev). Hono is a fine framework, but here it had
leaked into the **public API** and become a required dependency, which is at odds with what the server
actually is and what the docs now claim about it:

- `CreateSyncServerOptions.app?: Hono` and the exported `registerMutationRoute(app: Hono, …)` made Hono
  a **public type**. A consumer could not use the server's composable seam without depending on Hono.
- `hono` was a `peerDependency`, so every consumer installed it — even though the server's job is to be a
  web-standard `fetch` handler that "runs on any `fetch` runtime" (Bun, Deno, Supabase Edge, Workers).
- The shape proxy (`proxyElectricShapeRequest`) was **already** a plain `(Request) => Response` function;
  only routing, a small CORS layer, and an error boundary actually used Hono. That is a few dozen lines,
  not a framework.

At the time of this decision pgxsinkit had no supported release or external consumers, so removing
the Hono-typed surface is a free, clean break rather than a migration.

## Decision

1. **Remove Hono from `@pgxsinkit/server`.** Replace it with a small internal `FetchRouter`
   (`packages/server/src/router.ts`): exact-path `GET`/`POST` routing, a CORS layer matched by scope
   (the `/api/*` prefix and the shape-proxy path), and an error boundary. The
   mutation route handler is refactored from a Hono `Context` to a plain `(Request) => Promise<Response>`
   using `Response.json`. `proxyElectricShapeRequest` is unchanged.

2. **Replace the Hono-typed integration seam with framework-neutral composable handlers.** Drop
   `CreateSyncServerOptions.app?: Hono` and the `registerMutationRoute(app: Hono, …)` export. Instead
   export `createMutationHandler(…) → (Request) => Promise<Response>`, `batchMutationPaths`, the standalone
   `proxyElectricShapeRequest`, and `FetchRouter`. Anyone integrating pgxsinkit into their own server
   (Hono, Express, an edge runtime, …) mounts these handlers directly — which is **more** general than a
   Hono-only `app` option, not less.

3. **Hono stays only as a repository dev dependency** — the perf-lab harness server
   (`scripts/perf-lab-server.ts`) and the edge-function bundling import map use it. It is no longer a
   dependency of any **published** package, nor of the minimal reference server (`apps/write-api`), which
   now runs with zero framework dependencies.

## Consequences

- `@pgxsinkit/server` depends only on `@pgxsinkit/contracts` (plus the `drizzle-orm` peer). The "any
  `fetch` runtime" claim is now literally true — no framework to learn, pin, or bundle.
- **Breaking API change:** the `app` option and the `registerMutationRoute` export are gone. Acceptable
  before the supported `0.2.0` baseline, and the replacement seam is strictly more capable.
- CORS is now ours to maintain. It is a small, tested surface (preflight + allowed-origin echo over the
  defined scopes); parity with the previous behaviour is pinned by the `write-api` CORS integration test.
- The three integration tests that mounted a custom Hono shape-proxy now use the built-in proxy at a
  custom `shapeProxyPath`, so they exercise the real server path rather than a bespoke wrapper.
