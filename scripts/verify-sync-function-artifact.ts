import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable";

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

type FunctionPresenceRow = {
  functionName: string | null;
};

async function main() {
  const databaseUrl =
    readArg(process.argv.slice(2), "--database-url") ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const client = createPostgresClient(databaseUrl);
  const db = drizzle({ client });

  try {
    const result = await db.execute<FunctionPresenceRow>(sql`
      SELECT to_regprocedure('public.pgxsinkit_apply_batch_mutations(jsonb,text,boolean,boolean,jsonb)')::text AS "functionName"
    `);

    const row = Array.from(result, (entry) => entry as FunctionPresenceRow)[0];

    if (!row?.functionName) {
      throw new Error(
        "Missing required sync function: public.pgxsinkit_apply_batch_mutations(jsonb,text,boolean,boolean,jsonb). Apply function artifacts before running bulk-plpgsql-artifact.",
      );
    }
  } finally {
    await client.end();
  }

  console.log("Verified sync function artifact is installed.");
}

await main();
