import { fileURLToPath, URL } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// Chromium and WebKit: WebKit's IndexedDB is the one Safari users' stores live in.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.browser.test.ts",
  outputDir: fileURLToPath(new URL("../../../tmp/pgwasm-idb-browser-results", import.meta.url)),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4191",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "bun run e2e:pgwasm-idb:serve",
    url: "http://127.0.0.1:4191",
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
