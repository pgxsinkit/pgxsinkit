import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";

import type { BootReport } from "@pgxsinkit/client";

// ── Slice 0a warm-boot browser benchmark (manual/nightly, NOT test:integration) ─────────────────────
// The proposal's "cold-worker warm-store boot" measurement, reproduced against the REAL board app in a
// REAL Chromium with a PERSISTENT profile — the only faithful model of a returning user whose IndexedDB
// PGlite store survives but whose SharedWorker (and its hot engine) has died. scripts/run-warm-boot-bench.ts
// owns the podman stack + seed around this; a DEDICATED config (playwright.warm-boot.config.ts, testMatch
// **/*.bench.ts) keeps this file invisible to the normal e2e lane's **/*.e2e.test.ts match, so the bench
// never rides `test:integration`.
//
//   Run A (populate, ×1): fresh persistent profile → sign in → full catch-up (boot report finalizes +
//     cached rows render) → close the WHOLE context so the SharedWorker (and PGlite) die.
//   Run B (measure, ×5):  reopen the SAME profile → a cold worker reopens the warm store. Capture the
//     BootReport (assert storeKind "warm", schema replay + journal recovery skipped), navigation→attach,
//     first live-query snapshot (team nav), first cached row (a seeded issue title). Close between every
//     sample so each is a genuinely cold worker.
//   Run C (offline, ×2):  same warm store as B, but with NO sync backend from the first boot — cached
//     rows MUST still paint (ADR-0041 acceptance criterion, now ASSERTED). THREE harness realities force a
//     faithful substitution for a literal `context.setOffline(true)` before navigation (flagged as
//     deviations): (1) the board ships no service worker, so a real offline toggle would also block loading
//     the app SHELL from :5173 and the SPA could never boot; (2) Playwright `context.route` does NOT
//     intercept a SharedWorker's own fetches, so a data blackhole leaves the worker fully online (observed:
//     it caught up and finalized); (3) the board's cold auth path needs GoTrue, so blackholing the whole
//     front strands the app on the login screen. So Run C: forces the IN-PROCESS fallback
//     (`delete window.SharedWorker`, the board's scenario-(e) path) — the SAME client boot + cached-read
//     code, on the main thread whose fetches ARE routable — and blackholes ONLY the pgxsinkit data endpoints
//     (`/functions/v1/board-sync|board-write`), leaving the shell and GoTrue auth reachable so the board
//     authenticates and boots off the warm store.
//     Before ADR-0041 this run painted 0/2 (cached reads were hostage to sync START — see the lane record):
//     the in-process client did not resolve until the blackholed sync began, so first paint never came.
//     Under Option B the client resolves at `localReadReady` and the board paints at that point, so cached
//     rows render with the sync backend unreachable — this run now GATES on that. The BootReport finalizes
//     at initial sync (whole-sync), which the blackholed sync can never satisfy, so the REPORT stays ABSENT
//     (`localReadReadyMs` is the relevant crossing, but it only rides a finalized report); we assert the
//     rendered cached rows and capture the sync rail for the record.
//
// Timing is structural, never a PGlite poll (that would perturb the single WASM thread): milestones are
// page-global reads (`__boardClient`, `__boardBootReport`), DOM markers (team nav, an issue card), and
// the worker's own monotonic rail. Assertions are structural (flags true / rows visible); the durations
// are REPORTED (printed table + a JSON artifact under tmp/), not budget-asserted — budgets come later
// once the numbers are known (plan slice 0a).

test.describe.configure({ mode: "serial" });

// Seeded identity + fixtures (scripts/seed-board.ts). Alice spans Platform + Growth.
const ALICE = "Alice Okafor";
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";
// Platform draws the first 14 title-pool entries (disjoint per-team slice, drawn unique), so all 14 render
// on its board — the first entry is a guaranteed cached-row DOM marker on a warm boot.
const ISSUE_TITLE = "Flush queue stalls under burst writes";

const MEASURE_SAMPLES = 5;
const OFFLINE_SAMPLES = 2;

const BASE_URL = "http://localhost:5173";
const BENCH_ROOT = path.resolve("tmp/warm-boot-bench");
const PROFILE_DIR = path.join(BENCH_ROOT, `profile-${Date.now()}`);

// Same sandbox/CI TLS fallback posture as the worker lane (playwright.config.ts): OFF by default
// (browser-realistic, trusts the mkcert front), on only where Chromium cannot see the NSS trust store.
const insecureTls = process.env["PGXSINKIT_PW_INSECURE_TLS"] === "1";

interface Sample {
  /** Navigation commit → the board's live client object is exposed (worker attach resolved). */
  attachMs: number;
  /** Navigation commit → the team-nav live query paints (first live-query snapshot). */
  teamNavReadyMs: number;
  /** Navigation commit → a seeded issue card paints (first cached row from the warm store). */
  firstCachedRowMs: number;
  /** Navigation commit → the BootReport finalized (initial sync complete); null when it never finalized. */
  bootReportMs: number | null;
  /** The finalized BootReport, or null (e.g. offline: catch-up never completes). */
  report: BootReport | null;
  /** Sync-rail (`[pgxsinkit …]`) boot-phase evidence captured when the report is absent (offline). */
  syncRailTail?: string[];
  /** Best-effort human outcome for an offline sample (what the boot actually reached). */
  note?: string;
}

/** The sidebar team switcher landmark, scoped so team names never collide with a page heading. */
function teamNav(page: Page) {
  return page.getByRole("navigation");
}

// The board's pgxsinkit DATA endpoints (config.ts): the Electric shape proxy and the write ingress, both
// under the caddy front's `/functions/v1/*`. We blackhole ONLY these — NOT the app shell (:5173) and NOT
// GoTrue auth (`/auth/v1` on the same front), so the board still authenticates (persisted session) and
// boots; the only thing missing is the sync backend, proving cached rows come from the warm store.
const SYNC_BACKEND_GLOBS = ["**/functions/v1/board-sync**", "**/functions/v1/board-write**"];

async function launchProfile(offline: boolean): Promise<{ context: BrowserContext; page: Page; console: string[] }> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    baseURL: BASE_URL,
    ...(insecureTls ? { ignoreHTTPSErrors: true } : {}),
  });
  // Offline: model "no sync backend from the first boot" BEFORE any navigation (see the header note).
  // Force the in-process fallback (the SharedWorker's fetches are NOT routable, the main thread's are),
  // then blackhole the sync/write data endpoints from t0 (auth + shell stay reachable so the board boots).
  if (offline) {
    await context.addInitScript(() => {
      // @ts-expect-error — deleting the constructor makes the board's feature-detect fall back to in-process.
      delete window.SharedWorker;
    });
    for (const glob of SYNC_BACKEND_GLOBS) {
      await context.route(glob, (route) => route.abort());
    }
  }
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  return { context, page, console: consoleLines };
}

/** Read the board's dev-exposed BootReport (set on `globalThis.__boardBootReport` in the VITE_E2E build). */
async function readBootReport(page: Page, timeoutMs: number): Promise<BootReport | null> {
  try {
    await page.waitForFunction(
      () => (globalThis as { __boardBootReport?: unknown }).__boardBootReport != null,
      undefined,
      { timeout: timeoutMs },
    );
  } catch {
    return null;
  }
  return page.evaluate(() => (globalThis as { __boardBootReport?: BootReport }).__boardBootReport ?? null);
}

/** Sign in from the login screen and wait for the board's synced team list to paint. */
async function signIn(page: Page, name: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  await page.getByRole("button", { name }).click();
  await expect(teamNav(page).getByText("Platform", { exact: true })).toBeVisible();
}

/** Populate + fully catch up the warm store once, then kill the context so the SharedWorker dies. */
async function populate(): Promise<void> {
  const { context, page } = await launchProfile(false);
  try {
    await page.goto("/");
    await signIn(page, ALICE);
    // Drive to the Platform board and prove the read path fully hydrated: a seeded issue card is painted.
    await page.goto(`/team/${PLATFORM}/board`);
    await expect(teamNav(page).getByText("Platform", { exact: true })).toBeVisible();
    await expect(page.getByText(ISSUE_TITLE).first()).toBeVisible();
    // Settle on the boot report finalizing (all eager groups caught up = every synced row committed to
    // IndexedDB) — a deterministic gate, not a fixed sleep.
    const report = await readBootReport(page, 60_000);
    expect(report, "populate run must reach initial sync").not.toBeNull();
  } finally {
    // Close the WHOLE context: the SharedWorker (and its PGlite engine) die, so the next open is a cold
    // worker over the now-warm persisted store.
    await context.close();
  }
}

/** One online cold-worker warm-store sample: reopen the profile, capture the milestones, close. */
async function sample(): Promise<Sample> {
  const { context, page } = await launchProfile(false);
  try {
    const t0 = performance.now();
    const stamp = () => performance.now() - t0;
    // Anchor at navigation commit (the proposal's anchor); the milestones measure forward from there.
    await page.goto(`/team/${PLATFORM}/board`, { waitUntil: "commit" });

    // Independent concurrent waiters so each milestone is stamped at its own real resolution, regardless
    // of the order they land in.
    const attach = page
      .waitForFunction(() => (globalThis as { __boardClient?: unknown }).__boardClient != null, undefined, {
        timeout: 120_000,
      })
      .then(stamp);
    const teamNavReady = teamNav(page)
      .getByText("Platform", { exact: true })
      .waitFor({ state: "visible", timeout: 120_000 })
      .then(stamp);
    const firstCachedRow = page
      .getByText(ISSUE_TITLE)
      .first()
      .waitFor({ state: "visible", timeout: 120_000 })
      .then(stamp);

    const [attachMs, teamNavReadyMs, firstCachedRowMs] = await Promise.all([attach, teamNavReady, firstCachedRow]);

    const report = await readBootReport(page, 60_000);
    const bootReportMs = report != null ? stamp() : null;
    return { attachMs, teamNavReadyMs, firstCachedRowMs, bootReportMs, report };
  } finally {
    await context.close();
  }
}

/**
 * One OFFLINE (no-sync-backend) cold warm-store sample (see the header note on why a literal offline cold
 * boot is not achievable here — this drives the in-process fallback with the sync/write endpoints
 * blackholed). Each waiter is bounded and the sample records what the boot actually reached (cached rows
 * painted / attached-but-empty / stranded on login); since ADR-0041 stage 2 the run is ASSERTED — every
 * offline sample must paint cached rows (the Option B acceptance criterion).
 */
async function offlineSample(): Promise<Sample> {
  const { context, page, console: consoleLines } = await launchProfile(true);
  const BOUND = 40_000;
  try {
    const t0 = performance.now();
    const stamp = () => performance.now() - t0;
    await page.goto(`/team/${PLATFORM}/board`, { waitUntil: "commit" });

    const soft = async (run: () => Promise<unknown>): Promise<number> => {
      try {
        await run();
        return stamp();
      } catch {
        return Number.NaN;
      }
    };

    // Race the two possible destinations so a stranded-on-login boot doesn't burn the whole bound.
    let note = "";
    const attachMs = await soft(() =>
      page.waitForFunction(() => (globalThis as { __boardClient?: unknown }).__boardClient != null, undefined, {
        timeout: BOUND,
      }),
    );
    const teamNavReadyMs = await soft(() =>
      teamNav(page).getByText("Platform", { exact: true }).waitFor({ state: "visible", timeout: BOUND }),
    );
    const firstCachedRowMs = Number.isFinite(teamNavReadyMs)
      ? await soft(() => page.getByText(ISSUE_TITLE).first().waitFor({ state: "visible", timeout: BOUND }))
      : Number.NaN;

    const loginVisible = await page
      .getByRole("heading", { name: "Sign in to the board" })
      .isVisible()
      .catch(() => false);
    if (Number.isFinite(firstCachedRowMs)) note = "cached rows painted with the sync backend blackholed";
    else if (loginVisible) note = "stranded on the login screen (cold auth path needs the backend)";
    else if (Number.isFinite(attachMs)) note = "client attached but the warm store's cached rows did not paint";
    else note = "boot did not attach the client within the bound";

    const report = await readBootReport(page, 4_000);
    const bootReportMs = report != null ? stamp() : null;
    return {
      attachMs,
      teamNavReadyMs,
      firstCachedRowMs,
      bootReportMs,
      report,
      note,
      // In-process rail lines are `[pgxsinkit …]` (worker lines add a `·w`); capture either.
      syncRailTail: consoleLines.filter((line) => line.includes("[pgxsinkit")).slice(-25),
    };
  } finally {
    await context.close();
  }
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function p95(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

const round = (value: number) => Math.round(value * 10) / 10;

function summarize(label: string, samples: Sample[]) {
  const pick = (fn: (s: Sample) => number | null) =>
    samples.map(fn).filter((v): v is number => v != null && Number.isFinite(v));
  const columns = {
    attachMs: pick((s) => s.attachMs),
    teamNavReadyMs: pick((s) => s.teamNavReadyMs),
    firstCachedRowMs: pick((s) => s.firstCachedRowMs),
    bootReportMs: pick((s) => s.bootReportMs),
    reportTotalMs: pick((s) => s.report?.totalMs ?? null),
    // ADR-0041 staged-boot crossings — additive BootReport fields. `localReadReadyMs` is the moment cached
    // reads are safe (= where attach now resolves); `writeReadyMs` the moment the write runtime is up.
    localReadReadyMs: pick((s) => s.report?.localReadReadyMs ?? null),
    writeReadyMs: pick((s) => s.report?.writeReadyMs ?? null),
    pgliteCreateMs: pick((s) => s.report?.phases.pgliteCreateMs ?? null),
    schemaExecMs: pick((s) => s.report?.phases.schemaExecMs ?? null),
    journalRecoveryMs: pick((s) => s.report?.phases.journalRecoveryMs ?? null),
  };
  const stats = Object.fromEntries(
    Object.entries(columns).map(([key, values]) => [
      key,
      { n: values.length, median: round(median(values)), p95: round(p95(values)) },
    ]),
  );
  return { label, samples: samples.length, stats, raw: samples };
}

test("warm-boot bench: populate, measure ×5, offline ×2", async () => {
  mkdirSync(BENCH_ROOT, { recursive: true });

  // ── Run A: populate + full catch-up, then kill the worker. ──
  await populate();

  // ── Run B: 5 online cold-worker warm-store samples (the primary measurement). ──
  const measured: Sample[] = [];
  for (let i = 0; i < MEASURE_SAMPLES; i++) {
    const s = await sample();
    // Structural assertions — the warm-boot fast paths must be engaged (plan slices 1–3 landed).
    expect(s.report, `sample ${i}: BootReport must finalize online`).not.toBeNull();
    expect(s.report!.storeKind, `sample ${i}: storeKind`).toBe("warm");
    expect(s.report!.warmBoot.journalRecoverySkipped, `sample ${i}: journalRecoverySkipped`).toBe(true);
    expect(s.report!.warmBoot.schemaSkipped, `sample ${i}: schemaSkipped`).toBe(true);
    measured.push(s);
  }

  // ── Run C: offline (no-sync-backend) cold warm-store samples — best-effort/observational. ──
  const offline: Sample[] = [];
  for (let i = 0; i < OFFLINE_SAMPLES; i++) {
    offline.push(await offlineSample());
  }
  const offlineCachedRowPainted = offline.filter((s) => Number.isFinite(s.firstCachedRowMs)).length;
  const offlineReportFinalized = offline.filter((s) => s.report != null).length;

  const online = summarize("measure (online, cold worker, warm store)", measured);
  const offlineSummary = summarize("offline (no sync backend, in-process fallback, warm store)", offline);

  const artifact = {
    generatedAt: new Date().toISOString(),
    profileDir: PROFILE_DIR,
    insecureTls,
    online,
    offline: offlineSummary,
    offlineCachedRowPainted,
    offlineReportFinalized,
    offlineOutcomes: offline.map((s) => s.note ?? "unknown"),
    offlineNote:
      "Run C ASSERTS the ADR-0041 acceptance criterion: cached rows paint with the sync backend blackholed. " +
      "A literal offline cold boot of this board is not achievable in-harness (no service worker → the shell " +
      "can't load offline; a SharedWorker's fetches are unroutable by Playwright; the cold auth path needs " +
      "GoTrue), so Run C forces the in-process fallback and blackholes only the pgxsinkit sync/write " +
      "endpoints — the same client boot + cached-read path. See offlineOutcomes and each sample's syncRailTail.",
  };

  const artifactPath = path.join(BENCH_ROOT, `results-${Date.now()}.json`);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  // Printed report (median + p95). console.table for the human-readable milestone summary.
  const asRows = (s: ReturnType<typeof summarize>) =>
    Object.fromEntries(Object.entries(s.stats).map(([k, v]) => [k, { n: v.n, median: v.median, p95: v.p95 }]));
  console.log(`\n=== Warm-boot bench — ${online.label} (${online.samples} samples) ===`);
  console.table(asRows(online));
  console.log(`\n=== Warm-boot bench — ${offlineSummary.label} (${offlineSummary.samples} samples) ===`);
  console.table(asRows(offlineSummary));
  console.log(`Offline cached rows painted: ${offlineCachedRowPainted}/${offline.length}.`);
  console.log(`Offline outcomes: ${artifact.offlineOutcomes.join(" | ")}`);
  console.log(`Artifact: ${artifactPath}\n`);

  // Run B: the online warm-boot fast-path assertions rode each sample above. Run C (ADR-0041 acceptance
  // criterion): EVERY offline sample must have painted cached rows off the warm store with the sync/write
  // backend blackholed — the flip from the pre-ADR-0041 0/2 (cached reads hostage to sync start).
  expect(measured.length).toBe(MEASURE_SAMPLES);
  expect(offlineCachedRowPainted, `offline cached-row paint (outcomes: ${artifact.offlineOutcomes.join(" | ")})`).toBe(
    OFFLINE_SAMPLES,
  );
});
