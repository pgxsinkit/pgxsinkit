import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { startCircuitsSync } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, p, type StreamEnvelope } from "@pgxsinkit/contracts";
import {
  barrierPath,
  createBarrierHandler,
  createRefreshHandler,
  createSubscribeHandler,
  importStreamTokenKey,
  refreshPath,
  subscribePath,
  type CircuitsEngineClient,
  type EntitlementSet,
} from "@pgxsinkit/server";

import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Native consistency-group orchestration against the REAL control-plane handlers: derive groups from
// the registry, subscribe each, and let the shared tier fan out. The property this exists for is the
// one fan-out creates and nothing else in the stack tests — every scope of a shape shares ONE local
// table, so a must-refetch on one scope must not take the others' rows with it.

const key = await importStreamTokenKey("group-sync-test-secret");
const METADATA_SCHEMA = "pgxsinkit";

const contentEntry = defineSyncTable({
  tableName: "offering_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    body: text("body").notNull(),
    published: boolean("published").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: { scope: (c) => [c.offeringId], where: (c) => p.eq(c.published, true) },
});

const registry = defineSyncRegistry({ tables: { content: contentEntry } });
const content = contentEntry.localTable;

const OFF_A = "11111111-1111-4111-8111-111111111111";
const OFF_B = "22222222-2222-4222-8222-222222222222";
const ROW_A1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ROW_A2 = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const ROW_B1 = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

function envelope(id: string, offeringId: string): StreamEnvelope {
  return {
    type: "offering_content",
    key: id,
    value: { id, offering_id: offeringId, body: `body-${id}`, published: true },
    headers: { operation: "upsert" },
  };
}

function entitlements(held: readonly string[]): EntitlementSet {
  return {
    ready: true,
    permits: (subject, shapeKey, scope) =>
      subject === "person-a" && shapeKey === "offering_content" && held.includes(String(scope[0])),
    scopesFor: (subject, shapeKey) =>
      subject === "person-a" && shapeKey === "offering_content" ? held.map((one) => [one]) : [],
  };
}

/**
 * A stub engine whose stream paths carry a generation prefix.
 *
 * That prefix is what makes a second boot a genuine re-subscribe: the control plane hands back a
 * DIFFERENT path for the same shape, which is exactly the native must-refetch trigger (ADR-0056
 * decision 7). A counter that restarted at 1 would hand back the same paths and test nothing.
 */
function stubEngine(generation: string): CircuitsEngineClient {
  let next = 0;
  const scopeOf = (request: { where?: unknown }) => JSON.stringify(request.where ?? {});
  const assigned = new Map<string, string>();
  return {
    createShape: async (request) => {
      const fingerprint = scopeOf(request);
      let path = assigned.get(fingerprint);
      if (path === undefined) {
        next += 1;
        path = `shape/${generation}${next}`;
        assigned.set(fingerprint, path);
      }
      return { shapeId: path, table: request.table, streamPath: path, streamUrl: `http://ds/${path}` };
    },
    releaseShape: async () => {},
    replicationState: async () => ({ lsn: "0/0", sync: true, pendingFlips: 0 }),
  } as CircuitsEngineClient;
}

/**
 * One fetch covering both planes: the real control-plane handlers, and a durable-streams stub for
 * the edge. `byOffering` decides what each stream carries — the router reads the offering out of the
 * grant order rather than the path, so a test names data by scope instead of by generated id.
 */
function router(options: {
  engine: CircuitsEngineClient;
  held: readonly string[];
  byOffering: Record<string, StreamEnvelope[]>;
}): typeof fetch {
  const shared = { registry, engine: options.engine, entitlements: entitlements(options.held), key };
  const subscribe = createSubscribeHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const refresh = createRefreshHandler({ ...shared, resolveAuthClaims: () => ({ sub: "person-a" }) });
  const barrier = createBarrierHandler({ engine: options.engine, resolveAuthClaims: () => ({ sub: "person-a" }) });

  // streamPath -> offering, learned from the grants the control plane just issued.
  const offeringByPath = new Map<string, string>();

  return (async (url: string, init?: RequestInit) => {
    const request = new Request(url, init);
    const path = new URL(url).pathname;

    if (path === subscribePath) {
      const response = await subscribe(request);
      // Read the body ONCE and re-wrap it. `clone()` tees the stream, and a tee whose halves are
      // consumed at different times is a deadlock waiting to happen in a test that then waits on the
      // consumer it starved.
      const text = await response.text();
      const body = JSON.parse(text) as { granted?: { scope?: string[]; streamPath: string }[] };
      for (const grant of body.granted ?? []) {
        if (grant.scope?.[0] != null) offeringByPath.set(grant.streamPath, grant.scope[0]);
      }
      return new Response(text, { status: response.status, headers: response.headers });
    }
    if (path === refreshPath) return refresh(request);
    if (path === barrierPath) return barrier(request);

    const streamPath = path.replace(/^\/+/, "");
    const offering = offeringByPath.get(streamPath);
    const envelopes = offering != null ? (options.byOffering[offering] ?? []) : [];
    return new Response(JSON.stringify(envelopes), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Stream-Next-Offset": "0000000000000001",
        "Stream-Up-To-Date": "true",
      },
    });
  }) as unknown as typeof fetch;
}

const base = {
  registry,
  controlPlaneUrl: "http://api",
  streamBaseUrl: "http://edge",
  metadataSchema: METADATA_SCHEMA,
  live: false as const,
};

async function settle(): Promise<void> {
  await Bun.sleep(150);
}

describe("circuits group sync", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createFreshTestPGlite();
    await createTablesFromSchema(pg, { content });
    await migrateSubscriptionMetadataTables({ pg, metadataSchema: METADATA_SCHEMA });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("fans one shared shape out to a stream per entitled scope, into one table", async () => {
    const sync = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: stubEngine("a"),
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();

    const rows = await drizzleOver(pg).select({ id: content.id, offeringId: content.offeringId }).from(content);
    expect(rows.map((r) => r.offeringId).sort()).toEqual([OFF_A, OFF_B].sort());
    expect(sync.groupKeys()).toEqual(["offering_content"]);
    expect(sync.isTableStarted("content")).toBe(true);

    sync.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // The whole reason a fan-out needs a scoped clear. Both scopes are re-subscribed onto NEW stream
  // paths, so both must-refetch; if either clear truncated the table rather than its own scope, the
  // other's rows would be gone.
  //
  // Drop the derived `onMustRefetch` and this does not merely lose rows — the group is REFUSED at
  // construction, because a fan-out always shares a table and `assertScopedClearsForSharedTables`
  // makes the scoped clear structurally mandatory rather than conventional.
  it("clears only its own scope on a must-refetch", async () => {
    const first = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: stubEngine("a"),
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A1, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();
    first.unsubscribe();

    // A fresh generation of stream paths: every grant's handle differs from the persisted one, so
    // every scope re-snapshots. Scope A's content CHANGES (A1 -> A2) so a stale row would show.
    const second = await startCircuitsSync(pg, {
      ...base,
      fetch: router({
        engine: stubEngine("b"),
        held: [OFF_A, OFF_B],
        byOffering: { [OFF_A]: [envelope(ROW_A2, OFF_A)], [OFF_B]: [envelope(ROW_B1, OFF_B)] },
      }),
    });
    await settle();

    const rows = await drizzleOver(pg).select({ id: content.id }).from(content);
    // A's old row is gone, A's new row landed, and B — cleared by its OWN scope only — still has its row.
    expect(rows.map((r) => r.id).sort()).toEqual([ROW_A2, ROW_B1].sort());

    second.unsubscribe();
    await drizzleOver(pg).delete(content);
  });

  // A boot must not hang on an entitlement the subject simply does not hold.
  it("reports ready when the subject is granted nothing", async () => {
    const refused: string[] = [];
    const sync = await startCircuitsSync(pg, {
      ...base,
      onRefused: (entries) => refused.push(...entries.map((entry) => entry.reason)),
      fetch: router({ engine: stubEngine("c"), held: [], byOffering: {} }),
    });

    expect(refused).toEqual(["no entitled scopes"]);
    expect(sync.isGroupReady("offering_content")).toBe(true);
    await sync.groupReady("offering_content");

    sync.unsubscribe();
  });
});
