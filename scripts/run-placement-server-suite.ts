import { type ChildProcess, spawn, spawnSync } from "node:child_process";

import { composeCredentials } from "../infra/compose-credentials";
import { allocatePort, runComposeDown, waitForPgReady, waitForTcpService } from "./lib";
import { startPlacementFixtureServer } from "./placement-fixture-server";

// `test:browser:placement:server` (all configured browsers) / `test:integration:placement` (Chromium) — the
// ADR-0049 step-12 SERVER-backed placement lanes. Mirrors
// scripts/run-integration-suite.ts (per-run podman project, allocated ports, teardown ALWAYS) but ALSO boots an
// in-process fixture server (the REAL createSyncServer write handler + Electric proxy over the container stack,
// with a control surface), threads its URLs to the Playwright build via env, and runs the placement suite. The
// serverless `test:browser:placement` is untouched: the three server lanes detect `PLACEMENT_SERVER_URL` and skip
// with a precise reason when it is absent, so the default suite needs no podman.

const COMPOSE_FILE = "infra/compose/docker-compose.yml";
const SERVICE_START_TIMEOUT_MS = 120_000;
const PLACEMENT_ORIGIN = "http://127.0.0.1:4290";

function runSync(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(" ")}`);
}

/** Run a command ASYNC so the launcher's event loop stays free for the in-process fixture Bun.serve. */
function spawnWithCompletion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  child: ChildProcess;
  completion: Promise<number>;
} {
  const child = spawn(command, args, { env, stdio: "inherit" });
  return {
    child,
    completion: new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
    }),
  };
}

async function main(): Promise<void> {
  const postgresPort = await allocatePort();
  let electricPort = await allocatePort();
  while (electricPort === postgresPort) electricPort = await allocatePort();
  let fixturePort = await allocatePort();
  while (fixturePort === postgresPort || fixturePort === electricPort) fixturePort = await allocatePort();

  const composeProject = `pgxsinkit-placement-${Date.now().toString(36)}-${process.pid}`;
  const composeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGXSINKIT_INTEGRATION_POSTGRES_PORT: String(postgresPort),
    PGXSINKIT_ELECTRIC_PORT: String(electricPort),
  };
  const databaseUrl = composeCredentials.buildLocalDatabaseUrl("127.0.0.1", postgresPort);
  const electricUrl = `http://127.0.0.1:${electricPort}/v1/shape`;

  let composeStarted = false;
  let fixture: Awaited<ReturnType<typeof startPlacementFixtureServer>> | undefined;
  let suiteChild: ChildProcess | undefined;
  let suiteError: unknown;
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals): void => {
    if (interruptedBy !== undefined) return;
    interruptedBy = signal;
    suiteError = new Error(`Placement server suite interrupted by ${signal}`);
    // Playwright owns the Vite webServer lifecycle. Let it observe termination and clean that child up while
    // this launcher remains alive long enough to run its own fixture/container `finally` block.
    suiteChild?.kill(signal);
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  console.log("[placement-server] Launching isolated containers", {
    composeProject,
    postgresPort,
    electricPort,
    fixturePort,
  });

  try {
    runSync("podman", ["compose", "-f", COMPOSE_FILE, "-p", composeProject, "up", "-d"], composeEnv);
    composeStarted = true;
    await waitForTcpService("127.0.0.1", postgresPort, "PostgreSQL", SERVICE_START_TIMEOUT_MS);
    await waitForPgReady(databaseUrl);
    await waitForTcpService("127.0.0.1", electricPort, "ElectricSQL", SERVICE_START_TIMEOUT_MS);

    // db:migrate installs the clock function + every schema/integration table (incl. fk_parents) + the demo
    // apply artefacts; the fixture then installs the fk registry's batch-apply function on top.
    runSync("bun", ["run", "db:migrate"], { ...composeEnv, DATABASE_URL: databaseUrl, ELECTRIC_URL: electricUrl });

    fixture = await startPlacementFixtureServer({
      databaseUrl,
      electricUrl,
      port: fixturePort,
      allowedOrigins: [PLACEMENT_ORIGIN],
    });
    console.log("[placement-server] Fixture server up", {
      batchWriteUrl: fixture.batchWriteUrl,
      electricProxyUrl: fixture.electricProxyUrl,
    });

    const suiteEnv: NodeJS.ProcessEnv = {
      ...composeEnv,
      PLACEMENT_SERVER_URL: `http://127.0.0.1:${fixturePort}`,
      // Baked into the placement bundle at vite build time (Playwright's webServer inherits this env).
      VITE_PLACEMENT_WRITE_URL: fixture.batchWriteUrl,
      VITE_PLACEMENT_ELECTRIC_URL: fixture.electricProxyUrl,
    };
    const args = [
      "playwright",
      "test",
      "--config",
      "tests/e2e/placement/playwright.config.ts",
      ...process.argv.slice(2),
    ];
    const suite = spawnWithCompletion("bunx", args, suiteEnv);
    suiteChild = suite.child;
    if (interruptedBy !== undefined) suiteChild.kill(interruptedBy);
    const code = await suite.completion;
    if (code !== 0) suiteError = new Error(`Playwright placement suite failed (exit ${code})`);
  } catch (error) {
    suiteError = error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (fixture) {
      try {
        await fixture.stop();
      } catch (error) {
        console.error("[placement-server] fixture stop failed", error);
      }
    }
    if (composeStarted) {
      try {
        console.log("[placement-server] Tearing down isolated containers", { composeProject });
        runComposeDown(composeEnv, composeProject, "placement-server");
      } catch (error) {
        console.error("[placement-server] Failed to tear down containers.");
        if (!suiteError) suiteError = error;
      }
    }
  }

  if (suiteError) throw suiteError;
}

await main();
