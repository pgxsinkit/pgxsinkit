import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the Slice 0a warm-boot browser benchmark (`bun run bench:warm-boot`, driven by
// scripts/run-warm-boot-bench.ts). Kept SEPARATE from playwright.config.ts on purpose: its `testMatch`
// is **/*.bench.ts, so the bench spec is invisible to the normal ADR-0032 e2e lane (which matches
// **/*.e2e.test.ts) and this bench never rides `test:integration`. It reuses the same built-artifact
// webServer (vite build with VITE_E2E=1 → vite preview on 5173) and the same backend origin/TLS posture
// as the worker lane; the backend podman stack is owned by run-warm-boot-bench.ts, not here.
//
// The bench launches its OWN persistent Chromium contexts (chromium.launchPersistentContext) so a warm
// IndexedDB store survives a full context close — the `use`/projects context below is nominal. One test,
// one worker, serial: it populates a profile then reopens it several times, so it can never run in
// parallel against the single shared backend.
const insecureTls = process.env["PGXSINKIT_PW_INSECURE_TLS"] === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.bench.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"]],
  // One long-running test (populate + 5 online + 2 offline cold-worker boots, each a fresh browser),
  // so a generous whole-test budget; the per-milestone waits carry their own tighter timeouts.
  timeout: 900_000,
  expect: { timeout: 120_000 },
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    trace: "retain-on-failure",
    ...(insecureTls ? { ignoreHTTPSErrors: true } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run e2e:board:serve",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env["CI"],
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
