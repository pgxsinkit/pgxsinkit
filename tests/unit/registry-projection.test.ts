import { describe, expect, it } from "bun:test";

import { getColumns, sql } from "drizzle-orm";
import { bigint, boolean, jsonb, uuid, varchar } from "drizzle-orm/pg-core";

import { generateLocalSchemaSql, getSyncedLocalTable } from "@pgxsinkit/client";
import {
  asEphemeral,
  asReadonly,
  assertReadContractPreserved,
  c,
  defineReadProjection,
  defineSyncRegistry,
  defineSyncTable,
  fingerprintReadContract,
  fingerprintRegistry,
  getOmittedProjectedColumnNames,
  type SyncTableEntry,
  withRetention,
} from "@pgxsinkit/contracts";

// Per-client mode projection: the authoritative (server) registry defines a table once with its full
// write contract; a client that must not write it consumes the same table through `asReadonly`. The
// read/identity contract is preserved; only the write capability (and its local machinery) is dropped.

// A writable table mirroring the authoritative definition: full write contract (conflictPolicy +
// nowMicroseconds server-version + managed fields) plus a per-identity row filter with a revision tag.
const writableRestriction = () =>
  defineSyncTable({
    tableName: "posting_restriction",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      offeringId: uuid("offering_id").notNull(),
      personId: uuid("person_id").notNull(),
      issuedBy: uuid("issued_by"),
      reason: varchar("reason", { length: 200 }),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "reject-if-stale",
    governance: {
      managedFields: [
        { column: "issuedBy", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
    shape: {
      rowFilter: (columns) => ({
        customWhere: (claims) => (claims.sub ? sql`${c(columns.personId)} = ${claims.sub}` : null),
        revision: "v1",
      }),
    },
  });

const readonlyOffering = () =>
  defineSyncTable({
    tableName: "offering",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    }),
  });

describe("asReadonly (readonly projection)", () => {
  it("flips mode to readonly and drops the write machinery", () => {
    const rw = writableRestriction();
    const ro = asReadonly(rw);

    expect(rw.mode).toBe("readwrite");
    expect(ro.mode).toBe("readonly");

    // The readwrite entry carries the overlay-merged read-model view + overlay/journal projection;
    // the readonly projection has none of them (its read path hits the synced base table directly).
    expect(rw.view).toBeDefined();
    expect(ro.view).toBeUndefined();
    expect(rw.clientProjection?.overlayTable).toBe("posting_restriction_overlay");
    expect(rw.clientProjection?.journalTable).toBe("posting_restriction_mutations");
    expect(ro.clientProjection?.overlayTable).toBeUndefined();
    expect(ro.clientProjection?.journalTable).toBeUndefined();

    // Write-only governance is stripped — a readonly table has no write path.
    expect(ro.conflictPolicy).toBeUndefined();
    expect(ro.governance).toBeUndefined();
  });

  it("preserves the synced table, columns, primary key and shape", () => {
    const rw = writableRestriction();
    const ro = asReadonly(rw);

    expect(ro.table).toBe(rw.table);
    expect(ro.localTable).toBe(rw.localTable);
    expect(ro.primaryKey).toEqual(rw.primaryKey);
    expect(ro.clientProjection?.syncedTable).toBe(rw.clientProjection?.syncedTable);
    expect(ro.shape).toEqual(rw.shape);
  });

  it("yields an entry a registry accepts as readonly (no conflictPolicy / server-version required)", () => {
    // The writable source would throw without conflictPolicy; its readonly projection has no such need.
    expect(() => defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) })).not.toThrow();
  });

  it("emits no overlay/journal DDL for the readonly projection (client schema gen)", () => {
    const rwSql = generateLocalSchemaSql(defineSyncRegistry({ posting_restriction: writableRestriction() }));
    const roSql = generateLocalSchemaSql(
      defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) }),
    );

    // The writable client provisions the full write cluster.
    expect(rwSql).toContain("posting_restriction_overlay");
    expect(rwSql).toContain("posting_restriction_mutations");

    // The readonly client provisions only the synced base table.
    expect(roSql).toContain("posting_restriction");
    expect(roSql).not.toContain("posting_restriction_overlay");
    expect(roSql).not.toContain("posting_restriction_mutations");
  });
});

// Regression (member-boot): since ADR-0029 P1 the client derives EVERY synced-table object from the
// entry's `makeColumns` factory (`getSyncedLocalTable` → `projectedColumnBuilders`). An `asReadonly`
// projection that dropped the factory could not build its own local synced read cache, so a member-mode
// client died at boot with "local table objects for <t> need the entry's makeColumns factory". These pin
// that the factory rides through the projection and that the derivation actually succeeds.
describe("asReadonly carries the column factory (ADR-0029 P1 member-boot)", () => {
  it("preserves makeColumns on the readonly projection", () => {
    const rw = writableRestriction();
    const ro = asReadonly(rw);
    expect(typeof ro.makeColumns).toBe("function");
    // Same factory identity as the writable source — carried through, not rebuilt.
    expect(ro.makeColumns).toBe(rw.makeColumns);
    expect(new Set(Object.keys(ro.makeColumns!()))).toEqual(
      new Set(["id", "offeringId", "personId", "issuedBy", "reason", "updatedAtUs"]),
    );
  });

  it("derives the local synced table for a registry holding the readonly entry (the board failure in miniature)", () => {
    // Exactly the boardMemberRegistry shape: a writable table consumed `asReadonly`. Before the fix this
    // threw inside getSyncedLocalTable; now it resolves the projected synced object.
    const memberLike = defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) });
    const synced = getSyncedLocalTable(memberLike, "posting_restriction");
    const columnNames = new Set(Object.values(getColumns(synced)).map((column) => column.name));
    expect(columnNames).toEqual(new Set(["id", "offering_id", "person_id", "issued_by", "reason", "updated_at_us"]));
  });

  // Keep-list completeness guard: asReadonly builds by listing what to KEEP, so a newly-added
  // read-relevant field is silently dropped unless carried. Enumerate a maximally-featured writable
  // entry's own keys and assert asReadonly drops ONLY the documented write-machinery set — so the NEXT
  // such regression (a dropped read field like makeColumns was) fails here instead of at a client boot.
  it("drops only the documented write-machinery keys, keeping every read/lifecycle field", () => {
    // Every optional SyncTableEntry field set, so no kept field escapes the enumeration.
    const rich = defineSyncTable({
      tableName: "rich_restriction",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        ownerId: uuid("owner_id"),
        updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
      }),
      mode: "readwrite",
      conflictPolicy: "reject-if-stale",
      governance: {
        managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
      },
      serverProjection: { rowTransform: (row) => row },
      consistencyGroup: "rich-grp",
      subscription: "lazy",
      retention: "persistent",
      writeMode: "pessimistic",
      shape: { rowFilter: () => ({ customWhere: () => null, revision: "v1" }) },
    });

    // The write path — and only the write path — is stripped (mode flips in value but the KEY stays).
    const droppedByDesign = new Set(["view", "conflictPolicy", "governance", "writeMode"]);
    const ro = asReadonly(rich);

    for (const key of Object.keys(rich)) {
      if (droppedByDesign.has(key)) {
        expect(key in ro).toBe(false);
      } else {
        // Read/identity + lifecycle + the column factory all survive.
        expect(key in ro).toBe(true);
      }
    }
    // Explicit: the field this regression was about is a kept, read-derivation field, not write machinery.
    expect("makeColumns" in ro).toBe(true);
    expect(droppedByDesign.has("makeColumns")).toBe(false);
  });
});

describe("defineReadProjection owner guard", () => {
  it("rejects a chained read projection (projection of a projection)", () => {
    // The intermediate projection narrows columns + rowFilter, but defineReadProjection derives off the
    // owner's physical table + FULL columns — so chaining would silently discard that narrowing. Reject it.
    const owner = writableRestriction();
    const summary = defineReadProjection(owner, { as: "posting_restriction_summary", columns: ["personId"] });
    expect(() => defineReadProjection(summary, { as: "posting_restriction_summary_2", columns: ["personId"] })).toThrow(
      /chained projections/,
    );
  });

  it("accepts an asReadonly owner (full read contract preserved) and derives the subset correctly", () => {
    // asReadonly is NOT a read projection — it keeps the physical table + full columns and only drops the
    // write path — so projecting off it is equivalent to projecting off its writable source.
    const roOwner = asReadonly(writableRestriction());
    const summary = defineReadProjection(roOwner, {
      as: "posting_restriction_ro_summary",
      columns: ["personId"],
    });
    expect(summary.readProjection).toBe(true);

    // The projection derives its own local synced object (PK always kept + the requested subset).
    const registry = defineSyncRegistry({ posting_restriction_ro_summary: summary });
    const synced = getSyncedLocalTable(registry, "posting_restriction_ro_summary");
    const columnNames = new Set(Object.values(getColumns(synced)).map((column) => column.name));
    expect(columnNames).toEqual(new Set(["id", "person_id"]));
  });
});

// A secure "window" over a keyed table: the owner carries a jsonb `payload` (the item body, keys
// included), a kept `metadata` column, and a `keysWithheld` control flag. A projection streams the body +
// metadata while a rowTransform strips the answer key per row when the flag is set — the flag itself is
// server-only (fetched for the transform, never on the client wire).
const securedItem = () =>
  defineSyncTable({
    tableName: "secured_item",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      payload: jsonb("payload").$type<Record<string, unknown>>(),
      metadata: varchar("metadata", { length: 200 }),
      keysWithheld: boolean("keys_withheld").notNull().default(false),
    }),
  });

const stripKeys = (row: Record<string, unknown>) => {
  if (row["keys_withheld"] !== true) {
    return row;
  }
  const payload = { ...(row["payload"] as Record<string, unknown>) };
  delete payload["correctResponse"];
  return { ...row, payload };
};

describe("defineReadProjection serverProjection + serverOnlyColumns (egress redaction)", () => {
  it("carries the passed serverProjection (same object) onto the projection entry", () => {
    const serverProjection = { rowTransform: stripKeys };
    const projection = defineReadProjection(securedItem(), {
      as: "secured_item_window",
      columns: ["payload", "metadata"],
      serverProjection,
      serverOnlyColumns: ["keysWithheld"],
    });
    // Same object identity — attached, not rebuilt (mirrors how `shape` is overridden).
    expect(projection.serverProjection).toBe(serverProjection);
    expect(projection.serverProjection?.rowTransform).toBe(stripKeys);
  });

  it("adds the serverOnly physical name to the Electric fetch allow-list (kept names + serverOnly + PK)", () => {
    const projection = defineReadProjection(securedItem(), {
      as: "secured_item_window",
      columns: ["payload", "metadata"],
      serverProjection: { rowTransform: stripKeys },
      serverOnlyColumns: ["keysWithheld"],
    });
    const allowList = projection.shape?.rowFilter?.columns;
    // Kept physical names (payload, metadata) + PK (id) + the server-only fetch (keys_withheld).
    expect(new Set(allowList)).toEqual(new Set(["id", "payload", "metadata", "keys_withheld"]));
  });

  it("still OMITS the serverOnly physical name on egress (client keep-set unchanged)", () => {
    // Widen to the base entry type: getOmittedProjectedColumnNames is generic over a single table param
    // (localTable defaults to it), and a projection's localTable type deliberately differs from its table.
    const projection: SyncTableEntry = defineReadProjection(securedItem(), {
      as: "secured_item_window",
      columns: ["payload", "metadata"],
      serverProjection: { rowTransform: stripKeys },
      serverOnlyColumns: ["keysWithheld"],
    });
    // keys_withheld is fetched (allow-list, above) yet stripped before the client wire — it is in the
    // omitted set, so the proxy's post-transform omission pass removes it.
    expect(getOmittedProjectedColumnNames(projection)).toContain("keys_withheld");
  });

  it("accepts a serverProjection ALONE (no columns) — full-width fetch, no allow-list", () => {
    const projection = defineReadProjection(securedItem(), {
      as: "secured_item_full_redacted",
      serverProjection: { rowTransform: stripKeys },
    });
    expect(projection.serverProjection?.rowTransform).toBe(stripKeys);
    // No columns omitted → no Electric `columns` allow-list (the whole row is fetched, then redacted).
    expect(projection.shape?.rowFilter?.columns).toBeUndefined();
  });

  it("rejects serverOnlyColumns without a serverProjection.rowTransform", () => {
    expect(() =>
      defineReadProjection(securedItem(), {
        as: "secured_item_window",
        columns: ["payload", "metadata"],
        serverOnlyColumns: ["keysWithheld"],
      }),
    ).toThrow(/serverOnlyColumns but no serverProjection\.rowTransform/);
  });

  it("rejects serverOnlyColumns without columns (server-only is a contradiction under a full keep-set)", () => {
    expect(() =>
      defineReadProjection(securedItem(), {
        as: "secured_item_window",
        serverProjection: { rowTransform: stripKeys },
        serverOnlyColumns: ["keysWithheld"],
      }),
    ).toThrow(/serverOnlyColumns without columns/);
  });

  it("rejects a serverOnlyColumns key that is also in columns", () => {
    expect(() =>
      defineReadProjection(securedItem(), {
        as: "secured_item_window",
        columns: ["payload", "metadata"],
        serverProjection: { rowTransform: stripKeys },
        serverOnlyColumns: ["metadata"],
      }),
    ).toThrow(/in BOTH serverOnlyColumns and the client shape/);
  });

  it("rejects a serverOnlyColumns key that is the primary key", () => {
    expect(() =>
      defineReadProjection(securedItem(), {
        as: "secured_item_window",
        columns: ["payload", "metadata"],
        serverProjection: { rowTransform: stripKeys },
        serverOnlyColumns: ["id"],
      }),
    ).toThrow(/in BOTH serverOnlyColumns and the client shape/);
  });

  it("rejects a nonexistent serverOnlyColumns key (feeds the wire allow-list — a typo must be loud)", () => {
    expect(() =>
      defineReadProjection(securedItem(), {
        as: "secured_item_window",
        columns: ["payload", "metadata"],
        serverProjection: { rowTransform: stripKeys },
        // Cast past the owner-key type constraint to exercise the RUNTIME existence guard.
        serverOnlyColumns: ["nope"] as unknown as ["keysWithheld"],
      }),
    ).toThrow(/is not a column of owner/);
  });
});

// Same shape as `securedItem`, but the OWNER itself redacts on egress (`serverProjection.rowTransform`).
// A projection does NOT inherit that transform (an inherited transform whose input column is unfetched
// fails OPEN), so the fail-closed guard forces every projection over this owner to declare a posture.
const redactingOwner = () =>
  defineSyncTable({
    tableName: "redacting_item",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      payload: jsonb("payload").$type<Record<string, unknown>>(),
      metadata: varchar("metadata", { length: 200 }),
      keysWithheld: boolean("keys_withheld").notNull().default(false),
    }),
    serverProjection: { rowTransform: stripKeys },
  });

describe("defineReadProjection fail-closed posture guard (owner redacts on egress)", () => {
  it("rejects a projection that declares NO posture over a redacting owner (would egress raw)", () => {
    expect(() =>
      defineReadProjection(redactingOwner(), {
        as: "redacting_item_window",
        columns: ["payload", "metadata"],
      }),
    ).toThrow(/declares[\s\S]*an egress rowTransform[\s\S]*does NOT inherit it/);
  });

  it('constructs with serverProjection: "unredacted" and attaches NO serverProjection to the entry', () => {
    const projection = defineReadProjection(redactingOwner(), {
      as: "redacting_item_window",
      columns: ["payload", "metadata"],
      serverProjection: "unredacted",
    });
    expect(projection.readProjection).toBe(true);
    // The opt-out attaches nothing — egress is raw, but that is now a visible, reviewed decision.
    expect("serverProjection" in projection).toBe(false);
    expect(projection.serverProjection).toBeUndefined();
  });

  it("constructs with its OWN serverProjection object over a redacting owner (carries it)", () => {
    const own = { rowTransform: stripKeys };
    const projection = defineReadProjection(redactingOwner(), {
      as: "redacting_item_window",
      columns: ["payload", "metadata"],
      serverProjection: own,
      serverOnlyColumns: ["keysWithheld"],
    });
    expect(projection.serverProjection).toBe(own);
  });

  it('rejects serverProjection: "unredacted" over a transform-LESS owner (stale opt-out would mask a future leak)', () => {
    expect(() =>
      defineReadProjection(securedItem(), {
        as: "secured_item_window",
        columns: ["payload", "metadata"],
        serverProjection: "unredacted",
      }),
    ).toThrow(/declares no egress rowTransform/);
  });

  it("fires through an asReadonly(owner) intermediary — the transform carries through the spread", () => {
    // asReadonly preserves serverProjection, so the guard sees the owner's egress rowTransform even one
    // projection removed. A bare projection over it must still throw.
    const roOwner = asReadonly(redactingOwner());
    expect(roOwner.serverProjection?.rowTransform).toBe(stripKeys);
    expect(() =>
      defineReadProjection(roOwner, {
        as: "redacting_item_ro_window",
        columns: ["payload", "metadata"],
      }),
    ).toThrow(/does NOT inherit it/);
  });

  it('rejects serverProjection: "unredacted" declared together with serverOnlyColumns', () => {
    expect(() =>
      defineReadProjection(redactingOwner(), {
        as: "redacting_item_window",
        columns: ["payload", "metadata"],
        serverProjection: "unredacted",
        serverOnlyColumns: ["keysWithheld"],
      }),
    ).toThrow(/"unredacted" together[\s\S]*with serverOnlyColumns/);
  });
});

describe("read-contract fingerprint", () => {
  it("is identical for a writable entry and its readonly projection", () => {
    const rw = writableRestriction();
    expect(fingerprintReadContract(asReadonly(rw))).toBe(fingerprintReadContract(rw));
  });

  it("ignores write-only differences (conflict policy, managed fields, mode)", () => {
    const reject = writableRestriction();
    const lww = defineSyncTable({
      tableName: "posting_restriction",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
        personId: uuid("person_id").notNull(),
        issuedBy: uuid("issued_by"),
        reason: varchar("reason", { length: 200 }),
        updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
      }),
      mode: "readwrite",
      conflictPolicy: "last-write-wins",
      governance: {
        managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
      },
      shape: {
        rowFilter: (columns) => ({
          customWhere: (claims) => (claims.sub ? sql`${c(columns.personId)} = ${claims.sub}` : null),
          revision: "v1",
        }),
      },
    });

    expect(fingerprintReadContract(lww)).toBe(fingerprintReadContract(reject));
  });

  it("ignores a retention (lifecycle) difference", () => {
    const persistent = writableRestriction();
    expect(fingerprintReadContract(withRetention(persistent, "ephemeral"))).toBe(fingerprintReadContract(persistent));
  });

  it("changes when a synced column changes", () => {
    const widened = defineSyncTable({
      tableName: "posting_restriction",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        offeringId: uuid("offering_id").notNull(),
        personId: uuid("person_id").notNull(),
        issuedBy: uuid("issued_by"),
        reason: varchar("reason", { length: 200 }),
        note: varchar("note", { length: 200 }),
        updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
      }),
      mode: "readwrite",
      conflictPolicy: "reject-if-stale",
      governance: {
        managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
      },
    });

    expect(fingerprintReadContract(widened)).not.toBe(fingerprintReadContract(writableRestriction()));
  });

  it("changes when the row-filter revision is bumped", () => {
    const base = writableRestriction();
    const bumped = { ...base, shape: { ...base.shape!, rowFilter: { ...base.shape!.rowFilter!, revision: "v2" } } };
    expect(fingerprintReadContract(bumped)).not.toBe(fingerprintReadContract(base));
  });

  it("documents that the FULL registry fingerprint DOES differ (the two clients have different local stores)", () => {
    expect(fingerprintRegistry(defineSyncRegistry({ posting_restriction: writableRestriction() }))).not.toBe(
      fingerprintRegistry(defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) })),
    );
  });
});

describe("assertReadContractPreserved (projection invariant)", () => {
  const authoritative = defineSyncRegistry({
    posting_restriction: writableRestriction(),
    offering: readonlyOffering(),
  });

  it("passes when a projection is asReadonly of the authoritative entry (and a subset is fine)", () => {
    const learner = defineSyncRegistry({ posting_restriction: asReadonly(writableRestriction()) });
    expect(() => assertReadContractPreserved(authoritative, learner)).not.toThrow();
  });

  it("throws, naming the table, when a projection diverges the synced data shape", () => {
    const divergent = defineSyncRegistry({
      posting_restriction: defineSyncTable({
        tableName: "posting_restriction",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
      }),
    });
    expect(() => assertReadContractPreserved(authoritative, divergent)).toThrow(/posting_restriction/);
  });

  it("throws when a projected table is absent from the authoritative registry", () => {
    const orphan = defineSyncRegistry({ ghost: readonlyOffering() });
    expect(() => assertReadContractPreserved(authoritative, orphan)).toThrow(/ghost/);
  });
});

// Lifecycle projection: a per-client registry may override the **retention** axis (ADR-0021) of an
// authoritative entry — durable for one client, no-durable-trace (`TEMP`) for another — without touching
// the read contract. `withRetention` is the bidirectional primitive; `asEphemeral` the named convenience.
describe("withRetention / asEphemeral (lifecycle projection)", () => {
  // A grouped pair sharing one consistency group, to exercise the group-uniformity constraint.
  const groupedA = () =>
    defineSyncTable({ tableName: "g_a", makeColumns: () => ({ id: uuid("id").primaryKey() }), consistencyGroup: "g" });
  const groupedB = () =>
    defineSyncTable({ tableName: "g_b", makeColumns: () => ({ id: uuid("id").primaryKey() }), consistencyGroup: "g" });

  it("overrides retention while preserving everything else", () => {
    const rw = writableRestriction();
    const ephemeral = withRetention(rw, "ephemeral");

    expect(rw.retention).toBeUndefined(); // default persistent
    expect(ephemeral.retention).toBe("ephemeral");

    // The write contract and read/identity contract carry through untouched.
    expect(ephemeral.mode).toBe(rw.mode);
    expect(ephemeral.conflictPolicy).toBe(rw.conflictPolicy);
    expect(ephemeral.governance).toEqual(rw.governance);
    expect(ephemeral.table).toBe(rw.table);
    expect(ephemeral.localTable).toBe(rw.localTable);
    expect(ephemeral.view).toBe(rw.view);
    expect(ephemeral.primaryKey).toEqual(rw.primaryKey);
    expect(ephemeral.shape).toEqual(rw.shape);
  });

  it("is bidirectional (ephemeral -> persistent)", () => {
    const ephemeral = asEphemeral(readonlyOffering());
    expect(ephemeral.retention).toBe("ephemeral");
    expect(withRetention(ephemeral, "persistent").retention).toBe("persistent");
  });

  it("asEphemeral is the named convenience for withRetention(entry, 'ephemeral')", () => {
    const rw = writableRestriction();
    expect(asEphemeral(rw).retention).toBe(withRetention(rw, "ephemeral").retention);
  });

  it("preserves the read contract, so a retention projection passes assertReadContractPreserved", () => {
    const authoritative = defineSyncRegistry({ offering: readonlyOffering() });
    const client = defineSyncRegistry({ offering: asEphemeral(readonlyOffering()) });
    expect(fingerprintReadContract(client.offering)).toBe(fingerprintReadContract(authoritative.offering));
    expect(() => assertReadContractPreserved(authoritative, client)).not.toThrow();
  });

  it("DOES shift the full registry fingerprint (the local store's DDL genuinely changes)", () => {
    expect(fingerprintRegistry(defineSyncRegistry({ offering: readonlyOffering() }))).not.toBe(
      fingerprintRegistry(defineSyncRegistry({ offering: asEphemeral(readonlyOffering()) })),
    );
  });

  it("emits a TEMP cluster for the ephemeral projection (client schema gen)", () => {
    const persistentSql = generateLocalSchemaSql(defineSyncRegistry({ offering: readonlyOffering() }));
    const ephemeralSql = generateLocalSchemaSql(defineSyncRegistry({ offering: asEphemeral(readonlyOffering()) }));

    expect(persistentSql).toContain("offering");
    expect(persistentSql).not.toContain("TEMP");

    expect(ephemeralSql).toContain("offering");
    expect(ephemeralSql).toContain("TEMP");
  });

  it("composes with asReadonly (readonly + ephemeral)", () => {
    const projected = asEphemeral(asReadonly(writableRestriction()));
    expect(projected.mode).toBe("readonly");
    expect(projected.retention).toBe("ephemeral");

    const sqlText = generateLocalSchemaSql(defineSyncRegistry({ posting_restriction: projected }));
    // readonly: no overlay/journal write cluster; ephemeral: the synced base table is TEMP.
    expect(sqlText).not.toContain("posting_restriction_overlay");
    expect(sqlText).not.toContain("posting_restriction_mutations");
    expect(sqlText).toContain("TEMP");
  });

  it("rejects a consistency group with mixed retention (override the whole group, not one member)", () => {
    expect(() => defineSyncRegistry({ g_a: asEphemeral(groupedA()), g_b: groupedB() })).toThrow(/lifecycle/);

    // Flipping every member of the group is accepted.
    expect(() => defineSyncRegistry({ g_a: asEphemeral(groupedA()), g_b: asEphemeral(groupedB()) })).not.toThrow();
  });
});
