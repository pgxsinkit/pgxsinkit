import { defineConfig, devices } from "@playwright/test";

// ADR-0049 step 12 — the multi-tab placement lanes. Chromium + Firefox exercise the elected-worker path; the
// WebKit project attempts the SW-direct path (the repo's history says Playwright's WebKitGTK build lacks OPFS
// sync-access in a SharedWorker, so those lanes skip/`fixme` there — the REAL WebKit evidence is the device
// bench). Cross-tab lanes open two pages in ONE browser context.

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.browser.test.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4290",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "bun run e2e:placement:serve",
    url: "http://127.0.0.1:4290",
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
