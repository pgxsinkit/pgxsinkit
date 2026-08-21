import { spawnSync } from "node:child_process";

import { composeCredentials } from "../infra/compose-credentials";
import { circuitsPgTablesEnv, waitForPgReady, waitForTcpService } from "./lib";

// `infra:harness:up` — the toolkit reference stack: postgres + durable-streams + the Circuits engine,
// the demo membership registry, and apps/write-api. This is NOT the substantial demo: that is the
// board stack (`infra:up`).
//
// Every service here runs a pinned published image — the engine included (the pgxsinkit fork's own
// build; see the compose file) — so a bring-up is a pull, never a build.
const COMPOSE_FILE = "infra/compose/docker-compose.yml";

const DEFAULT_DATABASE_URL = composeCredentials.DEFAULT_DATABASE_URL;

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function main() {
  // The engine's table list is derived from the registries this stack serves, not required from the
  // environment, so `infra:harness:up` works on a fresh clone with no `.env`.
  const env: NodeJS.ProcessEnv = { ...process.env, ...circuitsPgTablesEnv(process.env) };

  const databaseUrl = new URL(env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const dsPort = Number(env["PGXSINKIT_DS_PORT"] ?? 8791);
  const enginePort = Number(env["PGXSINKIT_CIRCUITS_ENGINE_PORT"] ?? 7010);

  runCommand("podman", ["compose", "-f", COMPOSE_FILE, "up", "-d"], env);

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
