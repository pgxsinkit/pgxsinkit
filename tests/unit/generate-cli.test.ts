import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import { defineEventStream, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { projectsSyncRegistry } from "@pgxsinkit/schema";

import {
  resolveDrizzleOutDir,
  resolveRegistryModulePath,
  selectRegistryExport,
} from "../../packages/server/src/cli/generate";
import { findMigrationCarrying } from "../../packages/server/src/cli/generate";
import { eventLaneDdlFingerprint, renderEventLaneMigration } from "../../packages/server/src/events/ddl";

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

// `--events --check` (ADR-0053 decision 5): the pre-deploy half of the event-lane artifact. It scans the
// committed migrations for the fingerprint the CURRENT registry's Event streams imply, so adding a stream
// without regenerating fails in CI rather than at the first enqueue onto a queue that does not exist.
describe("pgxsinkit-generate --events drift detection", () => {
  const scratchRoot = mkdtempSync(join(process.cwd(), "tmp", "agents", "generate-cli-"));

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  const issues = defineSyncTable({
    tableName: "gc_issues",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    }),
  });
  const viewed = defineEventStream({
    payload: z.object({ issueId: z.uuid() }).strict(),
    identity: { viewerId: { claimPath: ["sub"] } },
  });
  const aidUsed = defineEventStream({
    payload: z.object({ aid: z.string() }).strict(),
    identity: { viewerId: { claimPath: ["sub"] } },
  });

  function migrationsDirWith(body: string): string {
    const dir = mkdtempSync(join(scratchRoot, "drizzle-"));
    mkdirSync(join(dir, "0000_event_lane_artifact"), { recursive: true });
    writeFileSync(join(dir, "0000_event_lane_artifact", "migration.sql"), body);
    // A sibling folder the scan must skip over rather than trip on.
    mkdirSync(join(dir, "0001_unrelated"), { recursive: true });
    return dir;
  }

  it("passes when a committed migration carries the registry's current event-lane fingerprint", () => {
    const registry = defineSyncRegistry({ tables: { issues }, streams: { board_issue_viewed: viewed } });
    const dir = migrationsDirWith(renderEventLaneMigration(registry));

    expect(findMigrationCarrying(dir, eventLaneDdlFingerprint(registry))).toBe("0000_event_lane_artifact");
  });

  it("fails when an Event stream was added since the migration was generated", () => {
    const before = defineSyncRegistry({ tables: { issues }, streams: { board_issue_viewed: viewed } });
    const after = defineSyncRegistry({
      tables: { issues },
      streams: { board_issue_viewed: viewed, board_aid_used: aidUsed },
    });
    const dir = migrationsDirWith(renderEventLaneMigration(before));

    expect(findMigrationCarrying(dir, eventLaneDdlFingerprint(after))).toBeNull();
  });
});
