import { defineConfig, devices } from "@playwright/test";

// The ADR-0032 S3 browser lane (`bun run test:integration:worker`, wired into `test:integration`). It
// drives the REAL board app in a REAL Chromium against the local board stack, so the SharedWorker sync
// engine — spare provision, two-tabs-one-engine, tab-close survival, the worker-origin debug rail, and
// the in-process fallback — is exercised end-to-end, not simulated over a MessageChannel (that is the
// bun `worker-*.test.ts` tier). scripts/run-worker-lane.ts owns the podman lifecycle + seed around this;
// Playwright's `webServer` owns serving the app.
//
// The lane tests the BUILT artifact, not the dev server: `webServer` runs `e2e:board:serve` — a real
// `vite build` (with `VITE_E2E=1`, which alone keeps the dev introspection handles the scenarios use in
// a production bundle) served by `vite preview` on 5173. Dev serving would exercise unbundled ESM,
// unminified worker loading, and DEV-only code paths that never ship — and its cold-transform latency
// is what originally forced the CI budget scaling below.
//
// Origins (board-compose.yml): the app is served on http://localhost:5173 (the board's established
// origin, already in the board-sync CORS allow-list — the DEV server now lives on 5660 for the kube
// flow and plays no part here); its default backend origin is the caddy h1/h2/h3
// front at https://localhost:54343 — so the six Electric long-polls + the SharedWorker multiplex over
// one h2 connection, exactly the scenario the front exists for. The SharedWorker is same-origin to the
// app (5173); its cross-origin fetches reach :54343 over TLS.
//
// TLS: the front's mkcert-issued cert is trusted system-wide on the owner's machine (and on the CI
// runner after `mkcert -install`), so the DEFAULT posture sets NO TLS config at all — browser-realistic.
// A sandbox whose Chromium cannot see the system/NSS trust store (a masked HOME hiding ~/.pki/nssdb)
// sets PGXSINKIT_PW_INSECURE_TLS=1 to fall back to `ignoreHTTPSErrors` — DEFAULT OFF, sandbox/CI-bootstrap
// only, never the owner's or CI's posture.
const insecureTls = process.env["PGXSINKIT_PW_INSECURE_TLS"] === "1";
const ci = !!process.env["CI"];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.test.ts",
  // The board stack is a single shared podman deployment with seeded fixtures and cross-tab shared state,
  // so the scenarios run serially in one worker — never in parallel against the one backend.
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  reporter: [["list"]],
  outputDir: "tmp/playwright/board-worker",
  // CI headroom: the hosted runner has 2 vCPUs shared between the worker's initdb WASM, Chromium, and
  // the whole podman stack — the sign-in→ready stretch that takes ~12s warm-local blew the 15s expect
  // budget there (run 28688852669). Same assertions, scaled deadlines; locally the tight budgets stand.
  timeout: ci ? 180_000 : 60_000,
  expect: { timeout: ci ? 60_000 : 15_000 },
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    trace: "retain-on-failure",
    ...(insecureTls ? { ignoreHTTPSErrors: true } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Build + serve the SPA (vite build → vite preview on 5173). The backend stack is brought up
  // separately by run-worker-lane.ts before Playwright starts. Never reuse an existing server: this lane
  // pins its backend URLs in the runner environment, so accepting a leftover preview can silently test a
  // stale build aimed at a different deployment. An occupied port must fail loudly. The timeout covers the
  // build itself on the 2-vCPU runner.
  webServer: {
    command: "bun run e2e:board:serve",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
