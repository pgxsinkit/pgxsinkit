---
name: deploying
description: >-
  Load when deploying the @pgxsinkit/server write API and Electric shape proxy onto Bun, Deno, Supabase
  Edge Functions, or Cloudflare Workers. Covers the runtime-portable fetch handler, the three concrete
  steps a non-Bun edge runtime needs (bundle the function so Deno can load the toolkit's bare specifiers
  with node: builtins, strip the function-name path prefix before server.fetch, resolve claims from the
  platform JWT in resolveAuthClaims), splitting write and sync into two functions, setting the worker
  timeout above Electric's ~25s long-poll, and forcing cache-control:no-store on a same-origin shape
  proxy. Load before deploying the server or wiring it into an edge platform.
metadata:
  type: task
  library: "@pgxsinkit/server"
  library_version: "0.1.32"
  source: https://pgxsinkit.github.io/start/deploying-the-server/
---

# Deploying the pgxsinkit server

The server is a web-standard `fetch` handler, so it runs unmodified anywhere that speaks
`Request -> Response`. "Unmodified" is true at the API level; the steps below are about the runtime
around it, not the toolkit. On **Bun**, `export default { fetch: server.fetch }` (or `server.start()`,
the only Bun-specific helper) and you are done. The rest applies to Deno / Edge.

## 1. Bundle the function (Deno will not load the toolkit source directly)

The packages import dependencies with bare, extensionless specifiers (the Node/bundler convention),
which Deno's strict resolver rejects, and your registry package is usually unpublished. Bundle each
function into one self-contained ESM file ahead of time (`bun build` / esbuild, `target: "node"`,
`format: "esm"`). **The easy miss:** with `target: "node"`, Bun leaves builtins external but **bare**
(`import net from "net"`); Deno only resolves them under the `node:` scheme, so add an `onResolve` plugin
that rewrites every builtin to `node:*`. Everything else (drizzle, zod, the toolkit, your registry, plus
any framework you chose) inlines.

## 2. Strip the function-name path prefix before `server.fetch`

Edge Functions route by the first path segment, so a POST to `/functions/v1/write` arrives as `/write`.
The mutation route is served at `/mutations` (and `/api/mutations`), deployment-name-agnostic by design —
rewrite the path first, exactly as a reverse proxy would:

```ts
Deno.serve((request) => {
  const url = new URL(request.url);
  url.pathname = "/mutations"; // /write or /write/... -> /mutations
  return server.fetch(new Request(url, request));
});
```

The **read** path needs no rewrite: `proxyElectricShapeRequest` keys off the query string, not the path.

## 3. Resolve claims from the platform JWT in `resolveAuthClaims`

`verify_jwt` is a gateway concept; the portable move is to verify the token yourself and return its
claims (or `null` to fail closed — the proxy then blocks all rows and the write route rejects). A GoTrue
access token is already `JwtClaims`-shaped (`sub`, top-level `role`, `app_metadata`), so return it
directly after verifying. The applier reads `role` to switch the RLS actor; the read proxy reads `sub` +
`app_metadata.roles` for the row filter. Both paths share this one adapter, so authorization cannot
drift.

## Read vs write as two functions (a deployment choice)

- **write** — `createSyncServer({ registry, db, resolveAuthClaims })` **without** `electricUrl` registers
  only the mutation route; wrap with the path rewrite above.
- **sync** — call `proxyElectricShapeRequest(request, claims, { registry, electricUrl })` directly. No
  rewrite. **Set the function's idle/wall-clock timeout above Electric's bounded long-poll (~25s)** so a
  live subscription is not recycled mid-cycle. If it is a **same-origin proxy with no CDN**, force
  `cache-control: no-store` on the response, or a rotated shape handle serves stale and the client loops
  on 409s.

Both import the same registry and share `resolveAuthClaims`, which keeps the two ingress points honest.

## Cold starts and the connection budget

On a serverless edge the first write after idle pays a cold start while steady-state writes are instant —
a property of the platform, not the toolkit (a long-lived Bun/Deno process has none). And a browser opens
**one long-poll connection per synced shape**, so over HTTP/1.1 the ~6-per-origin cap starves writes —
serve the gateway over **HTTP/2**. Both are covered, with the warming recipe and the connection-budget
detail, in the `operating` skill (`@pgxsinkit/client`).

## Common mistakes

- Shipping toolkit source to Deno without bundling, or leaving builtins un-prefixed (not `node:*`).
- Forgetting the path rewrite, so `/mutations` 404s behind the function name.
- Verifying the JWT only at the gateway instead of in `resolveAuthClaims` (non-portable).
- A sync function timeout below Electric's ~25s long-poll (constant read-path reconnects).
- Omitting `cache-control: no-store` on a same-origin shape proxy.

Full prose: <https://pgxsinkit.github.io/start/deploying-the-server/>.
