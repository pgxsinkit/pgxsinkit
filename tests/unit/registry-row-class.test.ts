import { describe, expect, it } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";

import {
  asEphemeral,
  asReadonly,
  defineReadProjection,
  defineSyncRegistry,
  defineSyncTable,
  fingerprintReadContract,
  fingerprintRegistry,
  getSyncRegistryRowClasses,
  withRetention,
} from "@pgxsinkit/contracts";

// Row classification (ADR-0052): a consumer-defined vocabulary declared on the registry, validated
// fail-closed at module eval, carried through every projection — and deliberately invisible to the
// fingerprints, because those are persisted cache keys.

const papers = (rowClass?: string) =>
  defineSyncTable({
    tableName: "papers",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      ownerId: uuid("owner_id").notNull(),
    }),
    ...(rowClass != null ? { rowClass } : {}),
  });

const notes = (rowClass?: string) =>
  defineSyncTable({
    tableName: "notes",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      body: varchar("body", { length: 200 }).notNull(),
    }),
    ...(rowClass != null ? { rowClass } : {}),
  });

describe("rowClass validation (ADR-0052)", () => {
  it("accepts a fully classified registry and reads the vocabulary back off it", () => {
    const registry = defineSyncRegistry({
      rowClasses: ["private", "reference"],
      tables: { papers: papers("private"), notes: notes("reference") },
    });

    expect(getSyncRegistryRowClasses(registry)).toEqual(["private", "reference"]);
    expect(registry.papers.rowClass).toBe("private");
    expect(registry.notes.rowClass).toBe("reference");
  });

  it("rejects unclassified entries, naming EVERY offender in one error", () => {
    let message = "";
    try {
      defineSyncRegistry({
        rowClasses: ["private", "reference"],
        tables: { papers: papers(), notes: notes() },
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("row classification is incomplete");
    expect(message).toContain("papers");
    expect(message).toContain("notes");
  });

  it("rejects a class that is not in the declared set", () => {
    expect(() =>
      defineSyncRegistry({
        rowClasses: ["private", "reference"],
        tables: { papers: papers("privatte") },
      }),
    ).toThrow(/undeclared class: papers \(rowClass "privatte"\)/);
  });

  it("rejects an empty or duplicated rowClasses declaration", () => {
    expect(() => defineSyncRegistry({ rowClasses: [], tables: { papers: papers("private") } })).toThrow(
      /rowClasses is declared but empty/,
    );
    expect(() =>
      defineSyncRegistry({
        rowClasses: ["private", "private"],
        tables: { papers: papers("private") },
      }),
    ).toThrow(/duplicate classes: private/);
  });

  it("leaves rowClass unconstrained when no vocabulary is declared", () => {
    const noVocabulary = defineSyncRegistry({ tables: { papers: papers(), notes: notes("anything-goes") } });
    expect(getSyncRegistryRowClasses(noVocabulary)).toBeUndefined();
    expect(noVocabulary.notes.rowClass).toBe("anything-goes");
  });

  it("leaves the bare-registry-map overload unconstrained (it has nowhere to declare a set)", () => {
    const bareMap = defineSyncRegistry({ papers: papers(), notes: notes("unvetted") });
    expect(getSyncRegistryRowClasses(bareMap)).toBeUndefined();
    expect(bareMap.papers.rowClass).toBeUndefined();
  });
});

describe("rowClass carriage through projections (ADR-0052)", () => {
  it("survives asReadonly, withRetention and asEphemeral", () => {
    const owner = papers("private");

    expect(asReadonly(owner).rowClass).toBe("private");
    expect(withRetention(owner, "ephemeral").rowClass).toBe("private");
    expect(asEphemeral(asReadonly(owner)).rowClass).toBe("private");
  });

  it("is inherited by a read projection, and overridable per projection", () => {
    const owner = papers("private");

    const inherited = defineReadProjection(owner, { as: "papers_summary", columns: ["title"] });
    expect(inherited.rowClass).toBe("private");

    const overridden = defineReadProjection(owner, {
      as: "papers_titles",
      columns: ["title"],
      rowClass: "reference",
    });
    expect(overridden.rowClass).toBe("reference");
  });

  it("keeps a projected registry passing the declared-vocabulary check", () => {
    const authoritative = defineSyncRegistry({
      rowClasses: ["private", "reference"],
      tables: { papers: papers("private"), notes: notes("reference") },
    });

    const projected = defineSyncRegistry({
      rowClasses: ["private", "reference"],
      tables: { papers: asReadonly(authoritative.papers), notes: asEphemeral(authoritative.notes) },
    });

    expect(projected.papers.rowClass).toBe("private");
    expect(projected.notes.rowClass).toBe("reference");
  });
});

describe("rowClass is invisible to the fingerprints (ADR-0052)", () => {
  // The registry fingerprint is PERSISTED as the local store's read-cache key: if classification shifted
  // it, merely classifying a table would wipe every store's cache and force a full resync.
  it("classifying a registry leaves fingerprintRegistry identical", () => {
    const unclassified = defineSyncRegistry({ tables: { papers: papers(), notes: notes() } });
    const classified = defineSyncRegistry({
      rowClasses: ["private", "reference"],
      tables: { papers: papers("private"), notes: notes("reference") },
    });

    expect(fingerprintRegistry(classified)).toBe(fingerprintRegistry(unclassified));
  });

  it("classifying an entry leaves its fingerprintReadContract identical", () => {
    expect(fingerprintReadContract(papers("private"))).toBe(fingerprintReadContract(papers()));
    expect(fingerprintReadContract(papers("reference"))).toBe(fingerprintReadContract(papers("private")));
  });
});
