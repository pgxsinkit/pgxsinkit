import { spawnSync } from "node:child_process";

// `infra:down` — tears the board demo stack down, removing its volumes so the next `infra:up` starts
// from a clean database (the seed is deterministic, so a fresh DB is the intended default). The
// minimal harness stack is torn down separately via `infra:harness:down`.

const COMPOSE_FILE = "infra/compose/board-compose.yml";
const ENV_FILE = "infra/compose/board.env";

const result = spawnSync(
  "podman",
  ["compose", "-f", COMPOSE_FILE, "--env-file", ENV_FILE, "down", "--volumes", "--remove-orphans"],
  { env: process.env, stdio: "inherit" },
);

process.exit(result.status ?? 0);
