import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";

import { projectsSyncRegistry } from "@pgxsinkit/schema";

import {
  resolveDrizzleOutDir,
  resolveRegistryModulePath,
  selectRegistryExport,
} from "../../packages/server/src/cli/generate";

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

describe("pgxsinkit-generate output directory resolution", () => {
  it("honors an explicit absolute --out unchanged", async () => {
    expect(await resolveDrizzleOutDir(".", undefined, "/abs/migrations")).toBe("/abs/migrations");
  });

  it("resolves a relative --out against the project directory", async () => {
    expect(await resolveDrizzleOutDir("packages/db", undefined, "drizzle-out")).toBe(
      join(process.cwd(), "packages/db", "drizzle-out"),
    );
  });

  it("derives the output directory from a drizzle config's `out` field (non-default location)", async () => {
    // A real external consumer whose migrations live somewhere non-standard only declares it once,
    // in the drizzle config; the generator must not force them to repeat the path. The board's own
    // config points at infra/board-drizzle.
    expect(await resolveDrizzleOutDir(".", "infra/board-drizzle.config.ts")).toBe(
      join(process.cwd(), "infra/board-drizzle"),
    );
  });
});
