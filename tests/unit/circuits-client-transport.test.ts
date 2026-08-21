import { describe, expect, it } from "bun:test";

import { uuid } from "drizzle-orm/pg-core";

import { createSyncClient } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { memoryStoreForTests } from "../../packages/client/src/testing";

// The read transport is resolved ONCE at boot, and an ambiguous answer is refused rather than
// guessed at (ADR-0055). Two transports configured is a contradiction; none is an omission. Either
// way, picking a winner would sync against an ingress the caller never named — which is exactly the
// mistake the native path's ask-don't-construct inversion exists to remove.

const content = defineSyncTable({
  tableName: "offering_content",
  makeColumns: () => ({ id: uuid("id").primaryKey(), offeringId: uuid("offering_id").notNull() }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { scope: (c) => [c.offeringId] },
});

const registry = defineSyncRegistry({ tables: { content } });

const common = {
  registry,
  batchWriteUrl: "http://api/write",
  ...memoryStoreForTests("transport-test"),
};

describe("read transport resolution", () => {
  it("refuses a boot naming both transports", async () => {
    const attempt = createSyncClient({
      ...common,
      electricUrl: "http://electric",
      controlPlaneUrl: "http://api",
      streamBaseUrl: "http://edge",
    });
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(attempt).rejects.toThrow(/both `electricUrl` and `controlPlaneUrl`/);
  });

  it("refuses a boot naming neither", async () => {
    const attempt = createSyncClient({ ...common });
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(attempt).rejects.toThrow(/needs a read path/);
  });

  // The two native options are one transport in two halves, not a URL with an optional extra: the
  // control plane grants stream paths and the edge serves them, and they are separate deployments.
  it("refuses controlPlaneUrl without streamBaseUrl", async () => {
    const attempt = createSyncClient({ ...common, controlPlaneUrl: "http://api" });
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .rejects returns a real promise typed as void
    await expect(attempt).rejects.toThrow(/needs `streamBaseUrl` beside it/);
  });
});
