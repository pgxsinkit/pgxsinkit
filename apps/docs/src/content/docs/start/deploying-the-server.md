---
title: Deploying the server
description: Run the pgxsinkit server on Bun, Deno, or Supabase Edge Functions — bundling, path rewrites, and resolving claims from a platform JWT.
---

import { Steps, Aside } from "@astrojs/starlight/components";

The server is a web-standard `fetch` handler, so it runs unmodified anywhere that speaks
`Request → Response`. "Unmodified" is true at the **API** level — the few concrete steps below are
about the runtime around it, not the toolkit code.

## Bun

The trivial case. Either export the handler, or use the bundled `start()` helper:

```ts
const server = createSyncServer({ registry, db, electricUrl, resolveAuthClaims });
export default { fetch: server.fetch }; // Bun.serve picks this up
// or: await server.start();           // the only Bun-specific helper
```

## Deno / Supabase Edge Functions

Deno runs TypeScript natively, so there is no inherent build step. How you feed it the toolkit
decides whether you need one:

- **Importing the published `npm:@pgxsinkit/server`** (built, with proper `exports`) — Deno resolves
  it directly. No bundle, no flags; write your function as raw TS and deploy. This is the path most
  adopters want.
- **Importing unbuilt workspace source** (a monorepo where the toolkit lives next to your app) — Deno
  rejects the source's extensionless relative imports, so you either enable Deno's `sloppy-imports`
  unstable flag, or **bundle** each function ahead of time. Bundling needs zero runtime resolution,
  so it runs on any Edge runtime version offline — the trade is a build step. The board demo bundles
  for exactly this reason (it consumes the toolkit as unpublished workspace source).

The rest of this section covers the bundle path plus the two runtime concerns (path prefix, claims)
that apply **either way**. None are toolkit limitations — they are how Deno and the Edge platform
work — but you will hit them, so here they are with their fixes.

<Steps>

1. **Bundle the function — Deno will not load the toolkit source directly.** The packages import
   their dependencies with bare, extensionless specifiers (the Node/bundler convention), which Deno's
   strict resolver rejects; and your own registry package is usually unpublished, so there is no
   `npm:` form for it. Bundle each function into one self-contained ESM file ahead of time:

   ```ts
   // build-functions.ts — run with `bun build` (or esbuild)
   import { builtinModules } from "node:module";

   await Bun.build({
     entrypoints: ["functions/write/index.ts"],
     outdir: "functions-dist/write",
     target: "node", // keep node:* builtins external; Deno provides them
     format: "esm",
     plugins: [
       {
         name: "node-protocol-externals",
         setup(build) {
           const builtins = new Set(builtinModules);
           build.onResolve({ filter: /.*/ }, (args) => {
             const bare = args.path.replace(/^node:/, "");
             // Bun externalizes builtins as BARE (`"net"`); Deno only resolves them as `node:net`.
             return builtins.has(bare) ? { path: `node:${bare}`, external: true } : undefined;
           });
         },
       },
     ],
   });
   ```

   <Aside type="caution" title="The node: prefix is the easy one to miss">
     With `target: "node"`, Bun leaves builtins external but **bare** (`import net from "net"`). Deno
     only resolves builtins under the `node:` scheme, so the un-prefixed import fails to load. The
     `onResolve` plugin above rewrites every builtin to `node:*`. Everything else — drizzle, hono,
     zod, the toolkit, your registry — is inlined.
   </Aside>

2. **Strip the function-name prefix before `server.fetch`.** Edge Functions route by the first path
   segment, so a POST to `/functions/v1/write` arrives at your worker as `/write`. The mutation route
   is served at `/mutations` (and `/api/mutations`), deployment-name-agnostic by design — so rewrite
   the path first, exactly as a reverse proxy in front of the server would:

   ```ts
   const server = createSyncServer({ registry, db, resolveAuthClaims });

   Deno.serve((request) => {
     const url = new URL(request.url);
     // /write or /write/... → /mutations
     url.pathname = "/mutations";
     return server.fetch(new Request(url, request));
   });
   ```

   The **read** path needs no rewrite: `proxyElectricShapeRequest` keys off the query string, not the
   path, so a shape-proxy function can hand it the request as-is.

3. **Resolve claims from the platform JWT in `resolveAuthClaims`.** `verify_jwt` is a gateway
   concept; the portable move is to verify the token yourself and return its claims. A GoTrue access
   token is already `JwtClaims`-shaped — `sub`, a top-level `role` (the Postgres role), and
   `app_metadata` — so once verified you return it directly:

   ```ts
   async function resolveAuthClaims(request: Request): Promise<JwtClaims | null> {
     const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
     if (!token) return null; // fail closed: the proxy blocks all rows, the write route rejects
     return await verifyHs256(token, Deno.env.get("JWT_SECRET")!); // your HS256 verify → claims | null
   }
   ```

   The applier reads `role` to switch the RLS actor and `app_metadata.roles` for any admin predicate;
   the read proxy reads `sub` + `app_metadata.roles` for the row filter. Both paths share this one
   adapter, so read and write authorization can never drift.

</Steps>

### Read vs write as two functions

Splitting the write route and the shape proxy into two deployments (e.g. a `write` function and a
`sync` function) is a deployment choice, not a toolkit one:

- **write** — `createSyncServer({ registry, db, resolveAuthClaims })` **without** `electricUrl`
  registers only the mutation route. Wrap with the path rewrite from step 2.
- **sync** — call `proxyElectricShapeRequest(request, claims, { registry, electricUrl })` directly.
  No rewrite needed. Set the function's idle/wall-clock timeout **above** Electric's bounded
  long-poll (~25s) so live updates are not cut off mid-cycle.

Both import the same registry and share the same `resolveAuthClaims`, which is what keeps the two
ingress points honest.

<Aside type="note" title="Edge cold starts are a platform property, not a toolkit cost">
  On a serverless Edge platform a worker is suspended when idle and evicted after longer idle, so the
  first request after a quiet period pays a cold start — re-importing the bundle and re-establishing the
  Postgres connection. The convergence machinery is fast (the write applies in a few ms, the echo streams
  back in well under a second), so this shows up as the first write *after idle* lagging while steady-state
  writes are instant. Two mitigations, both platform-level: keep the worker warm with a periodic cheap
  request, and set the worker's wall-clock budget **above** your busiest held-open shape long-poll so a
  live subscription is not recycled mid-cycle (forcing a read-path reconnect). A long-lived **Bun** (or
  Deno) deployment has neither characteristic — one warm process, a pooled connection, no per-request
  worker lifecycle — which is the simplest answer if first-write latency matters more than serverless
  scale-to-zero.
</Aside>
