import { spawnSync } from "node:child_process";

import { composeCredentials } from "../infra/compose-credentials";
import { waitForPgReady, waitForTcpService } from "./lib";

// `infra:harness:up` — the toolkit reference stack: postgres + durable-streams + the Circuits engine,
// the demo membership registry, and apps/write-api. This is NOT the substantial demo: that is the
// board stack (`infra:up`).
//
// The ENGINE is built from an electric-circuits checkout, and that is a Rust release build costing
// minutes of full-core CPU. So `--build` is required explicitly rather than implied: without it this
// starts whatever image is already tagged, which is what you want on every run but the first and
// after every engine change.
const COMPOSE_FILE = "infra/compose/docker-compose.yml";

const DEFAULT_DATABASE_URL = composeCredentials.DEFAULT_DATABASE_URL;

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, hint: string): void {
  // Fail here, with the reason, rather than letting compose fail with a variable-substitution error
  // that says nothing about what the caller was supposed to provide.
  if (!env[name]) throw new Error(`${name} is not set — ${hint}`);
}

async function main() {
  const env = process.env;
  requireEnv(
    env,
    "PGXSINKIT_CIRCUITS_REPO",
    "point it at an electric-circuits checkout; the engine image is built from its Dockerfile",
  );
  requireEnv(
    env,
    "PGXSINKIT_CIRCUITS_PG_TABLES",
    "the engine needs an EXPLICIT table list. `*` sweeps in the operations log and pgmq's relations " +
      "(docs/research/0001), which are not sync tables and must not become shapes",
  );

  const build = process.argv.includes("--build");
  const databaseUrl = new URL(env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const dsPort = Number(env["PGXSINKIT_DS_PORT"] ?? 8791);
  const enginePort = Number(env["PGXSINKIT_CIRCUITS_ENGINE_PORT"] ?? 7010);

  runCommand("podman", ["compose", "-f", COMPOSE_FILE, "up", "-d", ...(build ? ["--build"] : [])], env);

  await waitForTcpService(databaseUrl.hostname, Number(databaseUrl.port || 5432), "PostgreSQL");
  await waitForPgReady(env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);

  // Migrate BEFORE waiting on the engine: it introspects its table set at startup and exits when the
  // tables are absent, so this ordering is what turns its restart loop into a single retry rather
  // than a wait that can never succeed.
  runCommand("bun", ["run", "db:migrate"], env);

  await waitForTcpService("127.0.0.1", dsPort, "durable-streams");
  await waitForTcpService("127.0.0.1", enginePort, "circuits-engine");

  runCommand("bun", ["run", "seed:demo"], env);
}

await main();
