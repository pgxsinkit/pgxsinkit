import { spawnSync } from "node:child_process";
import net from "node:net";

type ServiceCheck = {
  label: string;
  host: string;
  port: number;
};

const COMPOSE_FILE = "infra/compose/docker-compose.yml";
const DEFAULT_DATABASE_URL = "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable";
const DEFAULT_ELECTRIC_URL = "http://localhost:3000/v1/shape";

function parsePort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
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

async function canConnect(service: ServiceCheck, timeoutMs = 1200): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: service.host, port: service.port });

    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForServices(services: ServiceCheck[], timeoutMs = 30_000, intervalMs = 500): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const checks = await Promise.all(services.map(async (service) => ({ service, ok: await canConnect(service) })));
    const missing = checks.filter((check) => !check.ok).map((check) => check.service);

    if (missing.length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for infra services to become reachable.");
}

async function main() {
  const env = process.env;
  const databaseUrl = new URL(env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const electricUrl = new URL(env.ELECTRIC_URL ?? DEFAULT_ELECTRIC_URL);

  const services: ServiceCheck[] = [
    {
      label: "PostgreSQL",
      host: databaseUrl.hostname,
      port: parsePort(databaseUrl),
    },
    {
      label: "ElectricSQL",
      host: electricUrl.hostname,
      port: parsePort(electricUrl),
    },
  ];

  runCommand("podman", ["compose", "-f", COMPOSE_FILE, "up", "-d"], env);
  await waitForServices(services);
  runCommand("bun", ["run", "db:push"], env);
  runCommand("bun", ["run", "db:apply:governance"], env);
  runCommand("bun", ["run", "db:apply:sync-function"], env);
  runCommand("bun", ["run", "db:verify:sync-function"], env);
}

await main();
