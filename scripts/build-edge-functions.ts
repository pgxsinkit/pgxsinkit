/**
 * Bundles the board's Deno Edge functions into self-contained ESM modules.
 *
 * Why bundle at all? The functions consume `@pgxsinkit/*` (and the demo-local `@pgxsinkit/board-schema`)
 * as workspace source. Deno will not load that source directly — it imports its dependencies with
 * bare and extensionless specifiers (a bundler/Node convention), which Deno's strict resolver
 * rejects, and `@pgxsinkit/board-schema` is unpublished so there is no `npm:` form. Bundling resolves
 * every workspace + npm import ahead of time and emits one file per function with only `node:*`
 * builtins left external — which the Edge runtime (Deno) provides natively. The result drops into
 * `supabase/functions-dist/<name>/index.js`, exactly the layout the edge-runtime main router expects.
 *
 * This is the board's realization of the toolkit's "runtime-portable fetch handler" claim across the
 * Bun→Deno boundary; see apps/board/docs/consumer-review.md (Phase 2) for the consumption finding.
 */

import { rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

import type { BunPlugin } from "bun";

const FUNCTIONS = ["main", "board-write", "board-sync"] as const;
const SOURCE_ROOT = "supabase/functions";
const DIST_ROOT = "supabase/functions-dist";

// Bun's `target: "node"` leaves builtins external but as BARE specifiers (`import net from "net"`).
// Deno only resolves builtins under the `node:` scheme, so a bare `"net"` import would fail to load
// in the Edge runtime. This plugin normalizes every builtin (postgres.js reaches for net/tls/crypto/
// stream/os/…) to its `node:` form and keeps it external for Deno to provide.
const nodeProtocolPlugin: BunPlugin = {
  name: "node-protocol-externals",
  setup(build) {
    const builtins = new Set(builtinModules);
    build.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.startsWith("node:") ? args.path.slice("node:".length) : args.path;
      if (builtins.has(bare)) {
        return { path: `node:${bare}`, external: true };
      }
      return undefined;
    });
  },
};

async function buildOne(name: string): Promise<void> {
  const entrypoint = join(SOURCE_ROOT, name, "index.ts");
  const outdir = join(DIST_ROOT, name);

  rmSync(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    // `node` keeps `node:*` builtins external (postgres.js depends on node:net/tls/stream); Deno
    // resolves those at runtime. Everything else — drizzle, hono, zod, the toolkit, board-schema —
    // is inlined so the Edge runtime needs no import map and no network module fetch.
    target: "node",
    format: "esm",
    sourcemap: "none",
    minify: false,
    plugins: [nodeProtocolPlugin],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Failed to bundle Edge function '${name}'.`);
  }

  const [artifact] = result.outputs;
  console.log(`✓ ${name} → ${outdir}/index.js (${artifact ? (artifact.size / 1024).toFixed(0) : "?"} KiB)`);
}

async function main(): Promise<void> {
  rmSync(DIST_ROOT, { recursive: true, force: true });
  for (const name of FUNCTIONS) {
    await buildOne(name);
  }
  console.log(`\nBundled ${FUNCTIONS.length} Edge functions into ${DIST_ROOT}/.`);
}

await main();
