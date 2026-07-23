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

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

import type { BunPlugin } from "bun";

// Only the board functions are bundled (they pull unpublished @pgxsinkit/* source). `main` is the
// OFFICIAL Supabase edge-runtime router, vendored unmodified — it runs as raw TS (it imports `jose`
// from a URL, which a bundler can't inline), so it is copied verbatim, not built.
const BUNDLED = ["board-write", "board-sync"] as const;
const SOURCE_ROOT = "supabase/functions";
const DIST_ROOT = "supabase/functions-dist";

// What we bundle vs. what Deno loads at runtime:
//
// We bundle ONLY the unpublished `@pgxsinkit/*` workspace source (which Deno cannot load directly —
// extensionless imports — and has no `npm:` form). Every real npm library is left EXTERNAL as an
// `npm:` specifier so Deno's own npm compatibility loads it. This is deliberate: Bun.build miscompiles
// zod 4 (drops an internal `_regex` binding) and externalizes builtins as bare `"net"`/`"perf_hooks"`
// which Deno rejects — both vanish when zod/hono/drizzle/postgres come from `npm:` instead, since
// `npm:postgres` etc. resolve their own `node:` builtins correctly. The bundle is then just the
// toolkit glue.
// Versions are read from the INSTALLED packages so the runtime `npm:` pin can never drift from the
// workspace source the bundle was compiled against (a stale hand-pin once served rc.2 drizzle under
// rc.4-authored toolkit code — mutations 500'd).
const EXTERNAL_LIBS = [
  "zod",
  "hono",
  "drizzle-orm",
  "postgres",
  // JWKS verification of GoTrue session tokens in board-sync/board-write (apps/board-api, ADR-0007).
  "jose",
] as const;

function installedVersion(lib: string): string {
  const manifest = JSON.parse(readFileSync(join("node_modules", lib, "package.json"), "utf8")) as {
    version?: string;
  };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Cannot read installed version of '${lib}' from node_modules.`);
  }
  return manifest.version;
}

const NPM_EXTERNALS: Record<string, string> = Object.fromEntries(
  EXTERNAL_LIBS.map((lib) => [lib, `npm:${lib}@${installedVersion(lib)}`]),
);

const externalsPlugin: BunPlugin = {
  name: "deno-externals",
  setup(build) {
    const externalNames = [...Object.keys(NPM_EXTERNALS), ...builtinModules];
    build.onResolve({ filter: /.*/ }, (args) => {
      const base = args.path.replace(/^node:/, "").split("/")[0]!;
      // Mark every npm library + node builtin (and their subpaths) external — they must NOT be
      // inlined (Bun.build miscompiles zod 4; Deno loads them correctly from npm:/node:). The exact
      // specifier is rewritten in `rewriteExternals` below, because Bun keeps the original specifier
      // for externals and ignores a path returned here.
      if (externalNames.includes(base)) {
        return { path: args.path, external: true };
      }
      // Everything else (@pgxsinkit/* source, relative _shared imports) is bundled.
      return undefined;
    });
  },
};

const builtinSet = new Set(builtinModules);

/**
 * Rewrites the bundle's bare external specifiers to ones Deno resolves: npm libraries → pinned `npm:`,
 * node builtins → the `node:` scheme. Bun externalizes these but leaves them bare, which the Edge
 * runtime (Deno) rejects. Operates on the `from "…"` / `import("…")` clauses only.
 */
function rewriteExternals(code: string): string {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g, (match, head, quote, spec) => {
    const base = spec.replace(/^node:/, "").split("/")[0];
    if (NPM_EXTERNALS[base]) {
      const remainder = spec.slice(base.length); // keeps any `/subpath`
      return `${head}${quote}${NPM_EXTERNALS[base]}${remainder}${quote}`;
    }
    if (builtinSet.has(base) && !spec.startsWith("node:")) {
      return `${head}${quote}node:${spec}${quote}`;
    }
    return match;
  });
}

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
    plugins: [externalsPlugin],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Failed to bundle Edge function '${name}'.`);
  }

  const outFile = join(outdir, "index.js");
  const rewritten = rewriteExternals(readFileSync(outFile, "utf8"));
  writeFileSync(outFile, rewritten);

  const sizeKib = (Buffer.byteLength(rewritten) / 1024).toFixed(0);
  console.log(`✓ ${name} → ${outFile} (${sizeKib} KiB)`);
}

function copyMainRouter(): void {
  const dst = join(DIST_ROOT, "main");
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(SOURCE_ROOT, "main", "index.ts"), join(dst, "index.ts"));
  console.log(`✓ main → ${dst}/index.ts (raw, vendored official router)`);
}

async function main(): Promise<void> {
  rmSync(DIST_ROOT, { recursive: true, force: true });
  copyMainRouter();
  for (const name of BUNDLED) {
    await buildOne(name);
  }
  console.log(`\nPrepared ${BUNDLED.length + 1} Edge functions in ${DIST_ROOT}/.`);
}

await main();
