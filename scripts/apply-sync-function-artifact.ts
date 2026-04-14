import { readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable";
const DEFAULT_SQL_FILE = "infra/sql/functions/pgxsinkit_apply_batch_mutations.sql";

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

async function main() {
  const argv = process.argv.slice(2);
  const databaseUrl = readArg(argv, "--database-url") ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const sqlFile = readArg(argv, "--sql-file") ?? DEFAULT_SQL_FILE;

  const ddl = await readFile(sqlFile, "utf8");
  const client = createPostgresClient(databaseUrl);
  const db = drizzle({ client });

  try {
    await db.execute(sql.raw(ddl));

    await db.execute(sql`
      SELECT to_regprocedure('public.pgxsinkit_apply_batch_mutations(jsonb,text,boolean,boolean,jsonb)')::text AS "functionName"
    `);
  } finally {
    await client.end();
  }

  console.log(`Applied sync function artifact from ${sqlFile}`);
}

await main();
