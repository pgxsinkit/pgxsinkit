/**
 * Boot observability (ADR-0034) — spare-adoption provision reporting. A boot that ADOPTS a pre-provisioned
 * store (the caller minted the raw PGlite ahead of boot and stamped its create timing) must report the
 * spare's initdb cost as `BootReport.provision` and set `phases.pgliteCreateMs = null` — the create was
 * paid at provision time, off this boot's clock. Exercised in-process via `precreatedPglite` +
 * `provisionStamp` (the same seam `defineSyncWorker` uses when a boot adopts a provisioned spare), with
 * `syncEnabled: false` so the report finalizes at `ready` without needing a shape transport.
 */
import { describe, expect, it } from "bun:test";

import { integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { type ClientPGlite, createClientPGlite, createSyncClient } from "../../packages/client/src/index";
import { memoryStoreForTests } from "../../packages/client/src/testing";

const registry = defineSyncRegistry({
  widget: defineSyncTable({
    tableName: "widget",
    makeColumns: () => ({ id: integer("id").primaryKey(), name: text("name") }),
  }),
});

let storeId = 0;

describe("BootReport — spare adoption (ADR-0034)", () => {
  it("reports provision != null and phases.pgliteCreateMs === null when adopting a provisioned store", async () => {
    // Mint the raw store ahead of boot (a spare) and stamp its create timing, then adopt it — the exact
    // shape `defineSyncWorker` forwards when a boot adopts a provisioned spare.
    const precreated = await createClientPGlite(memoryStoreForTests(`boot-report-provision-${++storeId}`));
    const provisionReadyAt = performance.now() - 250; // the spare sat ready ~250ms before this boot

    const client = await createSyncClient({
      registry: registry as never,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      ...memoryStoreForTests(`boot-report-provision-${storeId}`),
      precreatedPglite: Promise.resolve(precreated as unknown as ClientPGlite),
      provisionStamp: Promise.resolve({ initdbMs: 111, provisionReadyAt }),
      syncEnabled: false,
    } as Parameters<typeof createSyncClient>[0]);
    await client.ready;

    const report = await client.bootReport();
    expect(report).not.toBeNull();
    const r = report!;

    expect(r.reportVersion).toBe(1);
    expect(r.mode).toBe("in-process");
    // The spare's create cost is reported under `provision`, and the boot ran no create of its own.
    expect(r.provision).not.toBeNull();
    expect(r.provision!.initdbMs).toBe(111);
    expect(r.provision!.provisionedMsBeforeBoot).toBeGreaterThanOrEqual(0);
    expect(r.phases.pgliteCreateMs).toBeNull();
    // Sync disabled → no eager groups in the report.
    expect(r.groups).toHaveLength(0);

    await client.stop();
  });
});
