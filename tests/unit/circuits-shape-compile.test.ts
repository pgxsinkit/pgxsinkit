import { describe, expect, it } from "bun:test";

import { boolean, text, uuid } from "drizzle-orm/pg-core";

import { DENY_ALL_PREDICATE, defineSyncRegistry, defineSyncTable, p, readShapeTier } from "@pgxsinkit/contracts";
import { compileShapeRequest, createCircuitsEngineClient } from "@pgxsinkit/server";

// The control plane's shape-creation path (ADR-0055): a declared shape plus its tier's inputs
// compile to the engine's `POST /shapes` body. What is pinned here is the part that has to be right
// for the two tiers to mean what the ADR says they mean — that a shared shape's predicate is
// GENERATED from scope values (so two subscribers in one scope produce identical bytes and Circuits
// can collapse them), and that a private shape's subject never leaks into a shape declared shared.

const offering = defineSyncTable({
  tableName: "offering_content",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    offeringId: uuid("offering_id").notNull(),
    groupId: uuid("group_id"),
    published: boolean("published").notNull(),
    body: text("body").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: {
    scope: (c) => [c.offeringId, c.groupId],
    where: (c) => p.eq(c.published, true),
  },
});

const notes = defineSyncTable({
  tableName: "notes",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    body: text("body").notNull(),
  }),
  primaryKey: ["id"],
  mode: "readonly",
  shape: {
    rowFilter: (c) => ({
      customPredicate: (claims) => (typeof claims.sub === "string" ? p.eq(c.ownerId, claims.sub) : DENY_ALL_PREDICATE),
    }),
  },
});

const registry = defineSyncRegistry({ tables: { offering, notes } });

describe("shared tier", () => {
  it("generates an AND of scope equalities, conjoined with the static where", () => {
    const compiled = compileShapeRequest(registry, {
      shapeKey: "offering_content",
      claims: null,
      scope: ["off-1", "grp-1"],
    });

    expect(compiled).toEqual({
      outcome: "create",
      tier: "shared",
      request: {
        table: "offering_content",
        where: {
          and: [
            {
              and: [
                { col: "offering_id", op: "eq", value: "off-1" },
                { col: "group_id", op: "eq", value: "grp-1" },
              ],
            },
            { col: "published", op: "eq", value: true },
          ],
        },
      },
    });
  });

  // A null scope value is a scope like any other — the offering-wide `(O, null)` family. `= NULL` is
  // UNKNOWN for every row, so getting this wrong yields a shape that silently matches nothing rather
  // than one that errors.
  it("compiles a null scope value to IS NULL, not to equality", () => {
    const compiled = compileShapeRequest(registry, {
      shapeKey: "offering_content",
      claims: null,
      scope: ["off-1", null],
    });

    expect(compiled.outcome).toBe("create");
    const where = compiled.outcome === "create" ? compiled.request.where : undefined;
    expect(where).toEqual({
      and: [
        {
          and: [
            { col: "offering_id", op: "eq", value: "off-1" },
            { col: "group_id", isNull: true },
          ],
        },
        { col: "published", op: "eq", value: true },
      ],
    });
  });

  // Padding a short tuple would silently widen the shape to every group of the offering.
  it("refuses a scope tuple of the wrong arity", () => {
    const compiled = compileShapeRequest(registry, {
      shapeKey: "offering_content",
      claims: null,
      scope: ["off-1"],
    });
    expect(compiled.outcome).toBe("deny");
  });

  it("ignores claims entirely, so one scope yields one request for every subject", () => {
    const forA = compileShapeRequest(registry, {
      shapeKey: "offering_content",
      claims: { sub: "person-a" },
      scope: ["off-1", "grp-1"],
    });
    const forB = compileShapeRequest(registry, {
      shapeKey: "offering_content",
      claims: { sub: "person-b" },
      scope: ["off-1", "grp-1"],
    });
    expect(forA).toEqual(forB);
  });
});

describe("private tier", () => {
  it("fuses the subject into the predicate", () => {
    const compiled = compileShapeRequest(registry, {
      shapeKey: "notes",
      claims: { sub: "person-a" },
    });

    expect(compiled).toEqual({
      outcome: "create",
      tier: "private",
      request: { table: "notes", where: { col: "owner_id", op: "eq", value: "person-a" } },
    });
  });

  // A denied caller gets no handle and no shape — not an empty one that would then need retention.
  it("denies rather than creating an empty shape", () => {
    const compiled = compileShapeRequest(registry, { shapeKey: "notes", claims: null });
    expect(compiled.outcome).toBe("deny");
  });
});

it("fails closed on a shapeKey nothing declares", () => {
  const compiled = compileShapeRequest(registry, { shapeKey: "notes_admin", claims: { sub: "a" } });
  expect(compiled.outcome).toBe("deny");
});

// Both-declared is contradictory by construction: a rowFilter makes the bytes subject-dependent,
// which is exactly what a scope-keyed shared stream cannot carry.
it("refuses a shape declaring both scope and rowFilter", () => {
  expect(() =>
    readShapeTier({
      tableName: "t",
      shapeKey: "t",
      scope: ["offering_id"],
      rowFilter: { customPredicate: () => null },
    }),
  ).toThrow(/both scope and rowFilter/);
});

it("posts the compiled body to the engine and returns its handle", async () => {
  let seen: { url: string; body: unknown } | undefined;
  const client = createCircuitsEngineClient({
    baseUrl: "http://engine:4000/",
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response(
        JSON.stringify({
          shapeId: "s1",
          table: "offering_content",
          streamPath: "shape/s1",
          streamUrl: "http://ds:8080/v1/stream/shape/s1",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });

  const handle = await client.createShape({ table: "offering_content" });

  expect(seen?.url).toBe("http://engine:4000/shapes");
  expect(seen?.body).toEqual({ table: "offering_content" });
  expect(handle.streamPath).toBe("shape/s1");
});
