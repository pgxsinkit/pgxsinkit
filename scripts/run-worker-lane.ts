import { spawnSync } from "node:child_process";

// `test:integration:worker` — the ADR-0032 S3 browser lane runner. Like scripts/run-board-smoke.ts it
// OWNS the board's real deployment stack (infra/compose/board-compose.yml, fixed ports, one project
// name): it tears any prior stack down, brings a fresh one up, seeds the deterministic fixtures, runs
// the Playwright SharedWorker scenarios against it (Chromium → the caddy h2/h3 front on :54343; the
// BUILT board app is compiled + served by Playwright's `webServer`), and tears the stack down again. It
// therefore CANNOT run alongside a dev board stack you care about — it reseeds and removes the volumes.
// Pass `--keep` to leave the stack up afterwards (to debug a failure); the seed + assertions still run.

const keep = process.argv.includes("--keep");

// ── Lane hermeticity ──────────────────────────────────────────────────────────────────────────────
// The developer's workspace-root `.env` may redirect the board at OTHER environments (the kube/cloud
// dev flows set BOARD_GATEWAY_URL / DATABASE_URL / VITE_BOARD_* there). That file leaks into this lane
// through TWO doors: bun auto-loads `.env` into every bun process's env (including this runner's, which
// children then inherit), and vite's `envDir` is the workspace root (and process env outranks env
// files). Left unpinned, the lane's seed provisions the WRONG Supabase while its own podman stack stays
// empty, and the built app bakes foreign URLs — signed-in-but-zero-rows chaos (observed 2026-07-05).
// So every var the seed or the board build reads is pinned HERE, explicitly, to the lane's own stack
// (values mirror the seed's demo defaults / infra/compose/board.env). Explicit values — never deletion:
// a deleted key would just be re-filled by the child bun's own `.env` auto-load.
const laneEnv: Record<string, string | undefined> = {
  ...process.env,
  // Seed (scripts/seed-board.ts) — the lane's gateway, secret, db, and password.
  BOARD_GATEWAY_URL: "http://localhost:54331",
  BOARD_SECRET_KEY: "sb_secret_boarddemoLOCALxxxxxxxxxxxxxxx_demo0000",
  BOARD_DATABASE_URL:
    "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable",
  BOARD_SEED_PASSWORD: "board-demo-password",
  // Pinned to the LANE's db (not emptied): `?? default` readers treat "" as a real value, and a
  // DELETED key would be re-filled from the developer's .env by the child bun's auto-load.
  DATABASE_URL:
    "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable",
  // Board build (apps/board/src/config.ts + router.tsx via Playwright's webServer → vite build). The
  // empty strings pin "unset" semantics against a leaking .env; VITE_E2E keeps the dev introspection
  // handles the scenarios drive in the production bundle.
  VITE_E2E: "1",
  VITE_BOARD_SUPABASE_URL: "https://localhost:54343",
  VITE_BOARD_GATEWAY_URL: "http://localhost:54331",
  VITE_BOARD_PUBLISHABLE_KEY: "sb_publishable_boarddemoLOCALxxxxxxxxx_demo0000",
  VITE_BOARD_FUNCTIONS_REGION: "",
  VITE_BOARD_SEED_PASSWORD: "board-demo-password",
  VITE_BOARD_HASH_ROUTING: "",
};

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", env: laneEnv });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `infra:down` occasionally trips a rootless-podman "kill network process: permission denied" on the db
// container while the others are still detaching; a moment later it tears down cleanly. Retry once.
async function teardown(): Promise<void> {
  try {
    run("bun", ["run", "infra:down"]);
  } catch {
    console.warn("[worker-lane] infra:down failed once (rootless netns flake); retrying after 3s…");
    await sleep(3000);
    run("bun", ["run", "infra:down"]);
  }
}

async function main(): Promise<void> {
  let suiteError: unknown;

  // Start from a known-clean stack: tear any prior board deployment down before bringing a fresh one up
  // (mirrors the smoke lane's ownership of the shared, fixed-port stack).
  await teardown();

  try {
    // infra:up issues the caddy TLS cert (mkcert; short-circuits when the files already exist — it never
    // runs mkcert on the owner's machine), builds the edge bundles, brings the board stack up, and applies
    // its migrations. seed:board provisions the GoTrue identities + deterministic public fixtures.
    run("bun", ["run", "infra:up"]);
    run("bun", ["run", "seed:board"]);
    // Playwright drives the scenarios; its `webServer` block BUILDS the board (VITE_E2E=1) and serves the
    // built artifact via `vite preview` on :5173 — the lane tests what ships, not the dev server.
    run("bunx", ["playwright", "test", "--config", "playwright.config.ts"]);
  } catch (error) {
    suiteError = error;
  } finally {
    if (keep) {
      console.log("[worker-lane] --keep set; leaving the board stack up.");
    } else {
      try {
        await teardown();
      } catch (error) {
        console.error("[worker-lane] Failed to tear the board stack down.");
        if (!suiteError) suiteError = error;
      }
    }
  }

  if (suiteError) {
    throw suiteError;
  }
}

await main();
