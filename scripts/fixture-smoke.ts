#!/usr/bin/env bun
/**
 * Packed-downstream fixture smoke test (ADR-0008).
 *
 * Builds the public `@pgxsinkit/*` packages, packs them exactly as they would publish
 * (`bun pm pack`), installs the tarballs into a throwaway consumer workspace, and runs a
 * smoke that imports from every published entry point and exercises the offline-capable
 * surface. This proves the *published* contract — the `exports` map, `types`, `main`, and the
 * cross-package dependency graph — rather than the in-repo source the unit tests import.
 * The DB/Electric round-trip stays in the integration lane.
 *
 * Run: `bun run fixture:smoke`. Exits non-zero on any drift (a missing export, a broken
 * exports map, an unresolvable dependency).
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Public packages in dependency order, with the entry points the smoke imports from.
const PUBLIC_PACKAGES = ["contracts", "pglite-opfs-repacked", "client", "server", "react"] as const;

/**
 * The peer dependencies a real consumer installs alongside the packages, derived from the published
 * manifests themselves (the packages' regular `dependencies` arrive with the tarballs and must NOT
 * be listed here — resolving them is part of what this smoke proves). Derivation replaces a manual
 * version table that had already drifted from the workspace once (drizzle-orm rc.2 vs rc.4). When
 * two compatible ranges differ, the workspace's exact development version is used only if it
 * satisfies both; otherwise the range conflict is a packaging bug and fails the smoke.
 */
async function peerDepsFromManifests(): Promise<Record<string, string>> {
  const peers: Record<string, string> = {};
  const rootManifest = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  for (const name of PUBLIC_PACKAGES) {
    const manifestPath = resolve(repoRoot, "packages", name, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const existing = peers[dep];
      if (existing !== undefined && existing !== range) {
        const workspaceVersion = rootManifest.devDependencies?.[dep];
        if (
          workspaceVersion !== undefined &&
          Bun.semver.satisfies(workspaceVersion, existing) &&
          Bun.semver.satisfies(workspaceVersion, range)
        ) {
          peers[dep] = workspaceVersion;
          continue;
        }
        throw new Error(`Conflicting peer ranges for ${dep}: "${existing}" vs "${range}" (from @pgxsinkit/${name})`);
      }
      peers[dep] = range;
    }
  }
  return peers;
}

/**
 * Tooling the downstream consumer itself needs (kept off the peer table — none of this is a peer of
 * the published packages): the Vite production build, the react renderer for the render smoke, and
 * the TypeScript toolchain for the consumer typecheck. react-dom reuses react's peer range so the
 * renderer can never drift from the react the peer range resolves.
 */
function consumerDevDeps(peerDeps: Record<string, string>): Record<string, string> {
  return {
    vite: "8.1.4",
    "react-dom": peerDeps["react"] ?? ">=19.2.7",
    typescript: "^7.0.2",
    "@types/node": "26.1.1",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
  };
}

function run(command: string, args: string[], cwd: string, env?: Record<string, string>): void {
  execFileSync(command, args, { cwd, stdio: "inherit", ...(env ? { env: { ...process.env, ...env } } : {}) });
}

async function packPackage(packageName: string, destination: string): Promise<string> {
  const packageDir = resolve(repoRoot, "packages", packageName);
  run("bun", ["pm", "pack", "--destination", destination], packageDir);

  const entries = await readdir(destination);
  const tarball = entries.find((name) => name.includes(packageName) && name.endsWith(".tgz"));

  if (!tarball) {
    throw new Error(`bun pm pack produced no tarball for @pgxsinkit/${packageName} in ${destination}`);
  }

  return join(destination, tarball);
}

const SMOKE_SOURCE = `
import { strict as assert } from "node:assert";

import {
  buildRegistryLock,
  defineSyncRegistry,
  defineSyncTable,
  fingerprintRegistry,
  runRegistryCheck,
} from "@pgxsinkit/contracts";
import {
  createConvergenceDriver,
  createIntervalConvergenceTrigger,
  createSyncClient,
  generateLocalSchemaSql,
} from "@pgxsinkit/client";
import { memoryStoreForTests } from "@pgxsinkit/client/testing";
import { createOpfsRepackedPGlite, StoreRecreationRequiredError } from "@pgxsinkit/pglite-opfs-repacked";
import { createSyncServer } from "@pgxsinkit/server";
import { createSyncClientHooks } from "@pgxsinkit/react";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

// A consumer-defined registry, built through the published contracts entry point.
const registry = defineSyncRegistry({
  widgets: defineSyncTable({
    tableName: "widgets",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

// client: the local schema generator runs over the registry and emits DDL.
const ddl = generateLocalSchemaSql(registry);
assert.match(ddl, /CREATE TABLE IF NOT EXISTS widgets/);
assert.match(ddl, /pgxsinkit_local_meta/);

// contracts: fingerprint + the authoring-time registry-diff gate round-trip.
const fingerprint = fingerprintRegistry(registry);
assert.ok(fingerprint.length > 0);
const lock = buildRegistryLock(registry);
assert.equal(runRegistryCheck({ registry, lock }).ok, true);

// client: the convergence driver + trigger factories are exported and constructable.
const driver = createConvergenceDriver({
  client: { flush: async () => {}, reconcile: async () => {} },
  trigger: createIntervalConvergenceTrigger(1000),
});
assert.equal(typeof driver.start, "function");

// server + react: the published entry points resolve and expose their factories.
assert.equal(typeof createSyncServer, "function");
assert.equal(typeof createSyncClientHooks, "function");
assert.equal(typeof createOpfsRepackedPGlite, "function");
assert.equal(new StoreRecreationRequiredError("recreate").storeCode, "STORE_RECREATION_REQUIRED");
// The source file is deliberately present in the tarball, as it is for every public package. The
// export map must still make it unreachable as a consumer subpath.
const repackedInternalSubpath = ["@pgxsinkit/pglite-opfs-repacked", "src", "opfs-port.ts"].join("/");
await assert.rejects(
  import(repackedInternalSubpath),
  (error: unknown) => {
    const message =
      typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
    return /not exported|could not resolve|cannot find module/i.test(message);
  },
  "package-internal OPFS modules must remain blocked by the export map",
);

// client: stand up a REAL offline client (in-memory PGlite, sync disabled) and prove a local
// write/read round-trip through the published surface — not just that the factory exists. The
// DB+Electric round-trip against live infra lives in the integration lane (and createSyncServer
// touches its db at construction, so it is exercised there, not here).
const client = await createSyncClient({
  registry,
  electricUrl: "http://localhost:3000/v1/shape",
  batchWriteUrl: "http://localhost:3001/api/mutations",
  ...memoryStoreForTests("fixture-smoke"),
  syncEnabled: false,
});
await client.ready;
// updatedAtUs is governance-managed (applyOn create+update), so the typed create payload
// correctly omits it — the engine stamps it.
await client.tables.widgets.create({
  id: "01963227-0000-7000-8000-000000000001",
  label: "Smoke",
  createdAtUs: 1n,
});
const queued = await client.diagnostics();
assert.equal(queued.mutation.pendingCount, 1);
const rows = await client.drizzle.select().from(client.views.widgets);
assert.equal(rows.length, 1);
assert.equal(rows[0].label, "Smoke");
await client.stop();

console.log("FIXTURE SMOKE OK");
`;

/**
 * The downstream Vite PRODUCTION consumer (ADR-0037). A production Vite build rewrites
 * `react/jsx-dev-runtime` to `jsxDEV = undefined` while bundling, so a published bundle compiled
 * against the development JSX runtime type-checks, imports, and passes every `typeof` probe — and
 * then throws `TypeError: jsxDEV is not a function` the first time a component actually renders.
 * Only building the packed install through a real production Vite pipeline and RENDERING
 * `SyncClientProvider` exercises that seam, so this consumer does exactly that (via
 * `renderToString`, which needs no DOM). `createElement` keeps the consumer's own code free of JSX:
 * the only JSX-runtime call in the output is the library's.
 */
const VITE_CONSUMER_ENTRY = `
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { createSyncClientHooks } from "@pgxsinkit/react";

const { SyncClientProvider } = createSyncClientHooks();
// children goes in the props object: the provider's props type requires it, and React's
// createElement typings do not credit third-argument children against a required children prop.
const html = renderToString(createElement(SyncClientProvider, { client: null, children: "vite-consumer-marker" }));
if (!html.includes("vite-consumer-marker")) {
  throw new Error(\`SyncClientProvider did not render its children: \${html}\`);
}
console.log("VITE CONSUMER OK");
// The browser-oriented bundle inlines @pgxsinkit/client's whole module graph, which keeps Bun's
// event loop alive after the render — in a browser nothing waits on loop drain, but this smoke
// does. Exit explicitly: reaching this line IS the pass condition.
process.exit(0);
`;

const VITE_CONSUMER_CONFIG = `
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist-consumer",
    minify: true,
    rolldownOptions: {
      input: "consumer-entry.ts",
      output: { entryFileNames: "consumer.js" },
    },
  },
});
`;

/**
 * The consumer typecheck program: proves the PUBLISHED type surface — the packed d.ts graph as a
 * downstream project's use sites consume it — which the runtime smokes cannot see (Bun strips
 * types). `skipLibCheck: true` mirrors a real consumer AND is load-bearing: drizzle-orm's own
 * declarations do not pass a strict TS7 lib-check, so `false` drowns real signal in third-party
 * noise. Use-site errors against @pgxsinkit types still surface fully. vite.config.ts stays out of
 * the program — it is consumer tooling, not the published surface.
 */
const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2024",
      lib: ["ES2024", "DOM"],
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["smoke.ts", "consumer-entry.ts"],
  },
  null,
  2,
);

/**
 * Proves the `pgxsinkit-generate` bin actually resolves from a packed install: the `bin/` launcher
 * shipped, and its relative path to the TypeScript CLI is correct from `node_modules`. Running it with
 * no args makes the CLI print its usage and exit 1 — which only happens if the whole launcher → Bun →
 * CLI (with its `@pgxsinkit/contracts` import) chain loaded.
 */
function assertGenerateBinResolves(appDir: string): void {
  const binPath = join(appDir, "node_modules", ".bin", "pgxsinkit-generate");
  let output = "";
  let exitCode = 0;
  try {
    execFileSync(binPath, [], { cwd: appDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    exitCode = failure.status ?? 1;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  if (exitCode !== 1 || !output.includes("Usage:")) {
    throw new Error(`pgxsinkit-generate bin did not resolve from the packed install (exit ${exitCode}): ${output}`);
  }
}

async function main(): Promise<void> {
  console.log("[fixture-smoke] building public packages…");
  run("bun", ["run", "build:public-packages"], repoRoot);

  // Repo-local tmp only — AGENTS.md forbids the global /tmp. (gitignored under tmp/*.)
  const tmpRoot = join(repoRoot, "tmp");
  await mkdir(tmpRoot, { recursive: true });
  const workspace = await mkdtemp(join(tmpRoot, "fixture-smoke-"));
  const pkgsDir = join(workspace, "pkgs");
  const appDir = join(workspace, "app");
  await rm(pkgsDir, { recursive: true, force: true });
  run("mkdir", ["-p", pkgsDir, appDir], workspace);

  try {
    console.log("[fixture-smoke] packing tarballs…");
    const tarballs: Record<string, string> = {};
    for (const name of PUBLIC_PACKAGES) {
      tarballs[`@pgxsinkit/${name}`] = await packPackage(name, pkgsDir);
    }

    // `file:` deps + `overrides` so every @pgxsinkit/* reference (including the tarballs'
    // own sibling deps) resolves to the local tarball, not a registry lookup.
    const peerDeps = await peerDepsFromManifests();
    const pkgDeps: Record<string, string> = { ...peerDeps };
    const overrides: Record<string, string> = {};
    for (const [name, tarball] of Object.entries(tarballs)) {
      pkgDeps[name] = `file:${tarball}`;
      overrides[name] = `file:${tarball}`;
    }

    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify(
        {
          name: "pgxsinkit-fixture-app",
          private: true,
          type: "module",
          dependencies: pkgDeps,
          devDependencies: consumerDevDeps(peerDeps),
          overrides,
        },
        null,
        2,
      ),
    );
    await writeFile(join(appDir, "smoke.ts"), SMOKE_SOURCE);
    await writeFile(join(appDir, "consumer-entry.ts"), VITE_CONSUMER_ENTRY);
    await writeFile(join(appDir, "vite.config.ts"), VITE_CONSUMER_CONFIG);
    await writeFile(join(appDir, "tsconfig.json"), CONSUMER_TSCONFIG);

    console.log("[fixture-smoke] installing the packed packages into the fixture…");
    run("bun", ["install", "--no-save"], appDir);

    console.log("[fixture-smoke] typechecking the consumer against the published declarations…");
    run(join(appDir, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "tsconfig.json"], appDir);

    console.log("[fixture-smoke] running the smoke against the published surface…");
    run("bun", ["smoke.ts"], appDir);

    console.log("[fixture-smoke] building the downstream Vite production consumer…");
    // NODE_ENV pinned: the consumer must be a PRODUCTION build — that is the pipeline that turns a
    // dev-runtime-compiled bundle into a render-time crash (ADR-0037).
    run(join(appDir, "node_modules", ".bin", "vite"), ["build"], appDir, { NODE_ENV: "production" });

    console.log("[fixture-smoke] rendering SyncClientProvider from the production consumer bundle…");
    run("bun", [join("dist-consumer", "consumer.js")], appDir);

    console.log("[fixture-smoke] checking the pgxsinkit-generate bin resolves from the install…");
    assertGenerateBinResolves(appDir);

    console.log("[fixture-smoke] OK — the published install path works.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
