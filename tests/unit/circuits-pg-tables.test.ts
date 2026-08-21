import { describe, expect, it } from "bun:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";
import {
  demoMembershipSyncRegistry,
  demoSyncRegistry,
  fkSyncRegistry,
  membershipFanoutSyncRegistry,
  projectsSyncRegistry,
  rlsSyncRegistry,
} from "@pgxsinkit/schema";

import { circuitsPgTablesEnv, resolveCircuitsPgTables } from "../../scripts/lib";

// The Circuits engine takes an EXPLICIT table list (`ELECTRIC_CIRCUITS_PG_TABLES`): it introspects each
// named table, sets REPLICA IDENTITY FULL on it, and its pgoutput decoder drops changes for any relation
// that is not on the list. The lane runners DERIVE that list from the registries the lanes exercise
// rather than requiring `PGXSINKIT_CIRCUITS_PG_TABLES` from a developer's `.env` — these tests pin the
// derivation, the override, and the two invariants an override could otherwise break.

/**
 * The expected union, assembled here from the registries themselves rather than from the helper.
 * `demoMembershipSyncRegistry` deliberately overlaps the others (it is `demoSyncRegistry` plus the
 * membership fan-out entries), so this list only equals the derived one if de-duplication happens.
 */
const laneRegistries = [
  demoSyncRegistry,
  demoMembershipSyncRegistry,
  projectsSyncRegistry,
  fkSyncRegistry,
  rlsSyncRegistry,
  membershipFanoutSyncRegistry,
];

const laneTableNames = laneRegistries.flatMap((registry) =>
  Object.values(registry as SyncTableRegistry).map((entry) => getTableConfig(entry.table).name),
);

const expectedTables = [...new Set(laneTableNames)].sort();

describe("resolveCircuitsPgTables", () => {
  it("derives the union of the lane registries' tables, sorted and de-duplicated", () => {
    const tables = resolveCircuitsPgTables({});

    expect(tables).toEqual(expectedTables);
    expect(tables).toEqual([...tables].sort());
    expect(new Set(tables).size).toBe(tables.length);
    // De-duplication is load-bearing, not incidental: the raw walk repeats tables.
    expect(laneTableNames.length).toBeGreaterThan(tables.length);
    // The engine's other invariant: an explicit list is never empty.
    expect(tables.length).toBeGreaterThan(0);
  });

  it("names every table the harness migrations create for the lane registries", () => {
    // Spelled out so a registry change that silently widens or narrows the engine's replication set
    // fails here rather than in a container lane.
    expect(resolveCircuitsPgTables({})).toEqual([
      "authors",
      "fk_children",
      "fk_parents",
      "projects",
      "rls_todos",
      "todos",
      "work_items",
      "workspace_members",
      "workspaces",
    ]);
  });

  it("lets PGXSINKIT_CIRCUITS_PG_TABLES win when set", () => {
    expect(resolveCircuitsPgTables({ PGXSINKIT_CIRCUITS_PG_TABLES: "beta,alpha" })).toEqual(["alpha", "beta"]);
  });

  it("normalizes an override the same way — trimmed, sorted, de-duplicated", () => {
    expect(resolveCircuitsPgTables({ PGXSINKIT_CIRCUITS_PG_TABLES: " gamma , alpha,gamma , beta " })).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("falls back to the derived list when the override is blank", () => {
    expect(resolveCircuitsPgTables({ PGXSINKIT_CIRCUITS_PG_TABLES: "   " })).toEqual(expectedTables);
  });

  it("refuses `*` — the one value that would make the engine replicate everything in public", () => {
    expect(() => resolveCircuitsPgTables({ PGXSINKIT_CIRCUITS_PG_TABLES: "*" })).toThrow(/must name tables explicitly/);
    expect(() => resolveCircuitsPgTables({ PGXSINKIT_CIRCUITS_PG_TABLES: "todos,*" })).toThrow(
      /must name tables explicitly/,
    );
  });

  it("refuses an override that names no tables", () => {
    expect(() => resolveCircuitsPgTables({ PGXSINKIT_CIRCUITS_PG_TABLES: " , , " })).toThrow(/names no tables/);
  });
});

describe("circuitsPgTablesEnv", () => {
  it("renders the derived list as the compose variable the engine service reads", () => {
    expect(circuitsPgTablesEnv({})).toEqual({ PGXSINKIT_CIRCUITS_PG_TABLES: expectedTables.join(",") });
  });

  it("carries an override through unchanged apart from normalization", () => {
    expect(circuitsPgTablesEnv({ PGXSINKIT_CIRCUITS_PG_TABLES: "todos, authors" })).toEqual({
      PGXSINKIT_CIRCUITS_PG_TABLES: "authors,todos",
    });
  });
});
