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
    await db.$client.close();
  }
}

// Poll an HTTP endpoint until it answers with any non-5xx status — "the service is accepting
// requests", not "the request succeeded" (a 401/404 still proves the service is up). Used to wait for
// GoTrue through the gateway before seeding, since a healthy DB + open Kong port does not mean GoTrue
// has finished booting its own auth-schema migrations.
export async function waitForHttpOk(url: string, name: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${name} (${url}) to answer`);
}

// ─── Podman compose down ──────────────────────────────────────────────────────

const COMPOSE_FILE = "infra/compose/docker-compose.yml";

function sanitizeComposeDownStderr(stderr: string): { filtered: string; suppressedKnownNoise: boolean } {
  const lines = stderr.split(/\r?\n/);
  const kept: string[] = [];
  let suppressedKnownNoise = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.includes("network: 1 error occurred:") && line.includes("removing container")) {
      suppressedKnownNoise = true;
      continue;
    }

    if (line.includes("rootless netns: kill network process: permission denied")) {
      suppressedKnownNoise = true;
      continue;
    }

    // Compose progress lines ("Container x  Stopping/Error while Stopping/…")
    // are status output, not an error signal.
    if (/^\s*Container\s\S+\s{2}/.test(line)) {
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

  // Rootless podman intermittently fails `compose down` while removing the
  // container network even though every resource can be removed individually.
  // What matters is the end state, not the exit code: force-remove anything the
  // project left behind and fail only if resources truly persist.
  if (result.status !== 0) {
    console.warn(`[${label}] compose down exited non-zero; forcing removal of leftover compose resources.`);
    forceRemoveComposeResources(composeProject);
  }

  assertComposeResourcesRemoved(composeProject);
}

function listComposeResources(composeProject: string, kind: "container" | "network" | "volume"): string[] {
  const args =
    kind === "container"
      ? ["ps", "-a", "--filter", `name=${composeProject}`, "--format", "{{.ID}}"]
      : kind === "network"
        ? ["network", "ls", "--filter", `name=${composeProject}`, "--format", "{{.Name}}"]
        : ["volume", "ls", "--filter", `name=${composeProject}`, "--format", "{{.Name}}"];
  const result = spawnSync("podman", args, { encoding: "utf8" });

  if (result.error || result.status !== 0) {
    throw new Error(`Unable to list compose ${kind}s for project ${composeProject}.`);
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function forceRemoveComposeResources(composeProject: string): void {
  for (const containerId of listComposeResources(composeProject, "container")) {
    spawnSync("podman", ["rm", "-f", containerId], { encoding: "utf8" });
  }

  for (const networkName of listComposeResources(composeProject, "network")) {
    spawnSync("podman", ["network", "rm", "-f", networkName], { encoding: "utf8" });
  }

  for (const volumeName of listComposeResources(composeProject, "volume")) {
    spawnSync("podman", ["volume", "rm", "-f", volumeName], { encoding: "utf8" });
  }
}

function assertComposeResourcesRemoved(composeProject: string): void {
  const containerIds = listComposeResources(composeProject, "container");
  const networkNames = listComposeResources(composeProject, "network");

  if (containerIds.length > 0 || networkNames.length > 0) {
    throw new Error(
      `Compose cleanup left resources behind for project ${composeProject}: containers=${containerIds.length}, networks=${networkNames.length}`,
    );
  }
}
