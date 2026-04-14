import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable";
const DEFAULT_DRIZZLE_DIR = "drizzle";
const GOVERNANCE_SUFFIX = "_registry_governance";

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

function createPostgresClient(connectionString: string) {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");

  return postgres({
    host: url.hostname,
    port: Number(url.port || "5432"),
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: sslmode === "disable" ? false : "prefer",
    max: 1,
  });
}

async function findLatestGovernanceMigrationSql(drizzleDir: string): Promise<string> {
  const entries = await readdir(drizzleDir, { withFileTypes: true });
  const latestDirectory = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(GOVERNANCE_SUFFIX))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))[0];

  if (!latestDirectory) {
    throw new Error(
      `No governance migration directories ending with ${GOVERNANCE_SUFFIX} were found in ${drizzleDir}.`,
    );
  }

  return join(drizzleDir, latestDirectory, "migration.sql");
}

async function main() {
  const argv = process.argv.slice(2);
  const databaseUrl = readArg(argv, "--database-url") ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const drizzleDir = readArg(argv, "--drizzle-dir") ?? DEFAULT_DRIZZLE_DIR;
  const sqlFile = readArg(argv, "--sql-file") ?? (await findLatestGovernanceMigrationSql(drizzleDir));

  const ddl = await readFile(sqlFile, "utf8");
  const client = createPostgresClient(databaseUrl);
  const db = drizzle({ client });

  try {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql.raw(ddl));
  } finally {
    await db.execute(sql`RESET client_min_messages`);
    await client.end();
  }

  console.log(`Applied governance migration from ${sqlFile}`);
}

await main();
