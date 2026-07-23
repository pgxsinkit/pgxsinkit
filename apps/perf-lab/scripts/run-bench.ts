import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, type Browser, type BrowserType } from "@playwright/test";

import { BATTERIES, type BatteryResult, type BatteryStep, type BenchResults } from "../src/bench/protocol";

// `bench:storage` — the storage benchmark runner. Builds the perf-lab (both MPA entries), serves the built
// output with `vite preview` on a fixed port, then drives `bench.html?auto=1` under Playwright on every
// locally available engine, waits for the automation hook (`window.__benchResults`), and prints the results
// JSON plus a compact per-battery table per engine.
//
// CLI (all optional): --batteries=big-read,bulk-write (default: all) · --backends=idb,opfs-ahp
// (default: all) · --strict (run non-matrix batteries under strict durability).
//
// MANUAL/local by design: Chromium always runs; Firefox runs only if its Playwright browser is installed
// (probed, skipped gracefully otherwise). WebKit's numbers come from the real-device page, not here.

const PREVIEW_PORT = 4188;
const PREVIEW_HOST = "127.0.0.1";
const RESULTS_TIMEOUT_MS = 600_000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const perfLabDir = path.resolve(scriptDir, "..");

// ---- CLI parsing ----

function argValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const batteriesArg = argValue("batteries");
// Default to ALL backends EXPLICITLY: a bare `?auto=1` follows the page's engine-aware defaults, which
// untick `opfs-ahp` off Firefox (it wedges headed browsers at store open — field evidence). The
// headless driver is where `opfs-ahp` runs fine and its column is wanted, so it must opt in by name.
const backendsArg = argValue("backends") ?? "idb,opfs-ahp,opfs-repacked";
const strictArg = process.argv.includes("--strict");
const repackedExtentSizeArg = argValue("repacked-extent-size") ?? "65536";
if (repackedExtentSizeArg !== "8192" && repackedExtentSizeArg !== "65536") {
  throw new TypeError("--repacked-extent-size must be 8192 or 65536");
}

function buildUrl(): string {
  const query = new URLSearchParams({ auto: "1" });
  if (batteriesArg) query.set("batteries", batteriesArg);
  query.set("backends", backendsArg);
  query.set("repackedExtentSize", repackedExtentSizeArg);
  if (strictArg) query.set("strict", "1");
  return `http://${PREVIEW_HOST}:${PREVIEW_PORT}/bench.html?${query.toString()}`;
}

const BENCH_URL = buildUrl();

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: perfLabDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url: string, label: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the preview server answers.
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

// Firefox's Playwright browser may not be installed; probe its executable and skip gracefully if absent.
function browserIsAvailable(browserType: BrowserType): boolean {
  try {
    return existsSync(browserType.executablePath());
  } catch {
    return false;
  }
}

async function driveEngine(name: string, browserType: BrowserType): Promise<BenchResults> {
  let browser: Browser | undefined;
  try {
    // --headed: launch a visible browser. The bench behaves differently headed vs headless in the field
    // (memory pressure, real profiles), so freezes must be reproducible in the same mode they were seen in.
    browser = await browserType.launch({ headless: !process.argv.includes("--headed") });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(BENCH_URL, { waitUntil: "load" });
    // `window.__benchResults` is the harness's automation hook (set by src/bench/main.ts once the suite
    // completes). Accessed with a local cast so this runner needs no ambient DOM augmentation.
    await page.waitForFunction(
      () => (globalThis as unknown as { __benchResults?: unknown }).__benchResults !== undefined,
      undefined,
      { timeout: RESULTS_TIMEOUT_MS },
    );
    const results = (await page.evaluate(
      () => (globalThis as unknown as { __benchResults?: unknown }).__benchResults,
    )) as BenchResults;
    if (consoleErrors.length > 0) {
      console.warn(`[${name}] page console errors:\n  ${consoleErrors.join("\n  ")}`);
    }
    return results;
  } finally {
    await browser?.close();
  }
}

// ---- printing ----

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function formatStep(step: BatteryStep): string {
  if (step.unavailable) return `unavailable — ${step.unavailable}`;
  const parts = [`total=${padLeft(step.totalMs.toFixed(1), 9)}ms`];
  if (step.opsPerSec !== undefined && step.opsPerSec > 0) parts.push(`${padLeft(String(step.opsPerSec), 8)} ops/s`);
  if (step.stats) {
    parts.push(`mean=${padLeft(step.stats.meanMs.toFixed(3), 8)}ms p95=${padLeft(step.stats.p95Ms.toFixed(3), 8)}ms`);
  }
  if (step.rowsTouched !== undefined) parts.push(`${padLeft(String(step.rowsTouched), 6)} rows`);
  return parts.join("  ");
}

function printBattery(battery: BatteryResult): void {
  console.log(`\n  ── ${battery.title} ──`);
  for (const backend of battery.backends) {
    if (backend.unavailable) {
      console.log(`    ${pad(backend.backend, 12)} unavailable — ${backend.unavailable}`);
      continue;
    }
    const build = backend.buildMs !== undefined ? ` (build ${backend.buildMs.toFixed(0)}ms)` : "";
    console.log(`    ${pad(backend.backend, 12)}${build}`);
    for (const step of backend.steps) {
      console.log(`      ${pad(step.label, 42)} ${formatStep(step)}`);
    }
  }
}

function printResults(name: string, results: BenchResults): void {
  console.log(`\n=== ${name} — ${results.engine} — ${results.userAgent} ===`);
  console.log(
    `durability(non-matrix): ${results.strict ? "strict" : "relaxed"} · backends: ${results.backends.join(", ")}`,
  );
  for (const battery of results.batteries) {
    printBattery(battery);
  }
  if (results.fatalError) {
    console.log(`\n  fatal: ${results.fatalError}`);
  }
}

async function main(): Promise<void> {
  const selected = batteriesArg ?? "all";
  console.log(
    `[bench:storage] batteries=${selected} backends=${backendsArg ?? "all"} strict=${strictArg} ` +
      `repackedExtentSize=${repackedExtentSizeArg}`,
  );
  console.log(`[bench:storage] known batteries: ${BATTERIES.map((b) => b.id).join(", ")}`);
  console.log("[bench:storage] building perf-lab…");
  run("bun", ["run", "build"]);

  console.log("[bench:storage] starting vite preview…");
  const preview = spawn(
    "bunx",
    ["vite", "preview", "--host", PREVIEW_HOST, "--port", String(PREVIEW_PORT), "--strictPort"],
    { cwd: perfLabDir, stdio: ["ignore", "inherit", "inherit"] },
  );

  const engines: Array<{ name: string; type: BrowserType }> = [{ name: "chromium", type: chromium }];
  if (browserIsAvailable(firefox)) {
    engines.push({ name: "firefox", type: firefox });
  } else {
    console.log("[bench:storage] firefox browser not installed — skipping.");
  }

  const all: Record<string, BenchResults> = {};
  try {
    await waitForHttp(`http://${PREVIEW_HOST}:${PREVIEW_PORT}/bench.html`, "vite preview");
    for (const engine of engines) {
      console.log(`[bench:storage] running on ${engine.name}…`);
      all[engine.name] = await driveEngine(engine.name, engine.type);
    }
  } finally {
    preview.kill("SIGTERM");
  }

  for (const [name, results] of Object.entries(all)) {
    printResults(name, results);
  }

  console.log("\n=== results JSON ===");
  console.log(JSON.stringify(all, null, 2));
}

await main();
