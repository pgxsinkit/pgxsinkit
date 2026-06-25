#!/usr/bin/env node
// Portable launcher for `pgxsinkit-generate`.
//
// The real CLI is TypeScript and is Bun-required by nature: it dynamically imports your (TypeScript)
// sync registry and shells out to `drizzle-kit` via Bun. A built JS bin would not change that, so
// instead of pretending to be a Node tool this launcher runs under Node *or* Bun, locates Bun on PATH,
// and re-execs the CLI there — turning a missing-Bun setup into a clear, actionable message rather than
// a cryptic shebang failure (`env: bun: No such file or directory`).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli/generate.ts");
const result = spawnSync("bun", [cli, ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error?.code === "ENOENT") {
  process.stderr.write(
    "pgxsinkit-generate requires Bun (https://bun.sh): it imports your TypeScript sync registry and runs\n" +
      "drizzle-kit. Install Bun, then run it via `bunx pgxsinkit-generate` — or any package manager's exec\n" +
      "(npx / pnpm exec / yarn) once Bun is on PATH.\n",
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
