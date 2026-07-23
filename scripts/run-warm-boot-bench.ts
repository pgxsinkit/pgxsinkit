import { spawnSync } from "node:child_process";

// `bench:warm-boot` — the Slice 0a warm-boot browser benchmark runner (MANUAL/NIGHTLY, deliberately NOT
// wired into test:integration or test:performance). Like scripts/run-worker-lane.ts it OWNS the board's
// real deployment stack (infra/compose/board-compose.yml, fixed ports, project `pgxsinkit-board`): it
// brings a fresh stack up, seeds the deterministic fixtures, runs Playwright with a DEDICATED config
// (playwright.warm-boot.config.ts → tests/e2e/warm-boot.bench.ts) that the normal e2e lane cannot see,
// and tears the stack down again. Because it reseeds + removes volumes, it CANNOT run alongside a board
// stack you care about — so, per the repo rule, it REFUSES to start over an already-running board stack
// rather than nuking it. Pass `--keep` to leave the stack up afterwards (to inspect a run).

const keep = process.argv.includes("--keep");

// Lane hermeticity: the workspace-root `.env` leaks into this runner (bun auto-loads it) and into vite's
// build (envDir = workspace root). Pin every var the seed and the board build read to THIS lane's own
// stack — identical to run-worker-lane.ts — so a leaking `.env` can neither reprovision a foreign
// Supabase nor bake foreign URLs into the built artifact. Explicit values, never deletion (a deleted key
// is re-filled by the child bun's own `.env` auto-load).
const laneEnv: Record<string, string | undefined> = {
  ...process.env,
  BOARD_GATEWAY_URL: "http://localhost:54331",
  BOARD_SECRET_KEY: "sb_secret_boarddemoLOCALxxxxxxxxxxxxxxx_demo0000",
  BOARD_DATABASE_URL:
    "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable",
  BOARD_SEED_PASSWORD: "board-demo-password",
  DATABASE_URL:
    "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable",
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

// Repo rule: podman only, and never start over a running stack. Report any RUNNING board-* container
// (the board-compose services all use `board-` container names) and refuse — the caller tears it down.
function runningBoardContainers(): string[] {
  const result = spawnSync("podman", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`podman ps failed (is podman installed?): ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith("board-"));
}

// `infra:down` occasionally trips a rootless-podman "kill network process: permission denied" on the db
// container while the others are still detaching; a moment later it tears down cleanly. Retry once.
async function teardown(): Promise<void> {
  try {
    run("bun", ["run", "infra:down"]);
  } catch {
    console.warn("[warm-boot-bench] infra:down failed once (rootless netns flake); retrying after 3s…");
    await sleep(3000);
    run("bun", ["run", "infra:down"]);
  }
}

async function main(): Promise<void> {
  const running = runningBoardContainers();
  if (running.length > 0) {
    throw new Error(
      `[warm-boot-bench] Refusing to start over a running board stack: ${running.join(", ")}. ` +
        `This lane reseeds and removes the stack's volumes. Tear it down first (bun run infra:down), then re-run.`,
    );
  }

  let suiteError: unknown;

  // Start from a known-clean stack (removes any stopped leftovers from a prior aborted run).
  await teardown();

  try {
    run("bun", ["run", "infra:up"]);
    run("bun", ["run", "seed:board"]);
    run("bunx", ["playwright", "test", "--config", "playwright.warm-boot.config.ts"]);
  } catch (error) {
    suiteError = error;
  } finally {
    if (keep) {
      console.log("[warm-boot-bench] --keep set; leaving the board stack up.");
    } else {
      try {
        await teardown();
      } catch (error) {
        console.error("[warm-boot-bench] Failed to tear the board stack down.");
        if (!suiteError) suiteError = error;
      }
    }
  }

  if (suiteError) {
    throw suiteError;
  }
}

await main();
