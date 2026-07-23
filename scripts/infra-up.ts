import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { waitForHttpOk, waitForPgReady, waitForTcpService } from "./lib";

// `infra:up` — brings up the board demo stack (infra/compose/board-compose.yml, the substantial demo
// that replaced apps/web) and applies the board's own drizzle migrations. The minimal toolkit harness
// (postgres + electric for the apps/write-api reference) is a separate stack under `infra:harness:up`;
// the board runs on its own ports (db 54322, gateway 54331, electric 54330) so the two never collide.

const COMPOSE_FILE = "infra/compose/board-compose.yml";
const ENV_FILE = "infra/compose/board.env";

const BOARD_DATABASE_URL =
  process.env["BOARD_DATABASE_URL"] ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable";

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

const CERT_DIR = "infra/compose/certs";

// Issue the board's TLS cert for the caddy HTTP/2 + HTTP/3 front (the fix for browser write-starvation
// behind the board's 6 Electric long-polls — see board-compose.yml `caddy`). mkcert signs it with the
// locally trusted CA, so the browser, and HTTP/3's QUIC (which refuses an untrusted cert), accept it
// with no extra steps. Returns whether the cert is available so the readiness wait can skip 54343 when
// it is not. mkcert is needed only for the interactive browser demo: the container lanes (integration
// smoke) reach envoy directly on 54331, so a missing mkcert must never fail them — warn and continue.
function ensureBoardCert(): boolean {
  const certFile = path.join(CERT_DIR, "localhost.pem");
  const keyFile = path.join(CERT_DIR, "localhost-key.pem");
  if (existsSync(certFile) && existsSync(keyFile)) return true;

  if (spawnSync("mkcert", ["-CAROOT"], { stdio: "ignore" }).status !== 0) {
    console.warn(
      "[infra:up] mkcert not found — skipping the board TLS cert. The HTTP/2+3 front " +
        "(https://localhost:54343) will be unavailable; the HTTP/1.1 gateway on :54331 still works. " +
        "Install mkcert and run `mkcert -install` once for the fast browser demo.",
    );
    return false;
  }

  mkdirSync(CERT_DIR, { recursive: true });
  const result = spawnSync("mkcert", ["-cert-file", certFile, "-key-file", keyFile, "localhost", "127.0.0.1", "::1"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.warn(
      "[infra:up] mkcert failed to issue the board cert; the caddy front is unavailable (:54331 still works).",
    );
    return false;
  }
  return true;
}

// On a readiness timeout, the containers are torn down before anyone can inspect them (CI runs
// `infra:down` unconditionally), so the WHY is lost — dump the suspect containers' logs first. Seen
// live 2026-07-08: GoTrue healthy in ~2.6s on every green run, then two consecutive CI runs where it
// never answered within the 60s budget and the lane failed with nothing but "Timed out waiting".
function dumpComposeStateOnFailure(env: NodeJS.ProcessEnv): void {
  console.error("\n[infra:up] readiness wait failed — dumping compose state before teardown:");
  for (const args of [
    ["compose", "-f", COMPOSE_FILE, "--env-file", ENV_FILE, "ps"],
    ["compose", "-f", COMPOSE_FILE, "--env-file", ENV_FILE, "logs", "--tail", "100", "db", "auth", "envoy"],
  ]) {
    // Best-effort: a diagnostics failure must never mask the original timeout error.
    spawnSync("podman", args, { env, stdio: "inherit" });
  }
}

async function main(): Promise<void> {
  const env = { ...process.env, BOARD_DATABASE_URL };

  // Issue the caddy TLS cert before bringing the stack up, so its h2/h3 front has a cert to load.
  const certReady = ensureBoardCert();

  // The edge-runtime serves the bundled functions from supabase/functions-dist; build them first so a
  // fresh checkout (where the gitignored bundles are absent) comes up cleanly.
  run("bun", ["run", "edge:build"], env);

  run("podman", ["compose", "-f", COMPOSE_FILE, "--env-file", ENV_FILE, "up", "-d"], env);

  const readiness = [
    waitForTcpService("127.0.0.1", 54322, "board Postgres"),
    waitForTcpService("127.0.0.1", 54331, "board Envoy gateway"),
    waitForTcpService("127.0.0.1", 54330, "board Electric"),
  ];
  // Only gate on the caddy front when its cert exists; otherwise it never comes up (and the container
  // lanes do not need it), so waiting on 54343 would hang.
  if (certReady) {
    readiness.push(waitForTcpService("127.0.0.1", 54343, "board Caddy (HTTP/2+3 front)"));
  }
  try {
    await Promise.all(readiness);
    await waitForPgReady(BOARD_DATABASE_URL);

    // Apply the board's tables + RLS + cross-team trigger + the registry's apply function. GoTrue runs
    // its own auth-schema migrations on first boot; the board only owns its public schema (Drizzle).
    run("bun", ["run", "db:board:migrate"], env);

    // GoTrue boots its own auth-schema migrations after the DB is healthy, so an open Envoy port does not
    // mean the auth API answers yet. Wait for it through the gateway so an immediately-following
    // `seed:board` (which provisions identities via the GoTrue admin API) does not race the boot.
    await waitForHttpOk("http://localhost:54331/auth/v1/health", "board GoTrue");
  } catch (error) {
    dumpComposeStateOnFailure(env);
    throw error;
  }

  console.log("\nBoard stack is up:");
  if (certReady) {
    console.log("  • Browser demo origin (HTTP/2+3 fast path): https://localhost:54343");
  }
  console.log("  • Gateway (HTTP/1.1; tests + seed scripts): http://localhost:54331");
  console.log("  • Studio:                                   http://localhost:54333");
  console.log("  • Postgres:                                 localhost:54322");
  console.log("\nNext: seed identities + fixtures (`bun run seed:board`), then `bun run dev:board`.");
}

await main();
