import { spawnSync } from "node:child_process";

import { composeCredentials } from "../infra/compose-credentials";
import { allocatePort, runComposeDown, waitForPgReady, waitForTcpService } from "./lib";

const COMPOSE_FILE = "infra/compose/docker-compose.yml";
const SERVICE_START_TIMEOUT_MS = 120_000;

function assertTestFiles(args: string[]): string[] {
  const testFiles = args.filter((arg) => arg.endsWith(".test.ts"));

  if (testFiles.length === 0) {
    throw new Error("No integration test files provided. Pass one or more *.test.ts paths.");
  }

  return testFiles;
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

function buildProjectName(): string {
  return `pgxsinkit-it-${Date.now().toString(36)}-${process.pid}`;
}

async function main() {
  const testFiles = assertTestFiles(process.argv.slice(2));

  const postgresPort = await allocatePort();
  let electricPort = await allocatePort();

  while (electricPort === postgresPort) {
    electricPort = await allocatePort();
  }

  const composeProject = buildProjectName();
  const composeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGXSINKIT_INTEGRATION_POSTGRES_PORT: String(postgresPort),
    PGXSINKIT_ELECTRIC_PORT: String(electricPort),
  };

  const databaseUrl = composeCredentials.buildLocalDatabaseUrl("127.0.0.1", postgresPort);
  const electricUrl = `http://127.0.0.1:${electricPort}/v1/shape`;
  const testEnv: NodeJS.ProcessEnv = {
    ...composeEnv,
    DATABASE_URL: databaseUrl,
    ELECTRIC_URL: electricUrl,
  };

  let composeStarted = false;
  let suiteError: unknown;
  let teardownError: unknown;

  console.log("[integration] Launching isolated containers", {
    composeProject,
    postgresPort,
    electricPort,
  });

  try {
    runCommand("podman", ["compose", "-f", COMPOSE_FILE, "-p", composeProject, "up", "-d"], composeEnv);
    composeStarted = true;

    await waitForTcpService("127.0.0.1", postgresPort, "PostgreSQL", SERVICE_START_TIMEOUT_MS);
    await waitForPgReady(databaseUrl);
    await waitForTcpService("127.0.0.1", electricPort, "ElectricSQL", SERVICE_START_TIMEOUT_MS);

    runCommand("bun", ["run", "db:migrate"], testEnv);
    runCommand("bun", ["run", "vitest", "run", "--no-file-parallelism", ...testFiles], testEnv);
  } catch (error) {
    suiteError = error;
  } finally {
    if (composeStarted) {
      try {
        console.log("[integration] Tearing down isolated containers", { composeProject });
        runComposeDown(composeEnv, composeProject, "integration");
      } catch (error) {
        console.error("[integration] Failed to tear down isolated containers.");
        teardownError = error;
      }
    }
  }

  if (suiteError) {
    throw suiteError;
  }

  if (teardownError) {
    throw teardownError;
  }
}

await main();
