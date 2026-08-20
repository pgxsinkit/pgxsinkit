import { spawnSync } from "node:child_process";

// `infra:circuits:down` — tear the native substrate down, volumes included. The integration lane
// replays from Postgres on every run, so nothing here is worth keeping between runs, and a stale ds
// volume would serve a previous run's streams to the next one.
const result = spawnSync("podman", ["compose", "-f", "infra/compose/circuits-compose.yml", "down", "-v"], {
  env: process.env,
  stdio: "inherit",
});

if (result.status !== 0) {
  throw new Error("podman compose down failed");
}
