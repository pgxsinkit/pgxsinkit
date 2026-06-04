import { spawnSync } from "node:child_process";
import net from "node:net";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

// ─── Port helpers ─────────────────────────────────────────────────────────────

export async function allocatePort(): Promise<number> {
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

// ─── TCP connectivity ─────────────────────────────────────────────────────────

export async function canConnect(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
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

export async function waitForTcpService(
  host: string,
  port: number,
  label: string,
  timeoutMs = 120_000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await canConnect(host, port)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label} at ${host}:${port}`);
}

// ─── PostgreSQL readiness ─────────────────────────────────────────────────────

export async function waitForPgReady(databaseUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  const db = drizzle(databaseUrl);

  try {
    while (Date.now() - start < timeoutMs) {
      try {
        await db.execute(sql`SELECT 1`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error("Timed out waiting for PostgreSQL to accept queries");
  } finally {
    await (db as any).$client?.close();
  }
}

// ─── Podman compose down ──────────────────────────────────────────────────────

const COMPOSE_FILE = "infra/compose/docker-compose.yml";

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

  return { filtered: kept.join("\n"), suppressedKnownNoise };
}

export function runComposeDown(env: NodeJS.ProcessEnv, composeProject: string, label: string): void {
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
    console.warn(`[${label}] Ignored known Podman rootless netns cleanup warning.`);
  }

  if (result.status !== 0 && !(sanitized.suppressedKnownNoise && sanitized.filtered.length === 0)) {
    throw new Error(
      `Command failed: podman compose -f ${COMPOSE_FILE} -p ${composeProject} down --volumes --remove-orphans`,
    );
  }
}
