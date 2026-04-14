import { spawnSync } from "node:child_process";
import net from "node:net";

const COMPOSE_FILE = "infra/compose/docker-compose.yml";
const SERVICE_START_TIMEOUT_MS = 60_000;
const SERVICE_POLL_INTERVAL_MS = 500;

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

function sanitizeComposeDownStderr(stderr: string): { filtered: string; suppressedKnownNoise: boolean } {
  const lines = stderr.split(/\r?\n/);
  const kept: string[] = [];
  let suppressedKnownNoise = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.includes("network: 1 error occurred:") && line.includes("Error: removing container")) {
      suppressedKnownNoise = true;
      continue;
    }

    if (line.includes("rootless netns: kill network process: permission denied")) {
      suppressedKnownNoise = true;
      continue;
    }

    if (trimmed.length === 0) {
      continue;
    }

    kept.push(line);
  }

  return {
    filtered: kept.join("\n"),
    suppressedKnownNoise,
  };
}

function runComposeDown(env: NodeJS.ProcessEnv, composeProject: string): void {
  const result = spawnSync(
    "podman",
    ["compose", "-f", COMPOSE_FILE, "-p", composeProject, "down", "--volumes", "--remove-orphans"],
    {
      env,
      encoding: "utf8",
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  const sanitized = sanitizeComposeDownStderr(result.stderr ?? "");

  if (sanitized.filtered.length > 0) {
    process.stderr.write(`${sanitized.filtered}\n`);
  }

  if (sanitized.suppressedKnownNoise) {
    console.warn("[integration] Ignored known Podman rootless netns cleanup warning.");
  }

  if (result.status !== 0 && !(sanitized.suppressedKnownNoise && sanitized.filtered.length === 0)) {
    throw new Error(
      `Command failed: podman compose -f ${COMPOSE_FILE} -p ${composeProject} down --volumes --remove-orphans`,
    );
  }
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
    PGXSINKIT_POSTGRES_PORT: String(postgresPort),
    PGXSINKIT_ELECTRIC_PORT: String(electricPort),
  };

  const databaseUrl = `postgresql://postgres:password@127.0.0.1:${postgresPort}/pgxsinkit?sslmode=disable`;
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

    await waitForTcpService("127.0.0.1", postgresPort, "PostgreSQL");
    await waitForTcpService("127.0.0.1", electricPort, "ElectricSQL");

    runCommand("bun", ["run", "db:push"], testEnv);
    runCommand("bun", ["run", "vitest", "run", "--no-file-parallelism", ...testFiles], testEnv);
  } catch (error) {
    suiteError = error;
  } finally {
    if (composeStarted) {
      try {
        console.log("[integration] Tearing down isolated containers", { composeProject });
        runComposeDown(composeEnv, composeProject);
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
