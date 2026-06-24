import { spawnSync } from "node:child_process";

import { waitForPgReady, waitForTcpService } from "./lib";

// Brings up the board demo stack (infra/compose/board-compose.yml) and applies the board's own
// drizzle migrations to its database. Separate from `infra:up` (the toolkit harness) — the board runs
// on its own ports (db 54322, gateway 54331, electric 54330) so the two stacks never collide.

const COMPOSE_FILE = "infra/compose/board-compose.yml";
const ENV_FILE = "infra/compose/board.env";

const BOARD_DATABASE_URL =
  process.env["BOARD_DATABASE_URL"] ??
  "postgresql://supabase_admin:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function main(): Promise<void> {
  const env = { ...process.env, BOARD_DATABASE_URL };

  // The edge-runtime serves the bundled functions from supabase/functions-dist; build them first so a
  // fresh checkout (where the gitignored bundles are absent) comes up cleanly.
  run("bun", ["run", "edge:build"], env);

  run("podman", ["compose", "-f", COMPOSE_FILE, "--env-file", ENV_FILE, "up", "-d"], env);

  await Promise.all([
    waitForTcpService("127.0.0.1", 54322, "board Postgres"),
    waitForTcpService("127.0.0.1", 54331, "board Kong gateway"),
    waitForTcpService("127.0.0.1", 54330, "board Electric"),
  ]);
  await waitForPgReady(BOARD_DATABASE_URL);

  // Apply the board's tables + RLS + cross-team trigger + the registry's apply function. GoTrue runs
  // its own auth-schema migrations on first boot; the board only owns its public schema (Drizzle).
  run("bun", ["run", "db:board:migrate"], env);

  console.log("\nBoard stack is up:");
  console.log("  • Gateway (supabase-js SUPABASE_URL): http://localhost:54331");
  console.log("  • Studio:                              http://localhost:54333");
  console.log("  • Postgres:                            localhost:54322");
  console.log("\nNext: seed identities + fixtures (Phase 3), then `bun run dev:board`.");
}

await main();
