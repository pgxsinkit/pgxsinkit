import { describe, expect, it } from "bun:test";

import { buildDemoSyncConfig } from "@pgxsinkit/schema";

import {
  buildConfiguredShapeSpecs,
  buildShapeConfig,
  buildShapeUrl,
  startConfiguredSync,
} from "../../packages/client/src/shape-sync";

describe("shape sync", () => {
  it("builds a shape URL with the table parameter", () => {
    expect(buildShapeUrl("http://localhost:3000/v1/shape", "todos")).toBe("http://localhost:3000/v1/shape?table=todos");
  });

  it("builds a generic shape config using separate local and Electric tables", () => {
    const config = buildShapeConfig({
      electricUrl: "http://localhost:3000/v1/shape",
      tableName: "projects_local",
      schema: "workspace_local",
      electricTable: "projects",
      shapeKey: "projects-shape",
      primaryKey: ["id"],
    });

    expect(config.table).toBe("projects_local");
    expect(config.schema).toBe("workspace_local");
    expect(config.shape.url).toContain("table=projects");
    expect(config.primaryKey).toEqual(["id"]);
  });

  it("builds configured sync specs and skips writeonly tables", () => {
    const specs = buildConfiguredShapeSpecs({
      electricUrl: "http://localhost:3000/v1/shape",
      localSchema: "workspace_local",
      tables: {
        projects: {
          mode: "readwrite",
          primaryKey: {
            columns: ["id"],
          },
          shape: {
            tableName: "projects",
            shapeKey: "projects-shape",
          },
        },
        activity_feed: {
          mode: "readonly",
          primaryKey: {
            columns: ["id"],
          },
          shape: {
            tableName: "activity_feed",
            shapeKey: "activity-feed-shape",
          },
        },
        write_audit: {
          mode: "writeonly",
          primaryKey: {
            columns: ["id"],
          },
        },
      },
    });

    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => spec.key)).toEqual(["projects", "activity_feed"]);
    expect(specs[0]?.tableName).toBe("projects");
    expect(specs[0]?.schema).toBe("workspace_local");
    expect(specs[1]?.electricTable).toBe("activity_feed");
  });

  it("builds configured sync specs from the shared demo config", () => {
    const specs = buildConfiguredShapeSpecs(buildDemoSyncConfig("http://localhost:3000/v1/shape"));

    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => spec.key)).toEqual(["authors", "todos"]);
    expect(specs[0]?.tableName).toBe("authors");
    expect(specs[1]?.tableName).toBe("todos");
  });

  it("buckets tables sharing a consistency group onto one MultiShapeStream (ADR-0009 decision 2)", async () => {
    const calls: Array<{ key: string | null; shapeNames: string[] }> = [];
    const namespace = {
      initMetadataTables: async () => {},
      syncShapesToTables: async (opts: {
        key: string | null;
        shapes: Record<string, unknown>;
        onInitialSync?: () => void;
      }) => {
        calls.push({ key: opts.key, shapeNames: Object.keys(opts.shapes).sort() });
        opts.onInitialSync?.();
        return { unsubscribe: () => {}, isUpToDate: true, streams: {} };
      },
    };
    const pg = { electric: namespace } as unknown as Parameters<typeof startConfiguredSync>[0];

    const tableSyncs: string[] = [];
    let initialSyncCount = 0;
    const result = await startConfiguredSync(pg, {
      onTableInitialSync: (key) => tableSyncs.push(key),
      onInitialSync: () => (initialSyncCount += 1),
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          discussion: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "discussion", shapeKey: "discussion-shape" },
            consistencyGroup: "forum",
          },
          post: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "post", shapeKey: "post-shape" },
            consistencyGroup: "forum",
          },
          profile: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "profile", shapeKey: "profile-shape" },
          },
        },
      },
    });

    // The forum group (discussion + post) syncs on one stream keyed by the group; profile is its
    // own singleton keyed by its shapeKey.
    expect(calls).toHaveLength(2);
    expect(calls.find((call) => call.key === "forum")?.shapeNames).toEqual(["discussion", "post"]);
    expect(calls.find((call) => call.key === "profile-shape")?.shapeNames).toEqual(["profile"]);

    // Every member table is exposed and the per-table / global initial-sync callbacks all fire.
    expect(Object.keys(result.tables).sort()).toEqual(["discussion", "post", "profile"]);
    expect(tableSyncs.sort()).toEqual(["discussion", "post", "profile"]);
    expect(initialSyncCount).toBe(1);
  });

  it("attaches a per-shape onError auth-recovery handler to every shape (ADR-0013 Phase 2)", async () => {
    const capturedShapes: Record<string, { shape: { onError?: unknown } }> = {};
    const namespace = {
      initMetadataTables: async () => {},
      syncShapesToTables: async (opts: {
        shapes: Record<string, { shape: { onError?: unknown } }>;
        onInitialSync?: () => void;
      }) => {
        Object.assign(capturedShapes, opts.shapes);
        opts.onInitialSync?.();
        return { unsubscribe: () => {}, isUpToDate: true, streams: {} };
      },
    };
    const pg = { electric: namespace } as unknown as Parameters<typeof startConfiguredSync>[0];

    await startConfiguredSync(pg, {
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          projects: {
            mode: "readwrite",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "projects", shapeKey: "projects-shape" },
          },
        },
      },
    });

    // The per-shape onError (the only onError that can request a retry) must be wired so a 401/403
    // recovers the read path instead of permanently stopping it.
    expect(typeof capturedShapes["projects"]?.shape.onError).toBe("function");
  });

  it("holds a lazy group out of the eager boot set, and starts it on demand (ADR-0021)", async () => {
    const calls: Array<string | null> = [];
    const namespace = {
      initMetadataTables: async () => {},
      syncShapesToTables: async (opts: { key: string | null; onInitialSync?: () => void }) => {
        calls.push(opts.key);
        opts.onInitialSync?.();
        return { unsubscribe: () => {}, isUpToDate: true, streams: {} };
      },
    };
    const pg = { electric: namespace } as unknown as Parameters<typeof startConfiguredSync>[0];

    let initialSyncCount = 0;
    const result = await startConfiguredSync(pg, {
      onInitialSync: () => (initialSyncCount += 1),
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          profile: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "profile", shapeKey: "profile-shape" },
          },
          archive: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "archive", shapeKey: "archive-shape" },
            subscription: "lazy",
          },
        },
      },
    });

    // Boot starts ONLY the eager group; the lazy group is held (not subscribed), and boot readiness
    // fires off the eager group alone.
    expect(calls).toEqual(["profile-shape"]);
    expect(initialSyncCount).toBe(1);

    // Both tables are exposed; the lazy one reports not-up-to-date / not-started until it is started.
    expect(Object.keys(result.tables).sort()).toEqual(["archive", "profile"]);
    expect(result.tables["profile"]?.isUpToDate).toBe(true);
    expect(result.tables["archive"]?.isUpToDate).toBe(false);
    expect(result.isTableStarted("profile")).toBe(true);
    expect(result.isTableStarted("archive")).toBe(false);

    // The lazy table's group is discoverable and starts on demand, after which it reports up-to-date —
    // without re-firing the boot gate.
    expect(result.groupKeyForTable("archive")).toBe("archive-shape");
    await result.ensureGroupStarted("archive-shape");
    expect(calls).toHaveLength(2);
    expect(calls).toContain("archive-shape");
    expect(result.tables["archive"]?.isUpToDate).toBe(true);
    expect(result.isTableStarted("archive")).toBe(true);
    expect(initialSyncCount).toBe(1);

    // Single-flight / idempotent: starting it again does not re-subscribe.
    await result.ensureGroupStarted("archive-shape");
    expect(calls.filter((key) => key === "archive-shape")).toHaveLength(1);
  });

  it("promotes a previously-activated lazy+persistent group into the eager boot set (ADR-0021 §2)", async () => {
    const calls: Array<string | null> = [];
    const namespace = {
      initMetadataTables: async () => {},
      syncShapesToTables: async (opts: { key: string | null; onInitialSync?: () => void }) => {
        calls.push(opts.key);
        opts.onInitialSync?.();
        return { unsubscribe: () => {}, isUpToDate: true, streams: {} };
      },
    };
    const pg = { electric: namespace } as unknown as Parameters<typeof startConfiguredSync>[0];

    let initialSyncCount = 0;
    const result = await startConfiguredSync(pg, {
      onInitialSync: () => (initialSyncCount += 1),
      // archive was activated on a prior boot → promoted back to eager this boot.
      promotedGroups: new Set(["archive-shape"]),
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          profile: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "profile", shapeKey: "profile-shape" },
          },
          archive: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "archive", shapeKey: "archive-shape" },
            subscription: "lazy",
          },
        },
      },
    });

    // Both the eager profile AND the promoted-lazy archive start at boot, and both count toward the gate.
    expect(calls).toHaveLength(2);
    expect(calls).toContain("archive-shape");
    expect(calls).toContain("profile-shape");
    expect(result.isTableStarted("archive")).toBe(true);
    expect(initialSyncCount).toBe(1);
  });

  it("persists a lazy+persistent activation on first on-demand start, but never a lazy+ephemeral one (ADR-0021 §2)", async () => {
    const namespace = {
      initMetadataTables: async () => {},
      syncShapesToTables: async (opts: { onInitialSync?: () => void }) => {
        opts.onInitialSync?.();
        return { unsubscribe: () => {}, isUpToDate: true, streams: {} };
      },
    };
    const pg = { electric: namespace } as unknown as Parameters<typeof startConfiguredSync>[0];

    const activated: string[] = [];
    const result = await startConfiguredSync(pg, {
      onLazyActivated: (groupKey) => activated.push(groupKey),
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          durable: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "durable", shapeKey: "durable-shape" },
            subscription: "lazy",
            retention: "persistent",
          },
          scratch: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "scratch", shapeKey: "scratch-shape" },
            subscription: "lazy",
            retention: "ephemeral",
          },
        },
      },
    });

    // The durable lazy group persists its activation; the ephemeral one is session-scoped and never does.
    await result.ensureGroupStarted("durable-shape");
    await result.ensureGroupStarted("scratch-shape");
    expect(activated).toEqual(["durable-shape"]);
  });
});
