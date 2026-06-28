import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";

// Run the unit suite across multiple `bun test` PROCESSES so it uses more than one core.
//
// `bun test` runs the files it is given sequentially in ONE process, and a file-to-file shared process
// also bleeds state — the mock.module / globalThis mocks a few suites install are process-global. So we
// shard the files into independent `bun test` invocations and run them in a worker pool of size
// NB_CPUS/2 (override with PGXSINKIT_TEST_CONCURRENCY). Files that mock a process-global module must run
// alone, so each gets its own single-file shard; the rest are bin-packed (longest-first) into one shard
// per worker to amortize the per-process boot. The global PGlite cleanup (bunfig preload →
// tests/support/setup.ts) keeps each shard's process flat regardless of how many files it holds.

// Suites that call `mock.module` (process-global) — must each run in their own process.
const ISOLATED = new Set([
  "client-lazy-facade",
  "client-sync-reset",
  "perf-lab-pglite",
  "pglite-sync-upstream",
  "sync-commit-queue",
]);

// Rough per-file cost (seconds) for balancing the bins; unlisted files default to 1. Only affects how
// evenly work is spread, never correctness.
const WEIGHT: Record<string, number> = {
  "overlay-state": 12,
  copy: 10,
  "plpgsql-apply": 5,
  "convergence-model": 4,
  "local-store": 4,
  "mutation-quarantine": 4,
  "flush-serialization": 3,
  "conflict-handling": 2.5,
  "conflict-base-capture": 2.5,
  "bulk-apply": 1,
  "client-schema": 1,
  "apply-ladder": 1,
  "pglite-sync-apply": 1,
};

const concurrency = Math.max(
  1,
  Number(process.env["PGXSINKIT_TEST_CONCURRENCY"]) || Math.floor(availableParallelism() / 2),
);

const weightOf = (file: string) => WEIGHT[file] ?? 1;
const shardCost = (files: string[]) => files.reduce((sum, f) => sum + weightOf(f), 0);

function buildShards(files: string[]): string[][] {
  const isolated = files.filter((f) => ISOLATED.has(f)).map((f) => [f]);
  const rest = files.filter((f) => !ISOLATED.has(f)).sort((a, b) => weightOf(b) - weightOf(a));

  // Spread the bulk across more bins than workers so the pool (and the single-file isolated shards)
  // stays evenly loaded with smaller, balanceable chunks — longest-processing-time bin-packing.
  const binCount = Math.max(1, Math.min(rest.length, 2 * concurrency));
  const bins: string[][] = Array.from({ length: binCount }, () => []);
  for (const file of rest) {
    bins.sort((a, b) => shardCost(a) - shardCost(b))[0]!.push(file);
  }

  return [...isolated, ...bins.filter((b) => b.length > 0)].sort((a, b) => shardCost(b) - shardCost(a));
}

interface ShardResult {
  files: string[];
  code: number;
  pass: number;
  fail: number;
  output: string;
  ms: number;
}

function runShard(files: string[]): Promise<ShardResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bun", ["test", "--timeout", "30000", ...files.map((f) => `tests/unit/${f}.test.ts`)], {
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => {
      const pass = [...output.matchAll(/^\s*(\d+)\s+pass$/gm)].reduce((s, m) => s + Number(m[1]), 0);
      const fail = [...output.matchAll(/^\s*(\d+)\s+fail$/gm)].reduce((s, m) => s + Number(m[1]), 0);
      resolve({ files, code: code ?? 1, pass, fail, output, ms: Date.now() - startedAt });
    });
  });
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).map((a) => a.replace(/^tests\/unit\//, "").replace(/\.test\.ts$/, ""));
  const files =
    requested.length > 0
      ? requested
      : readdirSync("tests/unit")
          .filter((f) => f.endsWith(".test.ts"))
          .map((f) => f.replace(/\.test\.ts$/, ""));

  const shards = buildShards(files);
  const startedAt = Date.now();
  console.log(`[unit] ${files.length} files in ${shards.length} shards across ${concurrency} workers`);

  let next = 0;
  const results: ShardResult[] = [];
  const worker = async () => {
    while (next < shards.length) {
      const shard = shards[next++]!;
      const result = await runShard(shard);
      results.push(result);
      const tag = result.code === 0 ? "ok " : "FAIL";
      const label = shard.length === 1 ? shard[0] : `${shard.length} files`;
      console.log(
        `[unit] ${tag} ${result.pass} pass${result.fail ? ` ${result.fail} fail` : ""}  ${(result.ms / 1000).toFixed(1)}s  (${label})`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, shards.length) }, worker));

  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.error(`\n──── FAILED shard: ${r.files.join(", ")} ────\n${r.output}`);
  }
  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  console.log(`\n[unit] ${totalPass} pass, ${totalFail} fail in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
