import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.browser.test.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:4190",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run e2e:opfs-repacked:serve",
    url: "http://127.0.0.1:4190",
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
