import { afterEach, describe, expect, it } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { eq } from "drizzle-orm";
import { bigint, QueryBuilder, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  createClientPGlite,
  createSyncClient,
  defineSyncWorker,
  getReadModelView,
  type SyncClient,
  type SyncWorkerHost,
  wrapLiveQueryForMaterialization,
} from "../../packages/client/src/index";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";
import { liveFieldAliases, remapAliasedLiveRow, type SelectedFields } from "../../packages/react/src/remap-live-row";

// The live-query seam bug (root-caused from emergent's first browser+Electric learner e2e lane): a live
// read built from a Drizzle select over a JOIN of two tables sharing a column name (two `title`) compiles
// to a SELECT with duplicate OUTPUT column names — Drizzle emits no aliases, it maps result columns
// positionally. Legal as a plain query, but PGlite's `live` extension MATERIALISES it and fails
// `column "title" specified more than once`; and even a plain query silently collapses both `title`s into
// one value. The seam must render such a query safe to materialise by giving every output column a UNIQUE
// alias. This suite pins the fix through BOTH client paths: in-process `subscribeLiveRows` and the worker
// bridge seam.

// ─── Two tables that share a `title` column, joined ──────────────────────────────────────────────────
const collidingRegistry = defineSyncRegistry({
  course: defineSyncTable({
    tableName: "course",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
  module: defineSyncTable({
    tableName: "module",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      courseId: uuid("course_id").notNull(),
      title: varchar("title", { length: 200 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type CollidingRegistry = typeof collidingRegistry;

const courseRead = getReadModelView(collidingRegistry, "course");
const moduleRead = getReadModelView(collidingRegistry, "module");

const COURSE_ID = "a0000000-0000-0000-0000-000000000000";
const MODULE_ID = "b0000000-0000-0000-0000-000000000000";

/** The colliding joined select — two `title` columns, uniquely aliased by field KEY (Drizzle-consumer style). */
function buildJoinedSelect(client: SyncClient<CollidingRegistry>) {
  return client.drizzle
    .select({ courseTitle: courseRead.title, moduleTitle: moduleRead.title, moduleId: moduleRead.id })
    .from(courseRead)
    .innerJoin(moduleRead, eq(moduleRead.courseId, courseRead.id))
    .orderBy(moduleRead.id);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// ─── Pure helpers: alias derivation, positional remap, and the SQL wrap ──────────────────────────────
describe("live-rows column-collision helpers", () => {
  const issueLike = new QueryBuilder()
    .select({
      courseTitle: courseRead.title,
      nested: { modId: moduleRead.id, modTitle: moduleRead.title },
    })
    .from(courseRead);
  const selectedFields = (issueLike as unknown as { _: { selectedFields: SelectedFields } })._.selectedFields;

  it("derives one unique positional alias per output column, in depth-first field-key order", () => {
    expect(liveFieldAliases(selectedFields)).toEqual(["__pgx_c0", "__pgx_c1", "__pgx_c2"]);
  });

  it("maps an alias-keyed row back onto the select's field keys, preserving nesting", () => {
    const row = { __pgx_c0: "Course A", __pgx_c1: MODULE_ID, __pgx_c2: "Module X" };
    expect(remapAliasedLiveRow(selectedFields, row)).toEqual({
      courseTitle: "Course A",
      nested: { modId: MODULE_ID, modTitle: "Module X" },
    });
  });

  it("returns undefined aliases / an unchanged row for a raw query (no field map)", () => {
    expect(liveFieldAliases(undefined)).toBeUndefined();
    expect(remapAliasedLiveRow(undefined, { foo: 1 })).toEqual({ foo: 1 });
  });

  it("wraps with a positional column-alias-list only when fields are supplied", () => {
    expect(wrapLiveQueryForMaterialization("select a, b", undefined)).toBe("select a, b");
    expect(wrapLiveQueryForMaterialization("select a, b", [])).toBe("select a, b");
    expect(wrapLiveQueryForMaterialization("select a, b", ["__pgx_c0", "__pgx_c1"])).toBe(
      'SELECT * FROM (select a, b) "__pgx_live" ("__pgx_c0", "__pgx_c1")',
    );
  });
});

// ─── In-process seam: `client.subscribeLiveRows` over `pglite.live` ──────────────────────────────────
describe("subscribeLiveRows over a same-named-column JOIN (in-process seam)", () => {
  let client: SyncClient<CollidingRegistry> | undefined;

  afterEach(async () => {
    await client?.stop();
    client = undefined;
  });

  async function bootClient(): Promise<SyncClient<CollidingRegistry>> {
    const active = await createSyncClient({
      registry: collidingRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      // A precreated memory store (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      precreatedPglite: createClientPGlite(memoryStoreForTests("live-collision-inproc")),
    });
    await active.ready;
    await active.tables.course.create({ id: COURSE_ID, title: "Course A" });
    await active.tables.module.create({ id: MODULE_ID, courseId: COURSE_ID, title: "Module X" });
    return active;
  }

  it("the colliding query WITHOUT aliases fails to materialise (documents the pre-fix defect)", async () => {
    client = await bootClient();
    const { sql, params } = buildJoinedSelect(client).toSQL();
    let message = "";
    try {
      await client.subscribeLiveRows({ sql, params }, () => {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("specified more than once");
  });

  it("WITH aliases the subscription materialises, carries BOTH titles distinctly, and fires on write", async () => {
    client = await bootClient();
    const built = buildJoinedSelect(client);
    const { sql, params } = built.toSQL();
    const selectedFields = built._?.selectedFields as SelectedFields;
    const fields = liveFieldAliases(selectedFields);
    expect(fields).toBeDefined();

    const emissions: Array<Array<Record<string, unknown>>> = [];
    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql, params, ...(fields ? { fields } : {}) },
      (rows) => emissions.push(rows.map((row) => remapAliasedLiveRow(selectedFields, row))),
    );

    // Initial snapshot: BOTH same-named columns survive distinctly (the pre-fix collapse loses `courseTitle`).
    const initial = sub.initialRows.map((row) => remapAliasedLiveRow(selectedFields, row));
    expect(initial).toEqual([{ courseTitle: "Course A", moduleTitle: "Module X", moduleId: MODULE_ID }]);

    // The live part: a subsequent write fires the listener with the updated values.
    await client.tables.module.update({ id: MODULE_ID }, { title: "Module X2" });
    await tick();
    expect(emissions.length).toBeGreaterThanOrEqual(1);
    expect(emissions.at(-1)).toEqual([{ courseTitle: "Course A", moduleTitle: "Module X2", moduleId: MODULE_ID }]);

    sub.unsubscribe();
  });
});

// ─── Worker seam: `defineSyncWorker` + `attachSyncClient` over a MessageChannel (no real Worker) ─────
//
// Two duplicate-output-name forms are pinned across the bridge:
// - the single-table form (`{ titleA: t.title, titleB: t.title }` → `select "title", "title"`), which
//   also exercises the ALIASED-PK `live.incrementalQuery` path (pkColumns named in alias space);
// - the two-table JOIN form (the exact shape that surfaced the bug in a consumer), keyless →
//   `live.query` + worker-side diff.
const soloRegistry = defineSyncRegistry({
  item: defineSyncTable({
    tableName: "item",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type SoloRegistry = typeof soloRegistry;
const itemRead = getReadModelView(soloRegistry, "item");
const ITEM_ID = "c0000000-0000-0000-0000-000000000000";

describe("subscribeLiveRows over a duplicate-output-name query (worker bridge seam)", () => {
  let hosts: SyncWorkerHost<SoloRegistry>[] = [];
  let channels: MessageChannel[] = [];

  afterEach(async () => {
    for (const host of hosts) await host.close().catch(() => undefined);
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    hosts = [];
    channels = [];
  });

  async function makeHost(): Promise<SyncWorkerHost<SoloRegistry>> {
    const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
    const host = defineSyncWorker({
      registry: soloRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      // A precreated memory store (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);
    return host;
  }

  async function attach(host: SyncWorkerHost<SoloRegistry>) {
    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    channel.port2.start?.();
    const client = await attachSyncClient({
      registry: soloRegistry,
      port: channel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    return { client };
  }

  /** `select "title", "title", "id"` — a duplicate-output-name query without a join (field keys stay unique). */
  function buildDuplicateSelect(client: SyncClient<SoloRegistry>) {
    return client.drizzle
      .select({ titleA: itemRead.title, titleB: itemRead.title, id: itemRead.id })
      .from(itemRead)
      .orderBy(itemRead.id);
  }

  it("the duplicate-name query WITHOUT aliases fails to materialise across the bridge (pre-fix defect)", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;
    await client.tables.item.create({ id: ITEM_ID, title: "Item A" });

    const { sql, params } = buildDuplicateSelect(client).toSQL();
    // try/catch (not `expect().rejects`) — a MessageChannel-driven rejection does not settle the bun matcher
    // here, the same quirk the sibling worker-bridge tests call out.
    let message = "";
    try {
      await client.subscribeLiveRows({ sql, params }, () => {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("specified more than once");
  });

  it("WITH aliases the subscription materialises across the bridge, keeps both keys, and diffs on write", async () => {
    const host = await makeHost();
    const { client } = await attach(host);
    await client.ready;
    await client.tables.item.create({ id: ITEM_ID, title: "Item A" });

    const built = buildDuplicateSelect(client);
    const { sql, params } = built.toSQL();
    const selectedFields = built._?.selectedFields as SelectedFields;
    const fields = liveFieldAliases(selectedFields);
    expect(fields).toEqual(["__pgx_c0", "__pgx_c1", "__pgx_c2"]);
    // PK named in ALIAS space (`id` was renamed to its positional alias `__pgx_c2` by the wrap) — the
    // documented contract when `fields` is supplied — drives the worker's `live.incrementalQuery` path
    // against the wrapped SQL (single relation, so free of the worker engine's JOIN-live-query quirk).
    const pkColumns = [fields![2]!];

    const emissions: Array<Array<Record<string, unknown>>> = [];
    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql, params, ...(fields ? { fields } : {}), pkColumns },
      (rows) => emissions.push(rows.map((row) => remapAliasedLiveRow(selectedFields, row))),
    );

    // The subscription materialising at all proves the bridge forwarded the additive `fields` and the worker
    // wrapped the SQL — without them the worker's `live.incrementalQuery` would have thrown the duplicate-name
    // materialisation error back across the bridge (the sibling test asserts exactly that failure).
    // Both same-named output columns survive as distinct keys (pre-fix: a hard materialisation failure).
    const initial = sub.initialRows.map((row) => remapAliasedLiveRow(selectedFields, row));
    expect(initial).toEqual([{ titleA: "Item A", titleB: "Item A", id: ITEM_ID }]);

    // The live part: a subsequent write fires the listener with the updated values.
    await client.tables.item.update({ id: ITEM_ID }, { title: "Item A2" });
    await tick();
    expect(emissions.length).toBeGreaterThanOrEqual(1);
    expect(emissions.at(-1)).toEqual([{ titleA: "Item A2", titleB: "Item A2", id: ITEM_ID }]);

    // No drain tick needed: the host awaits the worker-side live-query teardown before closing PGlite
    // (ADR-0040 decision 1), so the afterEach `host.close()` can no longer race a still-registered query.
    sub.unsubscribe();
  });
});

// ─── Worker seam, JOIN form: the exact consumer shape that surfaced the bug ──────────────────────────
describe("subscribeLiveRows over a same-named-column JOIN (worker bridge seam)", () => {
  let hosts: SyncWorkerHost<CollidingRegistry>[] = [];
  let channels: MessageChannel[] = [];

  afterEach(async () => {
    for (const host of hosts) await host.close().catch(() => undefined);
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    hosts = [];
    channels = [];
  });

  it("WITH aliases a keyless JOIN materialises across the bridge, carries BOTH titles, and fires on write", async () => {
    const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
    const host = defineSyncWorker({
      registry: collidingRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      // A precreated memory store (test only) — acknowledge it past the BYO refusal (ADR-0036).
      ...testStoreAcknowledgment(),
      precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    hosts.push(host);
    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    channel.port2.start?.();
    const client = await attachSyncClient({
      registry: collidingRegistry,
      port: channel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;
    await client.tables.course.create({ id: COURSE_ID, title: "Course A" });
    await client.tables.module.create({ id: MODULE_ID, courseId: COURSE_ID, title: "Module X" });

    const built = buildJoinedSelect(client);
    const { sql, params } = built.toSQL();
    const selectedFields = built._?.selectedFields as SelectedFields;
    const fields = liveFieldAliases(selectedFields);
    expect(fields).toEqual(["__pgx_c0", "__pgx_c1", "__pgx_c2"]);

    const emissions: Array<Array<Record<string, unknown>>> = [];
    // Keyless (no pkColumns) → the worker's `live.query` + value-identity diff path over the wrapped SQL.
    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql, params, ...(fields ? { fields } : {}) },
      (rows) => emissions.push(rows.map((row) => remapAliasedLiveRow(selectedFields, row))),
    );

    const initial = sub.initialRows.map((row) => remapAliasedLiveRow(selectedFields, row));
    expect(initial).toEqual([{ courseTitle: "Course A", moduleTitle: "Module X", moduleId: MODULE_ID }]);

    await client.tables.module.update({ id: MODULE_ID }, { title: "Module X2" });
    await tick();
    expect(emissions.length).toBeGreaterThanOrEqual(1);
    expect(emissions.at(-1)).toEqual([{ courseTitle: "Course A", moduleTitle: "Module X2", moduleId: MODULE_ID }]);

    // No drain tick needed post-fix (ADR-0040 decision 1): `host.close()` awaits the teardown itself.
    sub.unsubscribe();
  });
});
