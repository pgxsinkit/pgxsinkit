import { spawnSync } from "node:child_process";

import { composeCredentials } from "../infra/compose-credentials";
import { waitForPgReady, waitForTcpService } from "./lib";

// `infra:circuits:up` — the Circuits-native substrate (postgres + durable-streams + the engine) that
// the native integration lane runs against, replacing the Electric harness (ADR-0055).
//
// The engine is OUR FORK, so it is built from a checkout rather than pulled. That build is a Rust
// release build and takes minutes of full-core CPU, which is why this script refuses to start it
// implicitly: `--build` is required the first time and after every fork change. Everything else is a
// pull of the official durable-streams image and a Postgres start.
const COMPOSE_FILE = "infra/compose/circuits-compose.yml";

const DEFAULT_DATABASE_URL = composeCredentials.DEFAULT_DATABASE_URL;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { env: process.env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — ${hint}`);
  }
  return value;
}

async function main() {
  // Fail here, with the reason, rather than letting compose fail with a variable-substitution error
  // that says nothing about what the caller was supposed to provide.
  requireEnv(
    "PGXSINKIT_CIRCUITS_REPO",
    "point it at an electric-circuits checkout; the engine is our fork and is built from source",
  );
  requireEnv(
    "PGXSINKIT_CIRCUITS_PG_TABLES",
    "the engine needs an EXPLICIT table list. `*` sweeps in the operations log and pgmq's relations " +
      "(docs/research/0001), which are not sync tables and must not become shapes",
  );

  const build = process.argv.includes("--build");
  const databaseUrl = new URL(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const dsPort = Number(process.env["PGXSINKIT_CIRCUITS_DS_PORT"] ?? 8791);
  const enginePort = Number(process.env["PGXSINKIT_CIRCUITS_ENGINE_PORT"] ?? 7010);

  run("podman", ["compose", "-f", COMPOSE_FILE, "up", "-d", ...(build ? ["--build"] : [])]);

  await waitForTcpService(databaseUrl.hostname, Number(databaseUrl.port || 5432), "PostgreSQL");
  await waitForPgReady(process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);

  // Migrate BEFORE waiting on the engine: it introspects its table set at startup and exits when the
  // tables are absent, so the ordering here is what turns its restart loop into a single retry rather
  // than a wait that can never succeed.
  run("bun", ["run", "db:migrate"]);

  await waitForTcpService("127.0.0.1", dsPort, "durable-streams");
  await waitForTcpService("127.0.0.1", enginePort, "circuits-engine");
}

await main();
