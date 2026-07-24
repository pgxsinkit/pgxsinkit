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
  "boot-report",
  "client-boot-optimizations",
  "client-lazy-facade",
  "client-live-hydration",
  "worker-live-hydration",
  "worker-live-dedup-hydration",
  "worker-live-lifecycle",
  "worker-one-shot-reads",
  "client-sync-reset",
  "write-activation-diagnostic",
  "staged-boot-readiness",
  "perf-lab-pglite",
  "pglite-opfs-repacked-factory-host-reject",
  "pglite-opfs-repacked-factory-init-reject",
  "pglite-opfs-repacked-factory-poison",
  "pglite-opfs-repacked-factory-sync",
  "sync-engine",
  "sync-commit-queue",
  "sync-expired-handle-recovery",
  "sync-metadata-init-race",
  "sync-mid-commit-reset",
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
  "sync-apply": 1,
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

const normalize = (arg: string) => arg.replace(/^tests\/unit\//, "").replace(/\.test\.ts$/, "");

// Per-shard outcome for the selection layer's priming invariant: a file may be recorded green ONLY
// when it ran in full inside a shard that exited 0 (see scripts/select-unit-tests.ts).
export interface ShardOutcome {
  files: string[];
  exitCode: number;
}

// Shard and run the given unit-test files across the worker pool, returning each shard's whole-file
// list and exit code. This is the raw sharder: it writes NO cache/registry entries — every cache write
// lives in the selection layer, so a subset run here can never certify a file.
export async function runUnitTests(requested: string[]): Promise<ShardOutcome[]> {
  const files = requested.map(normalize);
  if (files.length === 0) return [];

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

  return results.map((r) => ({ files: r.files, exitCode: r.code }));
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const files =
    requested.length > 0
      ? requested
      : readdirSync("tests/unit")
          .filter((f) => f.endsWith(".test.ts"))
          .map((f) => f.replace(/\.test\.ts$/, ""));

  const outcomes = await runUnitTests(files);
  process.exit(outcomes.some((o) => o.exitCode !== 0) ? 1 : 0);
}
