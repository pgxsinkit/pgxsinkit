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
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Public packages in dependency order, with the entry points the smoke imports from.
const PUBLIC_PACKAGES = ["contracts", "pglite-sync", "client", "server", "react"] as const;

// Peer dependencies a real consumer installs alongside the packages (pinned to the
// versions the workspace builds against).
const PEER_DEPS: Record<string, string> = {
  "drizzle-orm": "1.0.0-rc.2",
  zod: "^4.4.3",
  "@electric-sql/pglite": "0.5.3",
  "@electric-sql/client": "^1.5.21",
  "@electric-sql/experimental": "^6.0.21",
  hono: "^4.12.26",
  react: "^19.2.7",
};

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
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
  generateLocalSchemaSql,
} from "@pgxsinkit/client";
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
  client: { flush: async () => {}, reconcile: async () => {}, retryFailed: async () => {} },
  trigger: createIntervalConvergenceTrigger(1000),
});
assert.equal(typeof driver.start, "function");

// server + react: the published entry points resolve and expose their factories.
assert.equal(typeof createSyncServer, "function");
assert.equal(typeof createSyncClientHooks, "function");

console.log("FIXTURE SMOKE OK");
`;

async function main(): Promise<void> {
  console.log("[fixture-smoke] building public packages…");
  run("bun", ["run", "build:public-packages"], repoRoot);

  const workspace = await mkdtemp(join(tmpdir(), "pgxsinkit-fixture-"));
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
    const pkgDeps: Record<string, string> = { ...PEER_DEPS };
    const overrides: Record<string, string> = {};
    for (const [name, tarball] of Object.entries(tarballs)) {
      pkgDeps[name] = `file:${tarball}`;
      overrides[name] = `file:${tarball}`;
    }

    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify(
        { name: "pgxsinkit-fixture-app", private: true, type: "module", dependencies: pkgDeps, overrides },
        null,
        2,
      ),
    );
    await writeFile(join(appDir, "smoke.ts"), SMOKE_SOURCE);

    console.log("[fixture-smoke] installing the packed packages into the fixture…");
    run("bun", ["install", "--no-save"], appDir);

    console.log("[fixture-smoke] running the smoke against the published surface…");
    run("bun", ["smoke.ts"], appDir);

    console.log("[fixture-smoke] OK — the published install path works.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
