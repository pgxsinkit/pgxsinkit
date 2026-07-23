import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  PERF_LAB_COMPOSE_PROJECT,
  PERF_LAB_DATABASE_URL,
  PERF_LAB_ELECTRIC_PORT,
  PERF_LAB_ELECTRIC_URL,
  PERF_LAB_HOST,
  PERF_LAB_LOG_DIR,
  PERF_LAB_POSTGRES_PORT,
  PERF_LAB_SHAPE_PROXY_URL,
  PERF_LAB_VITE_PORT,
  PERF_LAB_WRITE_API_PORT,
  PERF_LAB_WRITE_API_URL,
} from "./perf-lab-config";

const composeFile = "infra/compose/docker-compose.yml";
const workspaceRoot = process.cwd();
const pidFiles = {
  supervisor: path.join(workspaceRoot, PERF_LAB_LOG_DIR, "supervisor.pid"),
  server: path.join(workspaceRoot, PERF_LAB_LOG_DIR, "write-server.pid"),
  vite: path.join(workspaceRoot, PERF_LAB_LOG_DIR, "vite.pid"),
};
const logFiles = {
  server: path.join(workspaceRoot, PERF_LAB_LOG_DIR, "write-server.log"),
  vite: path.join(workspaceRoot, PERF_LAB_LOG_DIR, "vite.log"),
};

let serverProcess: ReturnType<typeof spawn> | null = null;
let viteProcess: ReturnType<typeof spawn> | null = null;
let shuttingDown = false;

await mkdir(path.join(workspaceRoot, PERF_LAB_LOG_DIR), { recursive: true });
await cleanupPreviousPerfLabRun();
await writeFile(pidFiles.supervisor, `${process.pid}\n`, "utf8");

const perfEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: PERF_LAB_DATABASE_URL,
  ELECTRIC_URL: PERF_LAB_ELECTRIC_URL,
  PGXSINKIT_POSTGRES_PORT: `${PERF_LAB_POSTGRES_PORT}`,
  PGXSINKIT_ELECTRIC_PORT: `${PERF_LAB_ELECTRIC_PORT}`,
};

runCommand(
  "podman",
  ["compose", "-f", composeFile, "-p", PERF_LAB_COMPOSE_PROJECT, "down", "--volumes", "--remove-orphans"],
  perfEnv,
  true,
);
runCommand("podman", ["compose", "-f", composeFile, "-p", PERF_LAB_COMPOSE_PROJECT, "up", "-d"], perfEnv);

await waitForPort(PERF_LAB_HOST, PERF_LAB_POSTGRES_PORT, "PostgreSQL");
await waitForPort(PERF_LAB_HOST, PERF_LAB_ELECTRIC_PORT, "ElectricSQL");
await waitForHttp(`http://${PERF_LAB_HOST}:${PERF_LAB_ELECTRIC_PORT}`, "ElectricSQL");

serverProcess = startChildProcess(
  ["bun", "scripts/perf-lab-server.ts"],
  {
    ...perfEnv,
    WRITE_API_HOST: PERF_LAB_HOST,
    WRITE_API_PORT: `${PERF_LAB_WRITE_API_PORT}`,
  },
  logFiles.server,
  pidFiles.server,
  "perf-lab-server",
);

await waitForHttp(`${PERF_LAB_WRITE_API_URL}/health`, "perf-lab write server", serverProcess);

viteProcess = startChildProcess(
  ["bun", "run", "dev", "--host", PERF_LAB_HOST, "--port", `${PERF_LAB_VITE_PORT}`, "--strictPort"],
  {
    ...perfEnv,
    VITE_WRITE_API_ORIGIN: PERF_LAB_WRITE_API_URL,
    VITE_ELECTRIC_URL: PERF_LAB_SHAPE_PROXY_URL,
    VITE_PGXSINKIT_PERF_MUTATION_BATCH_SIZE: process.env["PGXSINKIT_PERF_MUTATION_BATCH_SIZE"],
  },
  logFiles.vite,
  pidFiles.vite,
  "perf-lab-vite",
  path.join(workspaceRoot, "apps/perf-lab"),
);

await waitForHttp(`http://${PERF_LAB_HOST}:${PERF_LAB_VITE_PORT}`, "perf-lab vite server", viteProcess);

console.log(`Perf lab ready on http://${PERF_LAB_HOST}:${PERF_LAB_VITE_PORT}`);
console.log(`Perf-lab logs: ${PERF_LAB_LOG_DIR}`);

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

try {
  await waitForChildExit(viteProcess!, "perf-lab vite server");
} catch (error) {
  if (!shuttingDown) {
    throw error;
  }
} finally {
  await shutdown();
}

async function cleanupPreviousPerfLabRun() {
  await killPidFileProcess(pidFiles.vite, "bun run dev --host");
  await killPidFileProcess(pidFiles.server, "perf-lab-server.ts");
  await killPidFileProcess(pidFiles.supervisor, "run-perf-lab.ts", true);
}

async function killPidFileProcess(pidFile: string, commandFragment: string, skipCurrent = false) {
  const pid = await readPidFile(pidFile);

  if (pid === null || (skipCurrent && pid === process.pid)) {
    await safeRemove(pidFile);
    return;
  }

  const commandLine = await readProcessCommandLine(pid);

  if (!commandLine.includes(commandFragment)) {
    await safeRemove(pidFile);
    return;
  }

  await terminatePid(pid);
  await safeRemove(pidFile);
}

function startChildProcess(
  command: string[],
  env: NodeJS.ProcessEnv,
  logFilePath: string,
  pidFilePath: string,
  label: string,
  cwd = workspaceRoot,
) {
  const [executable, ...args] = command;

  if (!executable) {
    throw new Error(`Missing executable for ${label}`);
  }

  const logStream = createWriteStream(logFilePath, { flags: "w" });
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
    logStream.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
    logStream.write(chunk);
  });
  child.on("exit", () => {
    logStream.end();
    void safeRemove(pidFilePath);
  });

  void writeFile(pidFilePath, `${child.pid ?? ""}\n`, "utf8");
  return child;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
  });

  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function waitForPort(host: string, port: number, label: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(1_000);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });

    if (connected) {
      return;
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${label} on ${host}:${port}`);
}

async function waitForHttp(url: string, label: string, child?: ReturnType<typeof spawn> | null) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    if (child && child.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready.`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the service becomes reachable.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string) {
  await new Promise<void>((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (shuttingDown && (code === 143 || code === null || signal === "SIGTERM" || signal === "SIGINT")) {
        resolve();
        return;
      }

      reject(new Error(`${label} exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`));
    });
    child.once("error", reject);
  });
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (viteProcess?.pid) {
    await terminatePid(viteProcess.pid);
  }

  if (serverProcess?.pid) {
    await terminatePid(serverProcess.pid);
  }

  await safeRemove(pidFiles.vite);
  await safeRemove(pidFiles.server);
  await safeRemove(pidFiles.supervisor);

  runCommand(
    "podman",
    ["compose", "-f", composeFile, "-p", PERF_LAB_COMPOSE_PROJECT, "down", "--volumes", "--remove-orphans"],
    perfEnv,
    true,
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
