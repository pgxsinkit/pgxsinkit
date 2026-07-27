import { describe, expect, it } from "bun:test";

import { bigint, boolean, jsonb, uuid, varchar } from "drizzle-orm/pg-core";

import {
  canonicalizeRegistry,
  defineSyncRegistry,
  defineSyncTable,
  fingerprintRegistry,
  hashString,
} from "@pgxsinkit/contracts";

// The registry fingerprint (ADR-0004): the single "has the shape changed" signal,
// consumed by ADR-0006. Order-independent, shape-sensitive, function-free.

const items = () =>
  defineSyncTable({
    tableName: "items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    }),
    clientProjection: { omitColumns: [] },
  });

const notes = () =>
  defineSyncTable({
    tableName: "notes",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      body: varchar("body", { length: 200 }).notNull(),
    }),
    clientProjection: { omitColumns: [] },
  });

describe("registry fingerprint (ADR-0004)", () => {
  it("is stable for the same shape", () => {
    expect(fingerprintRegistry(defineSyncRegistry({ items: items() }))).toBe(
      fingerprintRegistry(defineSyncRegistry({ items: items() })),
    );
  });

  it("is independent of table declaration order", () => {
    const ab = defineSyncRegistry({ items: items(), notes: notes() });
    const ba = defineSyncRegistry({ notes: notes(), items: items() });
    expect(fingerprintRegistry(ba)).toBe(fingerprintRegistry(ab));
  });

  it("changes when a table's consistency group changes (ADR-0009 decision 2)", () => {
    const ungrouped = defineSyncRegistry({ items: items() });
    const grouped = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          title: varchar("title", { length: 120 }).notNull(),
        }),
        clientProjection: { omitColumns: [] },
        consistencyGroup: "forum",
      }),
    });

    expect(fingerprintRegistry(grouped)).not.toBe(fingerprintRegistry(ungrouped));
    // The canonical form carries the group so the diff gate can see the move.
    expect(canonicalizeRegistry(grouped)[0]?.consistencyGroup).toBe("forum");
    expect(canonicalizeRegistry(ungrouped)[0]?.consistencyGroup).toBeNull();
  });

  it("changes when retention flips (the cluster DDL changes), but NOT when only subscription does (ADR-0021)", () => {
    const make = (extra: { subscription?: "eager" | "lazy"; retention?: "persistent" | "ephemeral" }) =>
      defineSyncRegistry({
        items: defineSyncTable({
          tableName: "items",
          makeColumns: () => ({
            id: uuid("id").primaryKey(),
            title: varchar("title", { length: 120 }).notNull(),
          }),
          clientProjection: { omitColumns: [] },
          ...extra,
        }),
      });

    const persistent = make({});
    const ephemeral = make({ retention: "ephemeral" });
    // Retention is a TEMP-vs-durable DDL change → must shift the fingerprint (force a rebuild).
    expect(fingerprintRegistry(ephemeral)).not.toBe(fingerprintRegistry(persistent));
    expect(canonicalizeRegistry(persistent)[0]?.retention).toBe("persistent");
    expect(canonicalizeRegistry(ephemeral)[0]?.retention).toBe("ephemeral");

    // Subscription timing is pure runtime orchestration over identical tables → fingerprint unchanged.
    expect(fingerprintRegistry(make({ subscription: "lazy" }))).toBe(
      fingerprintRegistry(make({ subscription: "eager" })),
    );
  });

  it("does NOT change when only write-mode flips (runtime flush-routing, no DDL — ADR-0022)", () => {
    // Write-mode (like subscription) is pure runtime orchestration over identical tables: a pessimistic
    // unit flush-routes to a different endpoint, but provisions no different local DDL. So flipping it
    // must NOT shift the fingerprint (no cache rebuild / subscription reset). Excluded from the canonical form.
    const seats = (writeMode: "optimistic" | "pessimistic") =>
      defineSyncRegistry({
        seats: defineSyncTable({
          tableName: "seats",
          makeColumns: () => ({
            id: uuid("id").primaryKey(),
            updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
          }),
          mode: "readwrite",
          conflictPolicy: "last-write-wins",
          writeMode,
          governance: {
            managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
          },
        }),
      });

    expect(fingerprintRegistry(seats("pessimistic"))).toBe(fingerprintRegistry(seats("optimistic")));
    expect(canonicalizeRegistry(seats("pessimistic"))[0]).not.toHaveProperty("writeMode");
  });

  it("changes when a column is added", () => {
    const base = defineSyncRegistry({ items: items() });
    const widened = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          title: varchar("title", { length: 120 }).notNull(),
          done: boolean("done").notNull().default(false),
        }),
        clientProjection: { omitColumns: [] },
      }),
    });

    expect(fingerprintRegistry(widened)).not.toBe(fingerprintRegistry(base));
  });

  it("excludes functions (rowTransform) from the fingerprint", () => {
    const withoutTransform = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), data: jsonb("data").$type<Record<string, unknown>>() }),
        clientProjection: { omitColumns: [] },
      }),
    });
    const withTransform = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), data: jsonb("data").$type<Record<string, unknown>>() }),
        clientProjection: { omitColumns: [] },
        serverProjection: { rowTransform: (row) => row },
      }),
    });

    expect(fingerprintRegistry(withTransform)).toBe(fingerprintRegistry(withoutTransform));
  });

  it("changes when a static row filter is swapped, but not when only customWhere differs", () => {
    const withColumns = (projection: string[]) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          ownerId: uuid("owner_id"),
          teamId: uuid("team_id"),
        }),
        clientProjection: { omitColumns: [] },
      });
      return defineSyncRegistry({
        items: { ...entry, shape: { ...entry.shape!, rowFilter: { columns: projection } } },
      });
    };

    // A static structural filter change (the projected columns) IS detected (review #5).
    expect(fingerprintRegistry(withColumns(["id", "owner_id"]))).not.toBe(
      fingerprintRegistry(withColumns(["id", "team_id"])),
    );

    // A change confined to the customWhere function body is not (only its presence is recorded).
    const withCustom = (fn: () => string) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
        clientProjection: { omitColumns: [] },
      });
      return defineSyncRegistry({ items: { ...entry, shape: { ...entry.shape!, rowFilter: { customWhere: fn } } } });
    };
    expect(fingerprintRegistry(withCustom(() => "owner_id = '1'"))).toBe(
      fingerprintRegistry(withCustom(() => "team_id = '2'")),
    );
  });

  it("changes when rowFilter.revision is bumped (the escape hatch for invisible customWhere logic)", () => {
    // The customWhere body is invisible to the fingerprint, so a consumer that changes its
    // *authorization logic* bumps `revision` to force a cache + subscription reset.
    const withRevision = (revision?: string | number) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }),
        clientProjection: { omitColumns: [] },
      });
      const rowFilter = {
        customWhere: () => "owner_id = '1'",
        ...(revision !== undefined ? { revision } : {}),
      };
      return defineSyncRegistry({ items: { ...entry, shape: { ...entry.shape!, rowFilter } } });
    };

    expect(fingerprintRegistry(withRevision("v2"))).not.toBe(fingerprintRegistry(withRevision("v1")));
    // Same revision → stable.
    expect(fingerprintRegistry(withRevision("v1"))).toBe(fingerprintRegistry(withRevision("v1")));
    // A bumped revision differs from no revision at all.
    expect(fingerprintRegistry(withRevision(2))).not.toBe(fingerprintRegistry(withRevision()));
  });

  it("canonicalizes to a sorted, shape-only structure", () => {
    const canon = canonicalizeRegistry(defineSyncRegistry({ items: items() }));
    expect(canon).toHaveLength(1);
    expect(canon[0]!.key).toBe("items");
    expect(canon[0]!.columns.map((column) => column.name)).toEqual(["id", "title"]);
  });

  it("memoises per registry object without changing the value (same object, and equal shapes still agree)", () => {
    // The chain is walked at least twice per boot over the SAME object; the memo must be transparent.
    const registry = defineSyncRegistry({ items: items(), notes: notes() });
    const first = fingerprintRegistry(registry);
    expect(fingerprintRegistry(registry)).toBe(first);
    // A structurally identical but distinct object misses the memo and must still agree.
    expect(fingerprintRegistry(defineSyncRegistry({ items: items(), notes: notes() }))).toBe(first);
    // And the memo is not a global: a different shape still fingerprints differently.
    expect(fingerprintRegistry(defineSyncRegistry({ items: items() }))).not.toBe(first);
  });
});

// =========================================================================================================
// hashString — the FNV-1a-64 primitive. Its OUTPUT is a PERSISTED value (`registry_fingerprint`, the `lsf1`
// local-schema fingerprint, the `apply` DDL fingerprint in generated migrations), so it is frozen for all
// time: a changed value silently invalidates every existing store (read-cache wipe + subscription reset) and
// every emitted migration's fingerprint. The implementation was rewritten off BigInt onto two 32-bit Number
// lanes for boot cost; these tests are the proof it is byte-for-byte the same function.
//
// The ORACLE below is the ORIGINAL BigInt implementation, kept HERE (test-only) and deliberately never
// exported: it independently reproduces the expected value for any input, while the hardcoded goldens pin
// the values even if someone "fixes" the oracle too.
// =========================================================================================================

/** The original BigInt FNV-1a-64 — the oracle, verbatim. Test-only; never ship a second implementation. */
function hashStringBigIntOracle(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** A multi-KB structured payload (~11.8 KB of UTF-8) — many bytes ⇒ many lane carries. */
function multiKbPayload(): string {
  let out = "";
  for (let i = 0; i < 400; i += 1) out += `line ${i}: ${"x".repeat(i % 17)} — αβγ\n`;
  return out;
}

describe("hashString (FNV-1a-64) — frozen output", () => {
  // [label, input, the golden value computed by the original BigInt implementation].
  const goldens: Array<[string, string, string]> = [
    ["empty string (the bare offset basis)", "", "cbf29ce484222325"],
    ["one ascii byte", "a", "af63dc4c8601ec8c"],
    ["short ascii", "pgxsinkit", "83f58420c44a634e"],
    [
      "canonical-registry-shaped JSON",
      '[{"key":"items","mode":"readonly","columns":["id","title"]}]',
      "0e69921a9e581d7b",
    ],
    // Multibyte content: the hash is over UTF-8 BYTES, so accents/CJK/astral planes must fold in identically.
    ["non-ascii / multibyte", "café — naïve 日本語 🐛", "6f02ae23e8903c05"],
    // High bytes + NUL, built from char codes so the literal cannot drift with file encoding.
    ["high bytes and NUL", String.fromCharCode(0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80), "3051cb15a0d5f920"],
    ["multi-KB payload", multiKbPayload(), "8b773c6d5d399125"],
  ];

  for (const [label, input, golden] of goldens) {
    it(`matches the pinned golden and the BigInt oracle: ${label}`, () => {
      expect(hashString(input)).toBe(golden);
      expect(hashStringBigIntOracle(input)).toBe(golden);
    });
  }

  it("agrees with the BigInt oracle across a wide swathe of generated inputs", () => {
    // Growth by one byte at a time (every low-lane carry pattern) plus a rolling multibyte tail.
    let ascii = "";
    let mixed = "";
    for (let i = 0; i < 300; i += 1) {
      ascii += String.fromCharCode(32 + (i % 95));
      mixed += i % 3 === 0 ? "é" : i % 3 === 1 ? "漢" : String.fromCharCode(i % 256);
      expect(hashString(ascii)).toBe(hashStringBigIntOracle(ascii));
      expect(hashString(mixed)).toBe(hashStringBigIntOracle(mixed));
    }
  });

  it("always returns 16 lower-case hex chars (zero-padded, never truncated)", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(hashString(`pad-${i}`)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
