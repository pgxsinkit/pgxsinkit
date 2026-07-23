// The MINIMAL registry the placement lanes drive (ADR-0049 step 12). These lanes prove the PLACEMENT
// machinery — the probe verdict, election + succession, relocation outcomes, destroy peer-refusal, meta-record
// recognition — NOT sync convergence, so `syncEnabled: false` is the default posture and no Electric/write
// server is contacted. One writable table gives a local-mutation surface adequate to observe a relocation
// outcome; a raw `SELECT` gives a read surface. Copied down to the smallest shape the repo's own worker-bridge
// unit fixture (`tests/unit/worker-one-shot-reads.test.ts`) uses.

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

export const placementRegistry = defineSyncRegistry({
  notes: defineSyncTable({
    tableName: "notes",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      body: varchar("body", { length: 200 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

export type PlacementRegistry = typeof placementRegistry;

/** The dummy sync endpoints — never contacted (`syncEnabled: false`), but `defineSyncWorker` requires them. */
export const PLACEMENT_ELECTRIC_URL = "http://127.0.0.1:4299/electric";
export const PLACEMENT_WRITE_URL = "http://127.0.0.1:4299/api/mutations";
