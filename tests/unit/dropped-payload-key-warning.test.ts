import { describe, expect, it, spyOn } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncTable, type SyncTableEntry } from "@pgxsinkit/contracts";

import { warnOnSilentlyDroppedPayloadKeys } from "../../packages/server/src/mutations/route";

// The apply function reads only a table's PROJECTED columns from the payload jsonb. A non-column payload
// key splits two ways: a projected-away (`omitColumns`) column is 400-REJECTED by request validation (NOT
// dropped), while a genuinely UNKNOWN key is silently ignored by apply. `warnOnSilentlyDroppedPayloadKeys`
// warns — once per (table, key) per process — for the unknown-key case ONLY, never for a projected-away
// column (warning "the write succeeds" then rejecting it was the misleading overlap the review flagged).

// A table with a server-only column kept off the client via clientProjection.omitColumns. `internalFlag`
// is omitted → an explicitly-sent `internalFlag` is 400-rejected by validation, so it must NOT be warned.
function makeEntry(tableName: string): SyncTableEntry {
  return defineSyncTable({
    tableName,
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      internalFlag: varchar("internal_flag", { length: 24 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    clientProjection: { omitColumns: ["internalFlag"] },
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }) as unknown as SyncTableEntry;
}

describe("warnOnSilentlyDroppedPayloadKeys", () => {
  it("does NOT warn for an omitted (projected-away) column — that is 400-rejected, not silently dropped", () => {
    const entry = makeEntry("dropwarn_omitted");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // `internalFlag` is in `omitColumns`, so the write route 400-rejects it via the projected-field
      // check — it is not a silent drop, so no warning (the "drop-warning then rejection" overlap is gone).
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_omitted", "update", { label: "ok", internalFlag: "x" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once for a genuinely-unknown key, then memoizes", () => {
    const entry = makeEntry("dropwarn_memoized");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_memoized", "update", { label: "ok", mystery: "x" });
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, structured] = warn.mock.calls[0]!;
      expect(String(message)).toContain("dropwarn_memoized");
      expect(String(message)).toContain("mystery");
      expect(structured).toEqual({
        table: "dropwarn_memoized",
        droppedKey: "mystery",
        hint: "unknown-non-column-key",
      });

      // Second occurrence of the same (table, key): memoized — no further warning.
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_memoized", "update", { mystery: "y" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("also flags a genuinely-unknown key (a typo the apply path would drop)", () => {
    const entry = makeEntry("dropwarn_typo");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_typo", "create", { id: "x", label: "ok", labell: "typo" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("labell");
    } finally {
      warn.mockRestore();
    }
  });

  it("never warns for a valid payload (only writable columns)", () => {
    const entry = makeEntry("dropwarn_valid");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // `label` is writable; `updatedAtUs` is a managed field (legitimately present); neither is dropped.
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_valid", "update", { label: "ok" });
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_valid", "create", { id: "x", label: "ok" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("never warns for a delete (no payload to apply)", () => {
    const entry = makeEntry("dropwarn_delete");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_delete", "delete", { id: "x", internalFlag: "x" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Kept LAST: it fills the module-level memo set past its cap, which is one-way for the process.
  it("caps the memo set against client-controlled key spray, then suppresses further reports", () => {
    const entry = makeEntry("dropwarn_cap");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A single payload with far more distinct junk keys than the 10_000 cap: each drives one per-key
      // warning until the set is full, then exactly one "suppressed" notice, then silence.
      const spray: Record<string, string> = {};
      for (let i = 0; i < 10_200; i++) {
        spray[`junk_${i}`] = "x";
      }
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_cap", "update", spray);

      const suppression = warn.mock.calls.filter(([m]) => String(m).includes("Dropped-key warnings suppressed"));
      expect(suppression).toHaveLength(1);
      // The cap held: per-key warnings never exceeded the cap (well under the 10_200 keys sprayed).
      const perKey = warn.mock.calls.filter(([m]) => String(m).includes("is not a writable column"));
      expect(perKey.length).toBeLessThanOrEqual(10_000);

      // Past the cap, a brand-new dropped key on another table produces NO further warning.
      warn.mockClear();
      warnOnSilentlyDroppedPayloadKeys(entry, "dropwarn_cap_after", "update", { totallyNew: "y" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
