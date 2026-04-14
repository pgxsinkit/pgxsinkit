import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getTableName } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import { tableGovernanceSpecSchema, type SyncTableRegistry } from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/demo";

const DEFAULT_MIGRATIONS_DIR = "drizzle";
const DEFAULT_MIGRATION_NAME = "registry_governance";
const REGISTRY_SOURCE = "packages/demo/src/registry.ts";

type GovernanceStatement = {
  sql: string;
  source: string;
};

function buildSupabaseAuthHelperStatements(): GovernanceStatement[] {
  return [
    {
      source: "governance.auth.schema",
      sql: "CREATE SCHEMA IF NOT EXISTS auth;",
    },
    {
      source: "governance.auth.role_authenticated",
      sql: [
        "DO $$",
        "BEGIN",
        "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        "    BEGIN",
        "      CREATE ROLE authenticated NOLOGIN;",
        "    EXCEPTION",
        "      WHEN insufficient_privilege THEN",
        "        NULL;",
        "    END;",
        "  END IF;",
        "END;",
        "$$;",
      ].join("\n"),
    },
    {
      source: "governance.auth.set_auth_context",
      sql: [
        "CREATE OR REPLACE FUNCTION auth.set_auth_context(claims jsonb)",
        "RETURNS void",
        "LANGUAGE plpgsql",
        "AS $$",
        "DECLARE",
        "  normalized_claims jsonb := COALESCE(claims, '{}'::jsonb);",
        "  target_role text := COALESCE(NULLIF(normalized_claims ->> 'role', ''), 'authenticated');",
        "BEGIN",
        "  BEGIN",
        "    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN",
        "      PERFORM set_config('role', target_role, true);",
        "    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        "      PERFORM set_config('role', 'authenticated', true);",
        "    END IF;",
        "  EXCEPTION",
        "    WHEN insufficient_privilege THEN",
        "      NULL;",
        "  END;",
        "  PERFORM set_config('request.jwt.claims', normalized_claims::text, true);",
        "",
        "  IF normalized_claims ? 'sub' THEN",
        "    PERFORM set_config('request.jwt.claim.sub', normalized_claims ->> 'sub', true);",
        "  END IF;",
        "END;",
        "$$;",
      ].join("\n"),
    },
    {
      source: "governance.auth.uid",
      sql: [
        "CREATE OR REPLACE FUNCTION auth.uid()",
        "RETURNS uuid",
        "LANGUAGE sql",
        "STABLE",
        "AS $$",
        "  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid",
        "$$;",
      ].join("\n"),
    },
    {
      source: "governance.auth.jwt",
      sql: [
        "CREATE OR REPLACE FUNCTION auth.jwt()",
        "RETURNS jsonb",
        "LANGUAGE sql",
        "STABLE",
        "AS $$",
        "  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb",
        "$$;",
      ].join("\n"),
    },
    {
      source: "governance.auth.has_role",
      sql: [
        "CREATE OR REPLACE FUNCTION auth.has_role(role_name text)",
        "RETURNS boolean",
        "LANGUAGE sql",
        "STABLE",
        "AS $$",
        "  SELECT EXISTS (",
        "    SELECT 1",
        "    FROM jsonb_array_elements_text(COALESCE(auth.jwt() -> 'app_metadata' -> 'roles', '[]'::jsonb)) AS assigned_role(role_name_value)",
        "    WHERE assigned_role.role_name_value = role_name",
        "  )",
        "$$;",
      ].join("\n"),
    },
    {
      source: "governance.auth.grants.authenticated",
      sql: [
        "DO $$",
        "BEGIN",
        "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
        "    EXECUTE 'GRANT USAGE ON SCHEMA auth TO authenticated';",
        "    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated';",
        "  END IF;",
        "END;",
        "$$;",
      ].join("\n"),
    },
  ];
}

function readArg(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === name) {
      return argv[index + 1];
    }

    if (argument.startsWith(`${name}=`)) {
      return argument.slice(name.length + 1);
    }
  }

  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function normalizeMigrationName(name: string): string {
  return name.replace(/\s+/g, "_").toLowerCase();
}

function toMigrationTimestamp(date: Date): string {
  const parts = [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
  ];

  return parts.join("");
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function renderRole(role: string): string {
  return role.toLowerCase() === "public" ? "PUBLIC" : quoteIdent(role);
}

function getColumnKeys(table: AnyPgTable): Set<string> {
  return new Set(Object.keys(getColumns(table)));
}

function assertColumnsExist(table: AnyPgTable, declaredColumns: string[] | undefined, context: string): void {
  if (!declaredColumns || declaredColumns.length === 0) {
    return;
  }

  const knownColumns = getColumnKeys(table);

  for (const column of declaredColumns) {
    if (!knownColumns.has(column)) {
      throw new Error(`${context} references unknown column ${column}.`);
    }
  }
}

function buildGovernanceStatements(registry: SyncTableRegistry): GovernanceStatement[] {
  const statements: GovernanceStatement[] = [];
  let requiresAuthHelpers = false;

  for (const [registryKey, entry] of Object.entries(registry)) {
    if (!entry.governance) {
      continue;
    }

    const table = entry.table as AnyPgTable;
    const tableName = getTableName(table);
    const governance = tableGovernanceSpecSchema.parse(entry.governance);

    for (const constraint of governance.deferrableConstraints ?? []) {
      assertColumnsExist(table, constraint.columns, `registry.${registryKey}.governance.deferrableConstraints`);

      const initialMode = constraint.initiallyDeferred ? "INITIALLY DEFERRED" : "INITIALLY IMMEDIATE";
      statements.push({
        source: `registry.${registryKey}.governance.deferrableConstraints.${constraint.constraintName}`,
        sql: [
          `ALTER TABLE ${quoteIdent(tableName)}`,
          `ALTER CONSTRAINT ${quoteIdent(constraint.constraintName)}`,
          `DEFERRABLE ${initialMode};`,
        ].join("\n"),
      });
    }

    if (!governance.rls) {
      continue;
    }

    const { enabled, force, policies } = governance.rls;

    if (!enabled && policies.length > 0) {
      throw new Error(`registry.${registryKey}.governance.rls declares policies while enabled=false.`);
    }

    if (!enabled) {
      continue;
    }

    requiresAuthHelpers = true;

    statements.push({
      source: `registry.${registryKey}.governance.rls.enabled`,
      sql: `ALTER TABLE ${quoteIdent(tableName)} ENABLE ROW LEVEL SECURITY;`,
    });

    const grantedCommands = new Set<string>();

    for (const policy of policies) {
      if (policy.command === "all") {
        grantedCommands.add("SELECT");
        grantedCommands.add("INSERT");
        grantedCommands.add("UPDATE");
        grantedCommands.add("DELETE");
        continue;
      }

      grantedCommands.add(policy.command.toUpperCase());
    }

    if (grantedCommands.size > 0) {
      statements.push({
        source: `registry.${registryKey}.governance.rls.grants.authenticated`,
        sql: [
          "DO $$",
          "BEGIN",
          "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN",
          `    EXECUTE 'GRANT ${Array.from(grantedCommands).join(", ")} ON TABLE ${quoteIdent(tableName)} TO authenticated';`,
          "  END IF;",
          "END;",
          "$$;",
        ].join("\n"),
      });
    }

    if (force) {
      statements.push({
        source: `registry.${registryKey}.governance.rls.force`,
        sql: `ALTER TABLE ${quoteIdent(tableName)} FORCE ROW LEVEL SECURITY;`,
      });
    }

    for (const policy of policies) {
      assertColumnsExist(
        table,
        policy.usingColumns,
        `registry.${registryKey}.governance.rls.policy.${policy.name}.usingColumns`,
      );
      assertColumnsExist(
        table,
        policy.withCheckColumns,
        `registry.${registryKey}.governance.rls.policy.${policy.name}.withCheckColumns`,
      );

      const commandSql = policy.command === "all" ? "ALL" : policy.command.toUpperCase();
      const modeSql = policy.as.toUpperCase();
      const rolesSql = policy.roles.map((role) => renderRole(role)).join(", ");
      const usingSql = policy.using ? ` USING (${policy.using})` : "";
      const withCheckSql = policy.withCheck ? ` WITH CHECK (${policy.withCheck})` : "";

      statements.push({
        source: `registry.${registryKey}.governance.rls.policy.${policy.name}`,
        sql: [
          `DROP POLICY IF EXISTS ${quoteIdent(policy.name)} ON ${quoteIdent(tableName)};`,
          `CREATE POLICY ${quoteIdent(policy.name)} ON ${quoteIdent(tableName)}`,
          `AS ${modeSql}`,
          `FOR ${commandSql}`,
          `TO ${rolesSql}${usingSql}${withCheckSql};`,
        ].join("\n"),
      });
    }
  }

  if (!requiresAuthHelpers) {
    return statements;
  }

  return [...buildSupabaseAuthHelperStatements(), ...statements];
}

function buildMigrationSql(statements: GovernanceStatement[]): string {
  const body = statements
    .map((statement) => `-- Source: ${statement.source}\n${statement.sql}`)
    .join("\n--> statement-breakpoint\n");

  return [
    "-- Generated by scripts/generate-governance-migration.ts",
    `-- Registry source: ${REGISTRY_SOURCE}`,
    "",
    body,
    "",
  ].join("\n");
}

async function findLatestGeneratedMigrationFile(migrationsDir: string, migrationName: string): Promise<string | null> {
  const normalizedMigrationName = normalizeMigrationName(migrationName);

  let entries: string[];

  try {
    entries = await readdir(migrationsDir, { encoding: "utf8" });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }

  const migrationDirs = entries
    .filter((entry) => entry.endsWith(`_${normalizedMigrationName}`))
    .sort((left, right) => left.localeCompare(right));

  const latestDir = migrationDirs.at(-1);

  if (!latestDir) {
    return null;
  }

  return path.join(migrationsDir, latestDir, "migration.sql");
}

async function readExistingFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const migrationsDir = readArg(argv, "--migrations-dir") ?? DEFAULT_MIGRATIONS_DIR;
  const migrationName = readArg(argv, "--name") ?? DEFAULT_MIGRATION_NAME;
  const timestamp = readArg(argv, "--timestamp") ?? toMigrationTimestamp(new Date());
  const explicitMigrationDir = readArg(argv, "--migration-dir");
  const allowOverwrite = hasFlag(argv, "--overwrite");
  const forceNew = hasFlag(argv, "--force-new");

  const statements = buildGovernanceStatements(demoSyncRegistry);

  if (statements.length === 0) {
    throw new Error("No governance metadata found in registry. Nothing to generate.");
  }

  const sqlOutput = buildMigrationSql(statements);
  const latestMigrationFile = explicitMigrationDir
    ? path.join(explicitMigrationDir, "migration.sql")
    : await findLatestGeneratedMigrationFile(migrationsDir, migrationName);

  if (!forceNew && latestMigrationFile) {
    const latestMigrationSql = await readExistingFileIfPresent(latestMigrationFile);

    if (latestMigrationSql === sqlOutput) {
      console.log(`No governance changes detected. Latest migration already matches: ${latestMigrationFile}`);
      return;
    }
  }

  const migrationDir =
    explicitMigrationDir ?? path.join(migrationsDir, `${timestamp}_${normalizeMigrationName(migrationName)}`);
  const migrationFile = path.join(migrationDir, "migration.sql");

  await mkdir(migrationDir, { recursive: true });

  if (!allowOverwrite) {
    try {
      await access(migrationFile);
      throw new Error(`Migration file already exists: ${migrationFile}. Pass --overwrite to replace it.`);
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }

  await writeFile(migrationFile, sqlOutput, "utf8");
  console.log(`Generated governance migration: ${migrationFile}`);
}

await main();
