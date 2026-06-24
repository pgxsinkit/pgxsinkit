#!/usr/bin/env bun
/**
 * pgxsinkit-generate — Generates a drizzle-kit migration with the
 * pgxsinkit_apply_mutations PL/pgSQL function.
 *
 * External consumers (e.g. transcrobes) invoke this from their own project:
 *
 *   bun run pgxsinkit-generate \
 *     --registry packages/lib/src/sync-registry/index.ts \
 *     --project-dir packages/db \
 *     --name sync_artifact
 *
 * This runs `drizzle-kit generate --custom --name <name>` in --project-dir,
 * then fills the new migration.sql with the generated DDL.
 * The result is a standard drizzle-kit migration tracked via snapshot.json.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { buildPlpgsqlBatchFunctionDdl } from "../mutations/plpgsql-apply";

function parseArgs(argv: string[]) {
  let registryPath = "";
  let projectDir = process.cwd();
  let migrationName = "sync_artifact";
  let drizzleConfig = "";
  let outDir: string | undefined;
  let exportName: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--registry" && argv[i + 1]) {
      registryPath = argv[++i]!;
    } else if (arg === "--project-dir" && argv[i + 1]) {
      projectDir = argv[++i]!;
    } else if (arg === "--name" && argv[i + 1]) {
      migrationName = argv[++i]!;
    } else if (arg === "--config" && argv[i + 1]) {
      drizzleConfig = argv[++i]!;
    } else if (arg === "--out" && argv[i + 1]) {
      outDir = argv[++i]!;
    } else if (arg === "--export" && argv[i + 1]) {
      exportName = argv[++i]!;
    }
  }

  if (!registryPath) {
    console.error(
      "Usage: pgxsinkit-generate --registry <path> [--export registry] [--project-dir .] [--name sync_artifact] [--config drizzle.config.ts] [--out drizzle]",
    );
    process.exit(1);
  }

  return { registryPath, projectDir, migrationName, drizzleConfig, outDir, exportName };
}

/** Registry source paths are relative to the invocation directory, not the migration output directory. */
export function resolveRegistryModulePath(registryPath: string, cwd = process.cwd()): string {
  return isAbsolute(registryPath) ? registryPath : resolve(cwd, registryPath);
}

function isSyncTableRegistry(value: unknown): value is SyncTableRegistry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Select a registry from an imported module, with `--export` available for arbitrary names. */
export function selectRegistryExport(moduleExports: Record<string, unknown>, exportName?: string): SyncTableRegistry {
  const availableExports = Object.keys(moduleExports).sort();

  if (exportName) {
    const selected = moduleExports[exportName];
    if (isSyncTableRegistry(selected)) {
      return selected;
    }

    throw new Error(
      `Registry export '${exportName}' was not found or is not an object. Available exports: ${availableExports.join(", ") || "(none)"}`,
    );
  }

  for (const conventionalName of ["registry", "default", "transcrobesSyncRegistry", "demoSyncRegistry"]) {
    const selected = moduleExports[conventionalName];
    if (isSyncTableRegistry(selected)) {
      return selected;
    }
  }

  throw new Error(
    `Could not find a registry export. Export it as 'registry' or default, or pass --export <name>. Available exports: ${availableExports.join(", ") || "(none)"}`,
  );
}

async function importRegistry(registryPath: string, exportName?: string): Promise<SyncTableRegistry> {
  const resolved = resolveRegistryModulePath(registryPath);
  const moduleExports = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  return selectRegistryExport(moduleExports, exportName);
}

function runDrizzleGenerate(projectDir: string, name: string, drizzleConfig?: string): void {
  const cwd = join(process.cwd(), projectDir);
  const args = ["run", "drizzle-kit", "generate", "--custom", "--name", name];
  if (drizzleConfig) args.push("--config", drizzleConfig);
  const result = spawnSync("bun", args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
  });

  if (result.status !== 0) {
    throw new Error(`drizzle-kit generate failed with exit code ${result.status ?? 1}`);
  }
}

async function readOutFromConfig(configPath: string): Promise<string | undefined> {
  try {
    const mod = (await import(pathToFileURL(configPath).href)) as { default?: { out?: unknown } };
    const out = mod.default?.out;
    return typeof out === "string" ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves where drizzle-kit writes migrations for this project, in precedence order:
 *   1. an explicit `--out` (relative to `--project-dir`),
 *   2. the `out` field of the `--config` drizzle config — so a consumer whose migrations
 *      live somewhere non-default (e.g. `infra/board-drizzle`) never has to repeat the path,
 *   3. a probe of the conventional `drizzle` / `infra/drizzle` locations.
 */
export async function resolveDrizzleOutDir(
  projectDir: string,
  drizzleConfig?: string,
  outFlag?: string,
): Promise<string | null> {
  const cwd = join(process.cwd(), projectDir);

  if (outFlag) {
    return isAbsolute(outFlag) ? outFlag : join(cwd, outFlag);
  }

  if (drizzleConfig) {
    const configPath = isAbsolute(drizzleConfig) ? drizzleConfig : join(cwd, drizzleConfig);
    const out = await readOutFromConfig(configPath);
    if (out) {
      return isAbsolute(out) ? out : join(cwd, out);
    }
  }

  for (const name of ["drizzle", "infra/drizzle"]) {
    const full = join(cwd, name);
    try {
      if (readdirSync(full).length > 0) return full;
    } catch {}
  }

  return null;
}

function findNewMigrationFile(drizzleDir: string): string | null {
  const dirs = readdirSync(drizzleDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  for (const dir of dirs) {
    const sqlFile = join(drizzleDir, dir, "migration.sql");
    try {
      const content = readFileSync(sqlFile, "utf-8");
      if (content.length < 100 && content.includes("Custom SQL")) {
        return sqlFile;
      }
    } catch {}
  }

  return null;
}

async function main() {
  const { registryPath, projectDir, migrationName, drizzleConfig, outDir, exportName } = parseArgs(
    process.argv.slice(2),
  );

  console.log(`Importing registry from ${registryPath}...`);
  const registry = await importRegistry(registryPath, exportName);

  console.log(`Generating DDL for ${Object.keys(registry).length} table(s)...`);
  const ddl = buildPlpgsqlBatchFunctionDdl(registry);

  console.log(`Creating empty migration via drizzle-kit generate --custom --name ${migrationName}...`);
  runDrizzleGenerate(projectDir, migrationName, drizzleConfig);

  const drizzleDir = await resolveDrizzleOutDir(projectDir, drizzleConfig, outDir);
  if (!drizzleDir) {
    console.error("Could not find drizzle output directory in", projectDir);
    process.exit(1);
  }

  const migrationFile = findNewMigrationFile(drizzleDir);
  if (!migrationFile) {
    console.error("Could not find the newly created migration file.");
    process.exit(1);
  }

  const header = "-- Generated by pgxsinkit-generate\n-- Re-run after any registry change.\n\n";
  writeFileSync(migrationFile, header + ddl + "\n");
  console.log(`Wrote sync function to ${drizzleDir}/.../migration.sql`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
