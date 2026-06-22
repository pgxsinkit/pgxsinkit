import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { resolveRegistryModulePath, selectRegistryExport } from "../../packages/server/src/cli/generate";

describe("pgxsinkit-generate registry loading", () => {
  it("loads the conventional named registry export used by the getting-started guide", () => {
    const registry = projectsSyncRegistry;

    expect(selectRegistryExport({ registry })).toBe(registry);
  });

  it("loads an explicitly selected registry export", () => {
    const selected = projectsSyncRegistry;

    expect(selectRegistryExport({ firstRegistry: {}, selected }, "selected")).toBe(selected);
  });

  it("reports available exports when an explicit registry export is missing", () => {
    expect(() => selectRegistryExport({ firstRegistry: {}, secondRegistry: {} }, "missing")).toThrow(
      /Available exports: firstRegistry, secondRegistry/,
    );
  });

  it("resolves the registry from the invocation cwd, independently of the migration project directory", () => {
    expect(resolveRegistryModulePath("./sync-registry.ts", "/workspace/app")).toBe(
      resolve("/workspace/app", "sync-registry.ts"),
    );
  });
});
