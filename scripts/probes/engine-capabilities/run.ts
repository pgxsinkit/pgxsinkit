import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Playwright driver for the engine-capability probes. Launches chromium, firefox,
// and webkit, serves the probe page over a same-origin Bun static server, collects
// the P1-P4 core results per engine, then runs P5 (the handle ceiling) in a SEPARATE
// browser instance per engine so a wedge cannot poison the core run. Also runs the
// PGlite datadir width probe. Writes one combined, host-specific JSON record to the
// repo's gitignored tmp/results/ tree — this output is regenerable and never tracked.
//
// Re-verifies the engine facts recorded in the "Engine capability rationale" section
// of docs/adr/0048-opfs-repacked-vfs.md.
import { chromium, firefox, webkit } from "@playwright/test";
import type { Browser, BrowserType } from "@playwright/test";

import { countDatadirFiles } from "./pglite-datadir-count";
import { startProbeServer } from "./serve";

interface ErrorInfo {
  name: string | null;
  message: string | null;
}

interface ProbeGrant {
  granted?: boolean;
  methodPresent?: boolean;
  error?: ErrorInfo;
  timeout?: boolean;
  workerError?: string;
}

interface ProbeShared {
  sharedWorkerSupported?: boolean;
  granted?: boolean;
  methodPresent?: boolean;
  error?: ErrorInfo;
  spawned?: boolean;
  nestedResponded?: boolean;
  nestedError?: string;
  timeout?: boolean;
  constructError?: ErrorInfo;
  sharedWorkerError?: string;
  note?: string;
  p2?: ProbeShared;
  p3?: ProbeShared;
}

interface ProbeContend {
  contended?: boolean;
  acquired?: boolean;
  error?: ErrorInfo;
  timeout?: boolean;
  workerError?: boolean | string;
  holdFailed?: boolean;
  holdError?: ErrorInfo;
}

interface CoreResults {
  mode?: string;
  userAgent?: string;
  opfsSupported?: boolean;
  createSyncAccessHandleOnMainThread?: boolean;
  p1?: ProbeGrant;
  p2?: ProbeShared;
  p3?: ProbeShared;
  p4?: ProbeContend;
  fatal?: ErrorInfo;
}

interface P5Result {
  classification?: string;
  count?: number;
  openedBefore?: number;
  error?: ErrorInfo | string;
  lastProgress?: number;
  watchdogMs?: number;
}

interface P5Results {
  p5?: P5Result;
  fatal?: ErrorInfo;
}

interface EngineResult {
  browserVersion: string;
  core: CoreResults;
  p5: P5Result;
}

const ENGINES: { name: string; type: BrowserType; args: string[] }[] = [
  // Chromium on Linux headless in a sandboxed/CI environment typically needs
  // --no-sandbox (no user-namespace cloning).
  { name: "chromium", type: chromium, args: ["--no-sandbox"] },
  { name: "firefox", type: firefox, args: [] },
  { name: "webkit", type: webkit, args: [] },
];

function runShell(command: string): string {
  const proc = Bun.spawnSync(["sh", "-c", command]);
  return new TextDecoder().decode(proc.stdout).trim();
}

async function readPlaywrightVersion(repoRoot: string): Promise<string> {
  const pkgPath = path.join(repoRoot, "node_modules", "@playwright", "test", "package.json");
  const raw = (await Bun.file(pkgPath).json()) as { version?: string };
  return raw.version ?? "unknown";
}

async function collectCore(
  engine: { type: BrowserType; args: string[] },
  url: string,
): Promise<{ version: string; core: CoreResults }> {
  const browser: Browser = await engine.type.launch({ args: engine.args });
  try {
    const version = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${url}?mode=core`, { timeout: 30000, waitUntil: "load" });
    await page.waitForFunction("window.__PROBE_DONE__ === true", { timeout: 120000 });
    const core = (await page.evaluate("window.__PROBE_RESULTS__")) as CoreResults;
    return { version, core };
  } finally {
    await Promise.race([browser.close(), delay(15000)]);
  }
}

async function collectP5(engine: { type: BrowserType; args: string[] }, url: string): Promise<P5Result> {
  // Separate browser instance so a P5 wedge cannot poison the core run.
  const browser: Browser = await engine.type.launch({ args: engine.args });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${url}?mode=p5`, { timeout: 30000, waitUntil: "load" });
    const done = await Promise.race([
      page
        .waitForFunction("window.__PROBE_DONE__ === true", { timeout: 180000 })
        .then(() => true)
        .catch(() => false),
      delay(190000).then(() => false),
    ]);
    if (done) {
      const results = (await page.evaluate("window.__PROBE_RESULTS__")) as P5Results;
      return results.p5 ?? { classification: "no-p5-field" };
    }
    // Not done: try to read the partial marker; the renderer may be wedged.
    const partial = await Promise.race([
      page.evaluate("window.__PROBE_P5_PARTIAL__").catch(() => null),
      delay(5000).then(() => null),
    ]);
    if (partial && typeof partial === "object") {
      return partial as P5Result;
    }
    return { classification: "wedged-unreadable" };
  } finally {
    // Best-effort teardown; a genuinely wedged Chromium profile may not close cleanly.
    await Promise.race([browser.close().catch(() => undefined), delay(15000)]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LowFdResult {
  requestedUlimit: string;
  observedSoftUlimit: string;
  observedHardUlimit: string;
  p5?: P5Result;
  launchError?: string;
}

const LOWFD_MARKER = "LOWFD_RESULT:";

// Child-process entry point: run ONLY the Chromium P5 handle-ceiling probe, in a
// process whose file-descriptor soft limit has been lowered to ~1024 by the parent's
// `ulimit -n 1024` wrapper — the desktop-session limit the ADR's Chromium/Linux wedge
// claim describes. Chromium's storage service inherits this limit. Emits one marker
// line the parent parses.
async function runChildLowFdP5(): Promise<void> {
  const observedSoftUlimit = runShell("ulimit -Sn");
  const observedHardUlimit = runShell("ulimit -Hn");
  const server = startProbeServer(0);
  const url = server.url.href.replace(/\/$/, "");
  const result: LowFdResult = { requestedUlimit: "1024", observedSoftUlimit, observedHardUlimit };
  try {
    result.p5 = await collectP5({ type: chromium, args: ["--no-sandbox"] }, url);
  } catch (err) {
    const e = err as Error;
    result.launchError = `${e.name}: ${e.message}`;
  } finally {
    await server.stop(true);
  }
  console.log(`${LOWFD_MARKER}${JSON.stringify(result)}`);
}

// Parent side: re-invoke this file as a child under `ulimit -n 1024` and parse the
// marker line. Only meaningful for Chromium/Linux.
async function collectChromiumLowFdP5(): Promise<LowFdResult> {
  const self = import.meta.path;
  const proc = Bun.spawn(["bash", "-c", `ulimit -n 1024 && exec bun ${JSON.stringify(self)} --child-lowfd-p5`], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const line = text.split("\n").find((l) => l.startsWith(LOWFD_MARKER));
  if (!line) {
    return {
      requestedUlimit: "1024",
      observedSoftUlimit: "unknown",
      observedHardUlimit: "unknown",
      launchError: "no marker line from child (see stderr)",
    };
  }
  return JSON.parse(line.slice(LOWFD_MARKER.length)) as LowFdResult;
}

async function main(): Promise<void> {
  if (process.argv.includes("--child-lowfd-p5")) {
    await runChildLowFdP5();
    return;
  }
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const date = new Date().toISOString().slice(0, 10);
  const hostOs = os.platform();
  const unameSR = runShell("uname -sr");
  const ulimitN = runShell("ulimit -n");
  const playwrightVersion = await readPlaywrightVersion(repoRoot);

  const server = startProbeServer(0);
  const url = server.url.href.replace(/\/$/, "");
  console.log(`probe server: ${url}`);

  const engineResults: Record<string, EngineResult> = {};

  for (const engine of ENGINES) {
    console.log(`\n=== ${engine.name}: core (P1-P4) ===`);
    let core: CoreResults = {};
    let version = "unknown";
    try {
      const collected = await collectCore(engine, url);
      core = collected.core;
      version = collected.version;
      console.log(`  ${engine.name} ${version}`);
      console.log(`  P1 dedicated grant: ${JSON.stringify(core.p1)}`);
      console.log(`  P2 shared grant:    ${JSON.stringify(core.p2)}`);
      console.log(`  P3 nested worker:   ${JSON.stringify(core.p3)}`);
      console.log(`  P4 contention:      ${JSON.stringify(core.p4)}`);
    } catch (err) {
      const e = err as Error;
      core = { fatal: { name: e.name, message: e.message } };
      console.log(`  ${engine.name} core FAILED: ${e.message}`);
    }

    console.log(`=== ${engine.name}: P5 (handle ceiling, isolated instance) ===`);
    let p5: P5Result = { classification: "not-run" };
    try {
      p5 = await collectP5(engine, url);
      console.log(`  P5: ${JSON.stringify(p5)}`);
    } catch (err) {
      const e = err as Error;
      p5 = { classification: "driver-error", error: { name: e.name, message: e.message } };
      console.log(`  ${engine.name} P5 FAILED: ${e.message}`);
    }

    engineResults[engine.name] = { browserVersion: version, core, p5 };
  }

  console.log(`\n=== Chromium P5 under lowered ulimit -n 1024 (wedge reproduction) ===`);
  let chromiumLowFd: LowFdResult | { skipped: string };
  if (hostOs === "linux") {
    try {
      chromiumLowFd = await collectChromiumLowFdP5();
      console.log(`  low-fd P5: ${JSON.stringify(chromiumLowFd)}`);
    } catch (err) {
      const e = err as Error;
      chromiumLowFd = {
        requestedUlimit: "1024",
        observedSoftUlimit: "unknown",
        observedHardUlimit: "unknown",
        launchError: `${e.name}: ${e.message}`,
      };
      console.log(`  low-fd P5 FAILED: ${e.message}`);
    }
  } else {
    chromiumLowFd = { skipped: `not linux (${hostOs})` };
  }

  console.log(`\n=== PGlite datadir width probe ===`);
  let datadir: { files: number; directories: number } | { error: string };
  try {
    const dd = await countDatadirFiles();
    datadir = { files: dd.files, directories: dd.directories };
    console.log(`  datadir files: ${dd.files} (directories: ${dd.directories})`);
  } catch (err) {
    const e = err as Error;
    datadir = { error: e.message };
    console.log(`  datadir probe FAILED: ${e.message}`);
  }

  await server.stop(true);

  const combined = {
    meta: {
      date,
      hostOs,
      unameSR,
      ulimitN,
      playwrightVersion,
      generatedAt: new Date().toISOString(),
    },
    engines: engineResults,
    chromiumLowFdP5: chromiumLowFd,
    pgliteDatadir: datadir,
  };

  // Host-specific, regenerable output is NOT tracked: it goes under the repo's
  // gitignored tmp/ tree so it never enters git or the format/lint sweeps.
  const resultsDir = path.join(repoRoot, "tmp", "results");
  mkdirSync(resultsDir, { recursive: true });
  const jsonPath = path.join(resultsDir, `engine-capabilities-${date}-${hostOs}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(combined, null, 2)}\n`);
  console.log(`\nwrote ${jsonPath} (untracked)`);
}

await main();
