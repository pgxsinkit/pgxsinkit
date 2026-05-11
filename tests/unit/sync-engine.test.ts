import { buildDemoSyncConfig } from "@pgxsinkit/schema";
import { buildConfiguredShapeSpecs, buildShapeConfig, buildShapeUrl } from "@pgxsinkit/sync-engine";

describe("sync-engine", () => {
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
          name: "projects",
          mode: "readwrite",
          primaryKey: {
            columns: ["id"],
          },
          shape: {
            tableName: "projects",
            shapeKey: "projects-shape",
          },
          routes: {
            basePath: "/api/projects",
            allowBatch: true,
          },
          clientProjection: {
            syncedTable: "projects_local",
            overlayTable: "projects_overlay",
            journalTable: "projects_mutations",
            readModel: "projects_read_model",
          },
        },
        activity_feed: {
          name: "activity_feed",
          mode: "readonly",
          primaryKey: {
            columns: ["id"],
          },
          shape: {
            tableName: "activity_feed",
            shapeKey: "activity-feed-shape",
          },
          clientProjection: {
            syncedTable: "activity_feed_local",
            readModel: "activity_feed_local",
          },
        },
        write_audit: {
          name: "write_audit",
          mode: "writeonly",
          primaryKey: {
            columns: ["id"],
          },
        },
      },
    });

    expect(specs).toHaveLength(2);
    expect(specs.map((spec) => spec.key)).toEqual(["projects", "activity_feed"]);
    expect(specs[0]?.tableName).toBe("projects_local");
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
});
