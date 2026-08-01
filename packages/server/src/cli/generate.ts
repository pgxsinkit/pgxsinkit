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
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { eventLaneDdlFingerprint, eventLaneStreamNames, renderEventLaneMigration } from "../events/ddl";
import { renderPgxsinkitUtilitiesMigration } from "../migrations/utilities";
import {
  buildPlpgsqlBatchFunctionDdl,
  expectedApplyFingerprint,
  type ApplyFunctionRenderOptions,
} from "../mutations/plpgsql-apply";

/** Exported for direct unit coverage of the flag surface (repeatable/comma-separated `--grant-execute-to`). */
export function parseArgs(argv: string[]) {
  let check = false;
  let utilities = false;
  let events = false;
  let functionSchema: string | undefined;
  // ADR-0054: repeatable AND comma-separated, so `--grant-execute-to a --grant-execute-to b` and
  // `--grant-execute-to a,b` are the same list. Empty (the default) is owner-only.
  const grantExecuteTo: string[] = [];
  let registryPath = "";
  let projectDir = process.cwd();
  let migrationName: string | undefined;
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
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--utilities") {
      utilities = true;
    } else if (arg === "--events") {
      events = true;
    } else if (arg === "--function-schema" && argv[i + 1]) {
      functionSchema = argv[++i]!;
    } else if (arg === "--grant-execute-to" && argv[i + 1]) {
      for (const role of argv[++i]!.split(",")) {
        grantExecuteTo.push(role.trim());
      }
    }
  }

  // Utilities mode installs the registry-independent pgxsinkit_clock_us() function, so it needs no
  // --registry; the apply-artifact and event-lane modes do (both are derived from the registry).
  if (!registryPath && !utilities) {
    console.error(
      "Usage:\n" +
        "  pgxsinkit-generate [--check] --registry <path> [--export registry] [--project-dir .] [--name sync_artifact] [--config drizzle.config.ts] [--out drizzle] [--function-schema schema] [--grant-execute-to <role>]...\n" +
        "\n" +
        "  --grant-execute-to <role>   Role granted EXECUTE on the apply function (repeatable, or comma-separated).\n" +
        "                              Default: NOBODY but the function owner (ADR-0054). Name the role your\n" +
        "                              SERVER connects as — never a client-facing role (anon/authenticated):\n" +
        "                              the function trusts the claims it is handed, so this list is the write\n" +
        "                              path's entire trust boundary. It is part of the artifact fingerprint, so\n" +
        "                              pass the SAME roles to --check and to createSyncServer.\n" +
        "  pgxsinkit-generate --utilities [--check] --name <folder> [--project-dir .] [--config drizzle.config.ts] [--out drizzle]\n" +
        "  pgxsinkit-generate --events [--check] --registry <path> [--export registry] [--project-dir .] [--name event_lane_artifact] [--config drizzle.config.ts] [--out drizzle]",
    );
    process.exit(1);
  }

  return {
    check,
    utilities,
    events,
    functionSchema,
    grantExecuteTo,
    registryPath,
    projectDir,
    migrationName: migrationName ?? (events ? "event_lane_artifact" : "sync_artifact"),
    drizzleConfig,
    outDir,
    exportName,
  };
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

/** The renderer options both `--check` and the generate path derive from the same parsed flags. */
function buildRenderOptions(options: {
  functionSchema: string | undefined;
  grantExecuteTo: readonly string[];
}): ApplyFunctionRenderOptions {
  return {
    ...(options.functionSchema ? { functionSchema: options.functionSchema } : {}),
    ...(options.grantExecuteTo.length > 0 ? { grantExecuteTo: options.grantExecuteTo } : {}),
  };
}

/**
 * `--check` (ADR-0018): the read-only, pre-deploy half of apply-function drift detection. Computes the
 * fingerprint the apply function SHOULD carry for this registry + applier codegen and asserts that a
 * committed migration already embeds it. No drizzle-kit, no writes — safe to run in CI. The server
 * enforces the same fingerprint at startup; this surfaces the drift before a deploy. Generic by design:
 * a consumer points it at their own registry, drizzle config, and (optionally) function schema.
 */
async function runCheck(
  registry: SyncTableRegistry,
  options: {
    projectDir: string;
    drizzleConfig: string | undefined;
    outDir: string | undefined;
    functionSchema: string | undefined;
    grantExecuteTo: readonly string[];
    label: string;
  },
): Promise<void> {
  // ADR-0054: `grantExecuteTo` is part of the fingerprinted body, so `--check` must be handed the SAME
  // roles the artifact was generated with — otherwise it reports drift on a perfectly current artifact.
  const fingerprint = expectedApplyFingerprint(registry, buildRenderOptions(options));

  const drizzleDir = await resolveDrizzleOutDir(options.projectDir, options.drizzleConfig, options.outDir);
  if (!drizzleDir) {
    console.error(
      `[pgxsinkit-generate --check] Could not resolve a drizzle migrations directory in ${options.projectDir}.`,
    );
    process.exit(1);
  }

  if (findMigrationCarrying(drizzleDir, fingerprint)) {
    console.log(`[pgxsinkit-generate --check] ✓ ${options.label}: a committed migration carries ${fingerprint}`);
    return;
  }

  console.error(
    `[pgxsinkit-generate --check] ✗ ${options.label}: no committed migration in ${drizzleDir} carries the ` +
      `current apply-function fingerprint (${fingerprint}).\n` +
      `  The registry or @pgxsinkit/server codegen changed since the sync function migration was generated.\n` +
      `  Regenerate it (drop --check) and commit + apply the new migration before deploying.`,
  );
  process.exit(1);
}

/**
 * The one committed-migration scan every `--check` mode shares: the folder whose `migration.sql` carries
 * `marker`, or `null`. Unreadable folders are skipped — a `--check` reports drift, never filesystem noise.
 * Exported for direct unit coverage.
 */
export function findMigrationCarrying(drizzleDir: string, marker: string): string | null {
  for (const entry of readdirSync(drizzleDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      if (readFileSync(join(drizzleDir, entry.name, "migration.sql"), "utf-8").includes(marker)) {
        return entry.name;
      }
    } catch {}
  }
  return null;
}

/** The drizzle-kit "no previous migration" root id (an all-zero UUID), used by a chain's first folder. */
const ZERO_MIGRATION_ID = "00000000-0000-0000-0000-000000000000";

/** A committed migration carries the utilities function when its DDL declares this signature. */
const UTILITIES_SIGNATURE = "CREATE OR REPLACE FUNCTION public.pgxsinkit_clock_us()";

/**
 * Writes the utilities migration as a NON-KIT folder (a hand-authored pre-baseline, mirroring the
 * board-prereqs pattern): an empty-`ddl` snapshot rooted at the zero id, so it sorts and applies
 * FIRST. Unlike the artifact path this does NOT invoke `drizzle-kit generate` — that stamps the
 * current time and would sort the folder LAST, after the schema and artifact it must precede — so the
 * caller supplies the full, early-sorting folder name via `--name` (e.g. 20260101000000_pgxsinkit_utilities).
 */
function writeUtilitiesMigration(drizzleDir: string, folderName: string): string {
  const dir = join(drizzleDir, folderName);
  mkdirSync(dir, { recursive: true });

  const header =
    "-- Generated by pgxsinkit-generate --utilities\n" +
    "-- Installs the canonical pgxsinkit_clock_us() microsecond clock. MUST be the first folder in the chain.\n\n";
  const migrationFile = join(dir, "migration.sql");
  writeFileSync(migrationFile, header + renderPgxsinkitUtilitiesMigration() + "\n");

  // The snapshot mirrors a hand-authored pre-baseline (see board-drizzle/*_board_prereqs): the function
  // is not part of drizzle-kit's tracked DDL model, so the snapshot's `ddl` is empty and it roots the
  // chain at the zero id. `version`/`dialect` match the kit's postgres snapshot format.
  //
  // RE-EMIT KEEPS THE EXISTING IDENTITY. The next folder in the chain records this snapshot's `id` in
  // its own `prevIds`, so minting a fresh UUID on every run would BREAK the chain of any consumer who
  // re-emits this folder in place (which ADR-0054 asks them to do, to pick up the clock function's
  // hardened ACL). Only the SQL is re-rendered; the snapshot is left byte-identical where one exists.
  const snapshotFile = join(dir, "snapshot.json");
  if (!existsSync(snapshotFile)) {
    const snapshot = {
      id: randomUUID(),
      prevIds: [ZERO_MIGRATION_ID],
      version: "8",
      dialect: "postgres",
      ddl: [] as unknown[],
      renames: [] as unknown[],
    };
    writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  return migrationFile;
}

/**
 * The utilities counterpart of `--check`: assert a committed migration in the resolved drizzle dir
 * installs the (static, registry-independent) pgxsinkit_clock_us() function. Read-only, no writes.
 */
function checkUtilities(drizzleDir: string, label: string): void {
  if (findMigrationCarrying(drizzleDir, UTILITIES_SIGNATURE)) {
    console.log(
      `[pgxsinkit-generate --utilities --check] ✓ ${label}: a committed migration installs pgxsinkit_clock_us()`,
    );
    return;
  }

  console.error(
    `[pgxsinkit-generate --utilities --check] ✗ ${label}: no committed migration in ${drizzleDir} installs ` +
      `public.pgxsinkit_clock_us().\n` +
      `  The apply function and column DEFAULTs call it — generate the utilities migration (--utilities, drop --check) ` +
      `as the first folder in the chain and commit it.`,
  );
  process.exit(1);
}

async function runUtilities(options: {
  check: boolean;
  projectDir: string;
  drizzleConfig: string | undefined;
  outDir: string | undefined;
  migrationName: string;
}): Promise<void> {
  const drizzleDir = await resolveDrizzleOutDir(options.projectDir, options.drizzleConfig, options.outDir);
  if (!drizzleDir) {
    console.error(
      `[pgxsinkit-generate --utilities] Could not resolve a drizzle migrations directory in ${options.projectDir}.`,
    );
    process.exit(1);
  }

  if (options.check) {
    checkUtilities(drizzleDir, options.migrationName);
    return;
  }

  const migrationFile = writeUtilitiesMigration(drizzleDir, options.migrationName);
  console.log(`Wrote pgxsinkit_clock_us() utilities migration to ${migrationFile}`);
}

/**
 * `--events` (ADR-0053 decision 5): the Event lane's deploy-time artifact — the pgmq extension plus one queue
 * per registered Event stream, derived from the registry. It rides the same generate/`--check` flow as the
 * apply-function artifact, in its OWN migration folder: the queues are provisioned independently of the apply
 * function (Event streams touch no synced table), and a registry with no streams provisions nothing at all.
 *
 * `--check` is the read-only pre-deploy half: it asserts a committed migration carries the fingerprint the
 * current registry's streams imply, so adding or removing an Event stream without regenerating fails in CI
 * rather than at the first enqueue against a queue that does not exist.
 */
async function runEvents(
  registry: SyncTableRegistry,
  options: {
    check: boolean;
    projectDir: string;
    drizzleConfig: string | undefined;
    outDir: string | undefined;
    migrationName: string;
    label: string;
  },
): Promise<void> {
  const streamNames = eventLaneStreamNames(registry);

  if (streamNames.length === 0) {
    if (options.check) {
      // Nothing to provision is not drift: a registry without Event streams simply has no event lane.
      console.log(`[pgxsinkit-generate --events --check] ✓ ${options.label}: no Event streams registered`);
      return;
    }
    console.error(
      `[pgxsinkit-generate --events] ✗ ${options.label}: this registry registers no Event streams, so there is ` +
        `no event-lane DDL to emit.\n` +
        `  Register one with defineSyncRegistry({ tables, streams: { <name>: defineEventStream({ … }) } }).`,
    );
    process.exit(1);
  }

  const drizzleDir = await resolveDrizzleOutDir(options.projectDir, options.drizzleConfig, options.outDir);
  if (!drizzleDir) {
    console.error(
      `[pgxsinkit-generate --events] Could not resolve a drizzle migrations directory in ${options.projectDir}.`,
    );
    process.exit(1);
  }

  const fingerprint = eventLaneDdlFingerprint(registry);

  if (options.check) {
    if (findMigrationCarrying(drizzleDir, fingerprint)) {
      console.log(
        `[pgxsinkit-generate --events --check] ✓ ${options.label}: a committed migration carries ${fingerprint}`,
      );
      return;
    }
    console.error(
      `[pgxsinkit-generate --events --check] ✗ ${options.label}: no committed migration in ${drizzleDir} carries ` +
        `the current event-lane fingerprint (${fingerprint}).\n` +
        `  The registry's Event streams changed since the event-lane migration was generated ` +
        `(now: ${streamNames.join(", ")}).\n` +
        `  Regenerate it (drop --check) and commit + apply the new migration before deploying — the ingestion ` +
        `endpoint enqueues onto queues the migration provisions.`,
    );
    process.exit(1);
  }

  console.log(`Generating event-lane DDL for ${streamNames.length} Event stream(s): ${streamNames.join(", ")}...`);
  runDrizzleGenerate(options.projectDir, options.migrationName, options.drizzleConfig);

  const migrationFile = findNewMigrationFile(drizzleDir);
  if (!migrationFile) {
    console.error("Could not find the newly created migration file.");
    process.exit(1);
  }

  const header = "-- Generated by pgxsinkit-generate --events\n-- Re-run after adding or removing an Event stream.\n\n";
  writeFileSync(migrationFile, `${header}${renderEventLaneMigration(registry)}\n`);
  console.log(`Wrote event-lane queues to ${migrationFile}`);
}

async function main() {
  const {
    check,
    utilities,
    events,
    functionSchema,
    grantExecuteTo,
    registryPath,
    projectDir,
    migrationName,
    drizzleConfig,
    outDir,
    exportName,
  } = parseArgs(process.argv.slice(2));

  if (utilities) {
    await runUtilities({ check, projectDir, drizzleConfig, outDir, migrationName });
    return;
  }

  console.log(`Importing registry from ${registryPath}...`);
  const registry = await importRegistry(registryPath, exportName);

  if (events) {
    await runEvents(registry, {
      check,
      projectDir,
      drizzleConfig,
      outDir,
      migrationName,
      label: exportName ?? "(conventional registry)",
    });
    return;
  }

  if (check) {
    await runCheck(registry, {
      projectDir,
      drizzleConfig,
      outDir,
      functionSchema,
      grantExecuteTo,
      label: exportName ?? "(conventional registry)",
    });
    return;
  }

  console.log(`Generating DDL for ${Object.keys(registry).length} table(s)...`);
  // Both render inputs must reach the renderer here, exactly as `--check` computes them: a
  // `--function-schema` that only reached `--check` silently generated an unqualified artifact whose
  // fingerprint could never match (and `--grant-execute-to` would have the same failure mode).
  const ddl = buildPlpgsqlBatchFunctionDdl(registry, buildRenderOptions({ functionSchema, grantExecuteTo }));

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
