import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { composeCredentials } from "../infra/compose-credentials";

const COMPOSE_FILE = "infra/compose/docker-compose.yml";
const SERVICE_START_TIMEOUT_MS = 180_000;
const SERVICE_POLL_INTERVAL_MS = 500;
const PERF_RESULTS_DIR = "tmp/perf-results";
const PERF_COMPOSE_PROJECT = "pgxsinkit-performance-suite";
const WORKSPACE_ROOT = process.cwd();
const WORKSPACE_TMP_DIR = path.join(WORKSPACE_ROOT, "tmp");
const PERF_RUNNER_PID_FILE = path.join(WORKSPACE_TMP_DIR, "performance-runner.pid");
const PERF_CONCURRENT_DATA_DIR_PREFIX = "pgxsinkit-perf-concurrent-";

let activeChild: ChildProcess | null = null;
let cleanupPromise: Promise<void> | null = null;
let cleanupEnv: NodeJS.ProcessEnv | null = null;
let shuttingDown = false;

function assertTestFiles(args: string[]): string[] {
  const testFiles = args.filter((arg) => arg.endsWith(".test.ts"));

  if (testFiles.length === 0) {
    throw new Error("No performance test files provided. Pass one or more *.test.ts paths.");
  }

  return testFiles;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  allowFailure = false,
): Promise<void> {
  if (shuttingDown) {
    throw new Error("Performance suite is shutting down.");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WORKSPACE_ROOT,
      env,
      stdio: "inherit",
    });

    activeChild = child;

    child.once("error", (error) => {
      if (activeChild === child) {
        activeChild = null;
      }

      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (activeChild === child) {
        activeChild = null;
      }

      if (code === 0 || allowFailure) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Command failed: ${command} ${args.join(" ")}${signal ? ` (signal: ${signal})` : ""}${typeof code === "number" ? ` (exit code: ${code})` : ""}`,
        ),
      );
    });
  });
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate ephemeral port.")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function canConnect(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });

    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForTcpService(host: string, port: number, label: string): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < SERVICE_START_TIMEOUT_MS) {
    if (await canConnect(host, port)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, SERVICE_POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ${label} at ${host}:${port}`);
}

function buildProjectName(): string {
  return PERF_COMPOSE_PROJECT;
}

async function main() {
  const testFiles = assertTestFiles(process.argv.slice(2));
  await acquireRunnerLease();
  registerSignalHandlers();

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
  cleanupEnv = composeEnv;

  const databaseUrl = composeCredentials.buildLocalDatabaseUrl("127.0.0.1", postgresPort);
  const electricUrl = `http://127.0.0.1:${electricPort}/v1/shape`;
  const testEnv: NodeJS.ProcessEnv = {
    ...composeEnv,
    DATABASE_URL: databaseUrl,
    ELECTRIC_URL: electricUrl,
    PGXSINKIT_PERF_RESULTS_DIR: process.env.PGXSINKIT_PERF_RESULTS_DIR ?? PERF_RESULTS_DIR,
  };

  let suiteError: unknown;

  console.log("[performance] Resetting previous performance-suite state", {
    composeProject,
  });

  console.log("[performance] Launching isolated containers", {
    composeProject,
    postgresPort,
    electricPort,
  });

  try {
    await cleanupPerformanceState();
    await runCommand("podman", ["compose", "-f", COMPOSE_FILE, "-p", composeProject, "up", "-d"], composeEnv);

    await waitForTcpService("127.0.0.1", postgresPort, "PostgreSQL");
    await waitForTcpService("127.0.0.1", electricPort, "ElectricSQL");

    await runCommand("bun", ["run", "db:migrate"], testEnv);
    await runCommand("bun", ["run", "vitest", "run", "--no-file-parallelism", ...testFiles], testEnv);
  } catch (error) {
    suiteError = error;
  } finally {
    await cleanupPerformanceState();
  }

  if (suiteError) {
    throw suiteError;
  }
}

async function acquireRunnerLease() {
  await mkdir(WORKSPACE_TMP_DIR, { recursive: true });

  const existingPid = await readPidFile(PERF_RUNNER_PID_FILE);

  if (existingPid !== null && existingPid !== process.pid && (await isPidAlive(existingPid))) {
    const commandLine = await readProcessCommandLine(existingPid);

    if (commandLine.includes("run-performance-suite.ts")) {
      throw new Error(
        `Another performance suite is already running with pid ${existingPid}. Stop it before starting a new performance run.`,
      );
    }
  }

  await writeFile(PERF_RUNNER_PID_FILE, `${process.pid}\n`, "utf8");
}

function registerSignalHandlers() {
  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
}

async function handleSignal(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  try {
    await cleanupPerformanceState();
  } finally {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}

async function cleanupPerformanceState() {
  cleanupPromise ??= (async () => {
    if (activeChild?.pid) {
      await terminatePid(activeChild.pid);
      activeChild = null;
    }

    if (cleanupEnv) {
      console.log("[performance] Tearing down isolated containers", { composeProject: PERF_COMPOSE_PROJECT });
      await runCommand(
        "podman",
        ["compose", "-f", COMPOSE_FILE, "-p", PERF_COMPOSE_PROJECT, "down", "--volumes", "--remove-orphans"],
        cleanupEnv,
        true,
      );
    }

    await cleanupConcurrentDataDirs();
    await safeRemove(PERF_RUNNER_PID_FILE);
  })().finally(() => {
    cleanupPromise = null;
  });

  await cleanupPromise;
}

async function cleanupConcurrentDataDirs() {
  await mkdir(WORKSPACE_TMP_DIR, { recursive: true });

  const entries = await readdir(WORKSPACE_TMP_DIR, { withFileTypes: true });
  const staleDirs = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(PERF_CONCURRENT_DATA_DIR_PREFIX),
  );

  if (staleDirs.length === 0) {
    return;
  }

  console.log("[performance] Removing stale concurrent perf data dirs", {
    count: staleDirs.length,
  });

  await Promise.all(
    staleDirs.map((entry) => rm(path.join(WORKSPACE_TMP_DIR, entry.name), { recursive: true, force: true })),
  );
}

async function terminatePid(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (!(await isPidAlive(pid))) {
      return;
    }

    await delay(200);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore races with already-exited processes.
  }
}

async function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(filePath: string) {
  try {
    const raw = await readFile(filePath, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readProcessCommandLine(pid: number) {
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.split("\0").join(" ");
  } catch {
    return "";
  }
}

async function safeRemove(filePath: string) {
  await rm(filePath, { force: true });
}

async function delay(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

try {
  await main();
} finally {
  await cleanupPerformanceState();
}
