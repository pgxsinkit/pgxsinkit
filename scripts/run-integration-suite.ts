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
  let dsPort = await allocatePort();
  while (dsPort === postgresPort) dsPort = await allocatePort();
  let enginePort = await allocatePort();
  while (enginePort === postgresPort || enginePort === dsPort) enginePort = await allocatePort();

  const composeProject = buildProjectName();
  const composeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGXSINKIT_INTEGRATION_POSTGRES_PORT: String(postgresPort),
    PGXSINKIT_DS_PORT: String(dsPort),
    PGXSINKIT_CIRCUITS_ENGINE_PORT: String(enginePort),
  };

  const databaseUrl = composeCredentials.buildLocalDatabaseUrl("127.0.0.1", postgresPort);
  // Only the two CONTAINER endpoints are handed to the tests. There is no read URL to pass any more:
  // the control plane and the edge are TypeScript, so each test file stands its own up in-process
  // (`startNativeSyncStack`) and knows its own URLs (ADR-0055 decision 8).
  const testEnv: NodeJS.ProcessEnv = {
    ...composeEnv,
    DATABASE_URL: databaseUrl,
    CIRCUITS_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
    DURABLE_STREAMS_URL: `http://127.0.0.1:${dsPort}`,
  };

  let composeStarted = false;
  let suiteError: unknown;
  let teardownError: unknown;

  console.log("[integration] Launching isolated containers", {
    composeProject,
    postgresPort,
    dsPort,
    enginePort,
  });

  try {
    runCommand("podman", ["compose", "-f", COMPOSE_FILE, "-p", composeProject, "up", "-d"], composeEnv);
    composeStarted = true;

    await waitForTcpService("127.0.0.1", postgresPort, "PostgreSQL", SERVICE_START_TIMEOUT_MS);
    await waitForPgReady(databaseUrl);
    await waitForTcpService("127.0.0.1", dsPort, "durable-streams", SERVICE_START_TIMEOUT_MS);

    // BEFORE the engine wait, deliberately: the engine exits when its declared tables are absent, and
    // its compose `restart: unless-stopped` is the retry. Migrating first is what lets that retry succeed.
    runCommand("bun", ["run", "db:migrate"], testEnv);
    await waitForTcpService("127.0.0.1", enginePort, "circuits-engine", SERVICE_START_TIMEOUT_MS);

    for (const testFile of testFiles) {
      runCommand("bun", ["test", "--bail", testFile], testEnv);
    }
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
