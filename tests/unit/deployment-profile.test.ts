import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { createSyncServer } from "@pgxsinkit/server";

// ADR-0030 decision 3: the `deployment` profile owns the startup query posture. The apply function
// verifies ITSELF in-body now (no startup drift query), so the only remaining startup query classes are
// the RLS auth-helper verify (governed by `startupVerification`) and the operations-log presence probe
// (governed by `operationsLog`). The serverless posture — `startupVerification: "deploy-time"` +
// `operationsLog: "disabled"` — must send ZERO queries before the first mutation transaction itself; the
// defaults (`"in-process"` + `"probe"`) must keep issuing them, exactly as before.

// A registry that requires the RLS auth context (an `authClaim` managed field), so `startupVerification`
// "in-process" would run `verifyRlsAuthHelpers` — the class "deploy-time" must skip.
const deploymentRegistry = defineSyncRegistry({
  widgets: defineSyncTable({
    tableName: "dp_widgets",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      title: varchar("title", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    clientProjection: { omitColumns: ["ownerId"] },
    governance: {
      managedFields: [
        { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

type Call = { kind: "execute" | "transaction" | "select" | "insert"; inTx: boolean };

// A counting fake db that records the ORDER of every interaction and whether it happened inside the
// mutation transaction. `execute` returns a row that satisfies both startup probes (an `auth.uid` for
// verifyRlsAuthHelpers, a present `tableName` for ensureOperationsLogSchema) and carries no `mutationId`,
// so the apply-call read yields no conflicts.
function makeCountingDb() {
  const calls: Call[] = [];
  const probeRow = { authUid: "auth.uid", tableName: "public.operations_log" };

  const selectBuilder = () => {
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => builder,
      then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
    };
    return builder;
  };

  const tx = {
    execute: async () => {
      calls.push({ kind: "execute", inTx: true });
      return [];
    },
    select: () => {
      calls.push({ kind: "select", inTx: true });
      return selectBuilder();
    },
    insert: () => ({ values: async () => {} }),
  };

  const db = {
    execute: async () => {
      calls.push({ kind: "execute", inTx: false });
      return [probeRow];
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      calls.push({ kind: "transaction", inTx: false });
      return cb(tx);
    },
    select: () => {
      calls.push({ kind: "select", inTx: false });
      return selectBuilder();
    },
    insert: () => ({ values: async () => {} }),
  };

  return { db, calls };
}

const VALID_UUID = "00000000-0000-4000-8000-000000000001";

function batchRequest() {
  return new Request("http://localhost/api/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mutations: [
        {
          tableName: "widgets",
          kind: "create",
          entityKey: { id: VALID_UUID },
          payload: { id: VALID_UUID, title: "widget" },
          mutationId: VALID_UUID,
          mutationSeq: 1,
          clientTimestampUs: "1000",
        },
      ],
    }),
  });
}

describe("deployment profile — startup query posture (ADR-0030)", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("issues ZERO top-level queries before the mutation transaction under the serverless posture", async () => {
    const { db, calls } = makeCountingDb();

    const server = createSyncServer({
      registry: deploymentRegistry,
      db: db as never,
      resolveAuthClaims: () => ({ sub: VALID_UUID, role: "authenticated" }),
      deployment: { startupVerification: "deploy-time", operationsLog: "disabled" },
    });

    // Construction alone must not touch the db (operationsLog "disabled" ⇒ no presence probe).
    expect(calls).toHaveLength(0);

    const response = await server.fetch(batchRequest());
    expect(response.status).toBe(200);

    // The transaction was entered (a mutation ran)...
    const txIndex = calls.findIndex((call) => call.kind === "transaction");
    expect(txIndex).toBeGreaterThanOrEqual(0);
    // ...and NOTHING queried the db at the top level before it — the first statement a fresh worker sends
    // is the mutation transaction itself.
    const topLevelBeforeTx = calls.slice(0, txIndex).filter((call) => !call.inTx);
    expect(topLevelBeforeTx).toEqual([]);
    // No top-level execute happened at all (no auth-helper verify, no ops-log probe).
    expect(calls.filter((call) => call.kind === "execute" && !call.inTx)).toEqual([]);
  });

  it("keeps issuing the startup queries under the defaults (in-process + probe), as before", async () => {
    const { db, calls } = makeCountingDb();

    const server = createSyncServer({
      registry: deploymentRegistry,
      db: db as never,
      resolveAuthClaims: () => ({ sub: VALID_UUID, role: "authenticated" }),
      // No `deployment` → defaults: startupVerification "in-process", operationsLog "probe".
    });

    // The ops-log probe runs at construction (one top-level execute).
    expect(calls.filter((call) => call.kind === "execute" && !call.inTx)).toHaveLength(1);

    const response = await server.fetch(batchRequest());
    expect(response.status).toBe(200);

    // The RLS auth-helper verify runs before the transaction (a second top-level execute), so a top-level
    // execute precedes the transaction — the pre-ADR-0030 behavior, preserved.
    const txIndex = calls.findIndex((call) => call.kind === "transaction");
    const topLevelExecutesBeforeTx = calls.slice(0, txIndex).filter((call) => call.kind === "execute" && !call.inTx);
    expect(topLevelExecutesBeforeTx.length).toBeGreaterThanOrEqual(1);
  });
});
