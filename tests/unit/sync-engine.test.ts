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
});
