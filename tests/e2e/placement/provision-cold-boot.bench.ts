import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// Manual ADR-0049 provision benchmark; deliberately excluded from every aggregate.
// Run: bunx playwright test --config tests/e2e/placement/playwright.bench.config.ts

const SAMPLES = 5;

interface Sample {
  mode: "plain" | "provisioned";
  provisionLeadMs: number;
  attachToFirstQueryMs: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

test("provision ahead of attach reduces foreground cold-boot latency", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const samples: Sample[] = [];

  // Pair the modes per repetition so process/cache drift cannot systematically favour the second group.
  for (let i = 0; i < SAMPLES; i += 1) {
    for (const mode of ["plain", "provisioned"] as const) {
      const storePath = uniqueStore(`provision-bench-${mode}`);
      let provisionLeadMs = 0;
      if (mode === "provisioned") {
        const provisionStarted = performance.now();
        const provision = await harnessCall(page, "provision", { storePath, timeoutMs: 30_000 });
        expect(provision.ok, JSON.stringify(provision)).toBe(true);
        provisionLeadMs = performance.now() - provisionStarted;
      }

      const foregroundStarted = performance.now();
      const attached = await harnessCall(page, "attach", { storePath, factories: true, timeoutMs: 30_000 });
      expect(attached.ok, JSON.stringify(attached)).toBe(true);
      const read = await harnessCall(page, "read", storePath, 30_000);
      expect(read.ok, JSON.stringify(read)).toBe(true);
      samples.push({ mode, provisionLeadMs, attachToFirstQueryMs: performance.now() - foregroundStarted });
      await harnessCall(page, "cleanup", storePath);
    }
  }

  const plain = samples.filter((sample) => sample.mode === "plain").map((sample) => sample.attachToFirstQueryMs);
  const provisioned = samples
    .filter((sample) => sample.mode === "provisioned")
    .map((sample) => sample.attachToFirstQueryMs);
  console.table(samples);
  console.log(
    JSON.stringify(
      {
        samples: SAMPLES,
        plainMedianMs: median(plain),
        provisionedMedianMs: median(provisioned),
        foregroundDeltaMs: median(provisioned) - median(plain),
      },
      null,
      2,
    ),
  );
});
