import { spawnSync } from "node:child_process";

import { composeCredentials } from "../infra/compose-credentials";
import { waitForPgReady, waitForTcpService } from "./lib";

// `infra:harness:up` — the minimal toolkit reference stack (postgres + electric, the demo membership
// registry + apps/write-api). This is NOT the substantial demo: that is the board stack (`infra:up`).
// Manual/reference use only; the integration lane stands up its own isolated stacks.
const COMPOSE_FILE = "infra/compose/docker-compose.yml";

const DEFAULT_DATABASE_URL = composeCredentials.DEFAULT_DATABASE_URL;
const DEFAULT_ELECTRIC_URL = "http://localhost:3000/v1/shape";

function parsePort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function main() {
  const env = process.env;
  const databaseUrl = new URL(env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  const electricUrl = new URL(env["ELECTRIC_URL"] ?? DEFAULT_ELECTRIC_URL);

  runCommand("podman", ["compose", "-f", COMPOSE_FILE, "up", "-d"], env);
  await Promise.all([
    waitForTcpService(databaseUrl.hostname, parsePort(databaseUrl), "PostgreSQL"),
    waitForTcpService(electricUrl.hostname, parsePort(electricUrl), "ElectricSQL"),
  ]);
  await waitForPgReady(env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL);
  runCommand("bun", ["run", "db:migrate"], env);
  runCommand("bun", ["run", "seed:demo"], env);
}

await main();
