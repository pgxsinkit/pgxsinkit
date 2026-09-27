import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "@playwright/test";

// Chromium and WebKit: WebKit's OPFS is the one Safari users' stores live in. WebKit grants OPFS only to a
// persistent context, so the spec file gives its WebKit tests one (see its `context` fixture). The port is
// off the Fetch standard's bad-port list, which WebKit enforces (it refused this lane's old 4190).
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.browser.test.ts",
  outputDir: fileURLToPath(new URL("../../../tmp/pgwasm-opfs-browser-results", import.meta.url)),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4192",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "bun run e2e:pgwasm-opfs:serve",
    url: "http://127.0.0.1:4192",
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
