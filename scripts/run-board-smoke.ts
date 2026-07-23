import { spawnSync } from "node:child_process";

// `test:integration:board` — the board demo's end-to-end smoke lane (plan Phase 9).
//
// Unlike the toolkit integration suites (which spin up an ISOLATED, ephemeral postgres+electric stack
// per run, scripts/run-integration-suite.ts), this drives the demo's REAL deployment topology — the
// trimmed self-hosted Supabase + Electric stack with the two bundled Deno edge functions. That stack
// has fixed ports and one project name (infra/compose/board-compose.yml), so this lane OWNS it: it
// brings the board stack up, seeds the deterministic fixtures, runs the smoke, and tears the stack
// down (volumes included). It therefore CANNOT run alongside a dev board stack you care about — it
// reseeds and removes the volumes. Pass `--keep` to leave the stack up afterwards (for debugging a
// failure); the seed + assertions still run.

const SMOKE_TEST = "tests/integration/board-smoke.integration.test.ts";
const keep = process.argv.includes("--keep");

// The first request after a fresh boot pays the edge-runtime cold start (~6s to import a function
// bundle) before the warmer sidecar gets ahead of it, so the smoke needs well above bun's 5s default.
const TEST_TIMEOUT_MS = 45_000;

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `infra:down` occasionally trips a rootless-podman "kill network process: permission denied" on the
// db container while the others are still detaching; a moment later it tears down cleanly. Retry once.
async function teardown(): Promise<void> {
  try {
    run("bun", ["run", "infra:down"]);
  } catch {
    console.warn("[board-smoke] infra:down failed once (rootless netns flake); retrying after 3s…");
    await sleep(3000);
    run("bun", ["run", "infra:down"]);
  }
}

async function main(): Promise<void> {
  let suiteError: unknown;

  try {
    // infra:up builds the edge-function bundles, brings the board stack up, and applies the board's
    // migrations; seed:board provisions the GoTrue identities + deterministic public fixtures.
    run("bun", ["run", "infra:up"]);
    run("bun", ["run", "seed:board"]);
    run("bun", ["test", "--bail", "--timeout", String(TEST_TIMEOUT_MS), SMOKE_TEST]);
  } catch (error) {
    suiteError = error;
  } finally {
    if (keep) {
      console.log("[board-smoke] --keep set; leaving the board stack up.");
    } else {
      try {
        await teardown();
      } catch (error) {
        console.error("[board-smoke] Failed to tear the board stack down.");
        if (!suiteError) suiteError = error;
      }
    }
  }

  if (suiteError) {
    throw suiteError;
  }
}

await main();
