import { spawnSync } from "node:child_process";

const COMPOSE_FILE = "infra/compose/docker-compose.yml";

function sanitizeStderr(stderr: string): { filtered: string; suppressedKnownNoise: boolean } {
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

function main() {
  const result = spawnSync("podman", ["compose", "-f", COMPOSE_FILE, "down", "--volumes", "--remove-orphans"], {
    env: process.env,
    encoding: "utf8",
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  const stderr = result.stderr ?? "";
  const sanitized = sanitizeStderr(stderr);

  if (sanitized.filtered.length > 0) {
    process.stderr.write(`${sanitized.filtered}\n`);
  }

  if (sanitized.suppressedKnownNoise) {
    console.warn("[infra:down] Ignored known Podman rootless netns cleanup warning.");
  }

  if (result.status !== 0) {
    if (sanitized.suppressedKnownNoise && sanitized.filtered.length === 0) {
      return;
    }

    throw new Error(`infra:down failed with exit code ${result.status ?? 1}`);
  }
}

main();
