import { describe, expect, it } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  buildRegistryLock,
  compareRegistries,
  defineEventStream,
  defineSyncRegistry,
  defineSyncTable,
  diffRegistryAgainstLock,
  EVENT_STREAM_NAME_MAX_LENGTH,
  EVENT_STREAM_QUEUE_PREFIX,
  fingerprintRegistry,
  getSyncRegistryStreams,
  runRegistryCheck,
  type EventStreamRegistry,
} from "@pgxsinkit/contracts";

// Event-stream registration (ADR-0053 decision 1): the Event lane's contract rides the sync registry —
// validated fail-closed at module eval, carried on a non-enumerable symbol, a sibling in the lock/diff, and
// deliberately invisible to the fingerprint (registering an Event stream must not wipe a store's read cache).

const issues = defineSyncTable({
  tableName: "issues",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
  }),
});

const viewedStream = (extra?: { note?: boolean; identityField?: string }) =>
  defineEventStream({
    payload: z
      .object({
        issueId: z.uuid(),
        ...(extra?.note ? { note: z.string().optional() } : {}),
      })
      .strict(),
    identity: { [extra?.identityField ?? "viewerId"]: { claimPath: ["sub"] } },
  });

const withStreams = (streams: EventStreamRegistry) => defineSyncRegistry({ tables: { issues }, streams });

describe("Event-stream registration (ADR-0053)", () => {
  it("accepts a well-formed registration and reads it back off the registry", () => {
    const stream = viewedStream();
    const registry = withStreams({ board_issue_viewed: stream });

    expect(getSyncRegistryStreams(registry)).toEqual({ board_issue_viewed: stream });
    expect(getSyncRegistryStreams(registry)?.["board_issue_viewed"]?.identity["viewerId"]?.claimPath).toEqual(["sub"]);
  });

  it("reads back undefined when no Event stream is registered (and for the bare-registry-map overload)", () => {
    expect(getSyncRegistryStreams(defineSyncRegistry({ tables: { issues } }))).toBeUndefined();
    expect(getSyncRegistryStreams(defineSyncRegistry({ issues }))).toBeUndefined();
  });

  it("carries the streams on a NON-enumerable symbol, so the registry still walks as its tables", () => {
    const registry = withStreams({ board_issue_viewed: viewedStream() });

    expect(Object.keys(registry)).toEqual(["issues"]);
    expect(Object.getOwnPropertyNames(registry)).toEqual(["issues"]);
    expect(
      Object.getOwnPropertyDescriptor(registry, Symbol.for("@pgxsinkit/contracts/syncRegistryStreams"))?.enumerable,
    ).toBe(false);
  });

  it("keeps a payload schema usable through the round trip (it is the append-time validator)", () => {
    const registry = withStreams({ board_issue_viewed: viewedStream() });
    const payload = getSyncRegistryStreams(registry)?.["board_issue_viewed"]?.payload;

    expect(payload?.safeParse({ issueId: crypto.randomUUID() }).success).toBe(true);
    expect(payload?.safeParse({ issueId: "not-a-uuid" }).success).toBe(false);
    expect(payload?.safeParse({ issueId: crypto.randomUUID(), extra: 1 }).success).toBe(false);
  });

  it("re-stamping the SAME registration is idempotent, a different one is a conflict", () => {
    const stream = viewedStream();
    const tables = { issues };

    expect(() => {
      defineSyncRegistry({ tables, streams: { board_issue_viewed: stream } });
      defineSyncRegistry({ tables, streams: { board_issue_viewed: stream } });
    }).not.toThrow();

    expect(() => defineSyncRegistry({ tables, streams: { board_issue_viewed: viewedStream() } })).toThrow(
      /conflicting streams declaration/,
    );
  });
});

describe("Event-stream validation is fail-closed at module eval (ADR-0053)", () => {
  it("rejects a name that is not lowercase [a-z][a-z0-9_]*", () => {
    expect(() => withStreams({ Board_Issue_Viewed: viewedStream() })).toThrow(/invalid Event-stream name/);
    expect(() => withStreams({ "1st_view": viewedStream() })).toThrow(/invalid Event-stream name/);
    expect(() => withStreams({ "issue-viewed": viewedStream() })).toThrow(/invalid Event-stream name/);
  });

  it("rejects a name longer than the pgmq queue-name budget, citing it", () => {
    const tooLong = "a".repeat(EVENT_STREAM_NAME_MAX_LENGTH + 1);
    expect(EVENT_STREAM_NAME_MAX_LENGTH).toBe(30);
    expect(EVENT_STREAM_QUEUE_PREFIX.length).toBe(17);

    let message = "";
    try {
      withStreams({ [tooLong]: viewedStream() });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("at most 30");
    expect(message).toContain("pgmq's queue-name limit is 47");
    expect(message).toContain(`"${EVENT_STREAM_QUEUE_PREFIX}" prefix consumes 17`);
    // The boundary length itself is fine.
    expect(() => withStreams({ ["a".repeat(EVENT_STREAM_NAME_MAX_LENGTH)]: viewedStream() })).not.toThrow();
  });

  it("rejects a payload that is not a zod schema", () => {
    expect(() => withStreams({ board_issue_viewed: { payload: { issueId: "uuid" }, identity: {} } as never })).toThrow(
      /payload is not a zod schema/,
    );
  });

  it("rejects an identity field with a missing, empty or non-string claim path", () => {
    expect(() =>
      withStreams({
        board_issue_viewed: { payload: z.object({}).strict(), identity: { viewerId: {} } } as never,
      }),
    ).toThrow(/claimPath must be a non-empty JSON path/);

    expect(() =>
      withStreams({
        board_issue_viewed: {
          payload: z.object({}).strict(),
          identity: { viewerId: { claimPath: [] } },
        },
      }),
    ).toThrow(/claimPath must be a non-empty JSON path/);

    expect(() =>
      withStreams({
        board_issue_viewed: {
          payload: z.object({}).strict(),
          identity: { viewerId: { claimPath: ["app_metadata", ""] } },
        },
      }),
    ).toThrow(/every claimPath segment must be a non-empty string/);
  });

  it("rejects an entry that is not an Event-stream entry at all", () => {
    expect(() => withStreams({ board_issue_viewed: null as never })).toThrow(/not an Event-stream entry/);
  });

  it("rejects a payload whose object root is not STRICT, and says how to fix it", () => {
    // The advertised contract is a STRICT payload schema, and it is enforced rather than advertised: a
    // stripping `z.object({…})` would silently drop a misspelled or newly-added key somewhere between the
    // caller and the consumer, with no verdict anywhere.
    let message = "";
    try {
      withStreams({
        board_issue_viewed: defineEventStream({ payload: z.object({ issueId: z.uuid() }), identity: {} }),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("is not strict");
    expect(message).toContain(".strict()");
    expect(message).toContain("z.strictObject()");

    // A LOOSE / catchall object is not strict either — an unknown key must be REJECTED, not carried.
    expect(() =>
      withStreams({
        board_issue_viewed: defineEventStream({ payload: z.looseObject({ a: z.string() }), identity: {} }),
      }),
    ).toThrow(/is not strict/);
  });

  it("accepts both strict spellings, and every non-object root unchanged", () => {
    const accept = (payload: z.ZodType) =>
      withStreams({ board_issue_viewed: defineEventStream({ payload, identity: {} }) });

    expect(() => accept(z.object({ issueId: z.uuid() }).strict())).not.toThrow();
    expect(() => accept(z.strictObject({ issueId: z.uuid() }))).not.toThrow();
    // Non-object roots follow ordinary parse-contract semantics: there is no unknown key to strip, so
    // strictness has nothing to say about them.
    expect(() => accept(z.string())).not.toThrow();
    expect(() => accept(z.array(z.strictObject({ a: z.string() })))).not.toThrow();
    expect(() => accept(z.record(z.string(), z.number()))).not.toThrow();
    expect(() => accept(z.string().transform((value) => value.trim()))).not.toThrow();
  });

  it("walks a union chain: every object member must be strict, one loose member fails the registration", () => {
    const strictA = z.strictObject({ kind: z.literal("a"), issueId: z.uuid() });
    const strictB = z.object({ kind: z.literal("b"), aid: z.string() }).strict();
    const accept = (payload: z.ZodType) =>
      withStreams({ board_issue_viewed: defineEventStream({ payload, identity: {} }) });

    expect(() => accept(z.discriminatedUnion("kind", [strictA, strictB]))).not.toThrow();
    expect(() => accept(z.union([strictA, strictB]))).not.toThrow();
    // One stripping member is enough: it is a root a client may append against.
    expect(() => accept(z.union([strictA, z.object({ kind: z.literal("c") })]))).toThrow(/is not strict/);
    expect(() =>
      accept(z.discriminatedUnion("kind", [strictA, z.object({ kind: z.literal("c"), note: z.string() })])),
    ).toThrow(/is not strict/);
  });

  it("rejects a revision that is not a positive integer", () => {
    const withRevision = (revision: number) =>
      withStreams({
        board_issue_viewed: defineEventStream({
          payload: z.object({ issueId: z.uuid() }).strict(),
          identity: {},
          revision,
        }),
      });

    expect(() => withRevision(0)).toThrow(/revision must be a positive integer/);
    expect(() => withRevision(-1)).toThrow(/revision must be a positive integer/);
    expect(() => withRevision(1.5)).toThrow(/revision must be a positive integer/);
    expect(() => withRevision(Number.NaN)).toThrow(/revision must be a positive integer/);
    expect(() => withRevision(2)).not.toThrow();
  });

  it("names EVERY offender in one error", () => {
    let message = "";
    try {
      withStreams({
        Bad_Name: viewedStream(),
        also_bad: { payload: "nope", identity: {} } as never,
        third_bad: { payload: z.object({}).strict(), identity: { who: { claimPath: [] } } },
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("invalid Event-stream registration (ADR-0053)");
    expect(message).toContain("Bad_Name");
    expect(message).toContain("also_bad");
    expect(message).toContain("third_bad");
  });
});

describe("Event streams in the lock and the diff (ADR-0053)", () => {
  it("carries a per-stream contract hash in the lock as a sibling of the canonical tables", () => {
    const lock = buildRegistryLock(withStreams({ board_issue_viewed: viewedStream() }));

    expect(Object.keys(lock.streams ?? {})).toEqual(["board_issue_viewed"]);
    expect(typeof lock.streams?.["board_issue_viewed"]).toBe("string");
    // The Event lane must not leak into the canonical shape — that is what the persisted fingerprint hashes.
    expect(JSON.stringify(lock.tables)).not.toContain("board_issue_viewed");
    expect(lock.version).toBe(buildRegistryLock(defineSyncRegistry({ tables: { issues } })).version);
  });

  it("hashes an identical registration identically, and key ORDER does not matter", () => {
    const a = buildRegistryLock(withStreams({ board_issue_viewed: viewedStream() }));
    const b = buildRegistryLock(withStreams({ board_issue_viewed: viewedStream() }));
    expect(a.streams).toEqual(b.streams);

    const reordered = defineEventStream({
      payload: z.object({ issueId: z.uuid() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    });
    expect(buildRegistryLock(withStreams({ board_issue_viewed: reordered })).streams).toEqual(a.streams);
  });

  it("classifies an added Event stream as compatible", () => {
    const diff = compareRegistries(
      defineSyncRegistry({ tables: { issues } }),
      withStreams({ board_issue_viewed: viewedStream() }),
    );

    expect(diff.severity).toBe("compatible");
    expect(diff.changes.some((change) => change.detail === "event stream added: board_issue_viewed")).toBe(true);
  });

  it("classifies a removed Event stream as breaking (in-flight events)", () => {
    const diff = compareRegistries(
      withStreams({ board_issue_viewed: viewedStream() }),
      defineSyncRegistry({ tables: { issues } }),
    );

    expect(diff.severity).toBe("breaking");
    expect(
      diff.changes.some(
        (change) =>
          change.detail ===
          "event stream removed: board_issue_viewed (in-flight client events will be deferred/refused)",
      ),
    ).toBe(true);
  });

  it("classifies a payload-schema change as risky", () => {
    const diff = compareRegistries(
      withStreams({ board_issue_viewed: viewedStream() }),
      withStreams({ board_issue_viewed: viewedStream({ note: true }) }),
    );

    expect(diff.severity).toBe("risky");
    expect(
      diff.changes.some((change) =>
        /event stream board_issue_viewed payload\/identity changed \(must remain backward-compatible; incompatible change requires a new Event-stream name\)/.test(
          change.detail,
        ),
      ),
    ).toBe(true);
  });

  it("classifies an identity-declaration change as risky", () => {
    const diff = compareRegistries(
      withStreams({ board_issue_viewed: viewedStream() }),
      withStreams({ board_issue_viewed: viewedStream({ identityField: "personId" }) }),
    );

    expect(diff.severity).toBe("risky");
    expect(diff.changes.some((change) => /payload\/identity changed/.test(change.detail))).toBe(true);
  });

  it("surfaces a bumped `revision` as a risky diff — the ONLY handle on refinement changes", () => {
    // The lock hashes the payload as a JSON Schema, which cannot express a zod refinement. So the SAME
    // schema with a bumped revision must hash differently: that is the whole mechanism by which an
    // invisible acceptance-logic change becomes reviewable.
    const versioned = (revision?: number) =>
      withStreams({
        board_issue_viewed: defineEventStream({
          payload: z.object({ issueId: z.uuid() }).strict(),
          identity: { viewerId: { claimPath: ["sub"] } },
          ...(revision != null ? { revision } : {}),
        }),
      });

    const before = buildRegistryLock(versioned()).streams?.["board_issue_viewed"];
    const after = buildRegistryLock(versioned(2)).streams?.["board_issue_viewed"];
    expect(before).not.toBe(after);
    // Declaring `revision: 1` on a stream that had none is itself a change (absent === 0).
    expect(buildRegistryLock(versioned(1)).streams?.["board_issue_viewed"]).not.toBe(before);

    const diff = compareRegistries(versioned(), versioned(2));
    expect(diff.severity).toBe("risky");
    expect(diff.changes.some((change) => /payload\/identity changed/.test(change.detail))).toBe(true);
  });

  it("does NOT see a refinement-only change — the documented blind spot `revision` exists for", () => {
    // Pinned honestly rather than wished away: `z.string().refine(len >= 3)` and the INCOMPATIBLE `>= 10`
    // canonicalize identically, because JSON Schema cannot carry a refinement. Without a `revision` bump the
    // review gate never fires — which is exactly why bumping it is an author OBLIGATION, not a nicety.
    const refined = (minimum: number, revision?: number) =>
      withStreams({
        board_issue_viewed: defineEventStream({
          payload: z.string().refine((value) => value.length >= minimum),
          identity: { viewerId: { claimPath: ["sub"] } },
          ...(revision != null ? { revision } : {}),
        }),
      });

    expect(compareRegistries(refined(3), refined(10)).changes).toEqual([]);
    // ...and the author's fix, with the same two schemas:
    expect(compareRegistries(refined(3), refined(10, 2)).severity).toBe("risky");
  });

  it("reports nothing for an unchanged registration", () => {
    const diff = compareRegistries(
      withStreams({ board_issue_viewed: viewedStream() }),
      withStreams({ board_issue_viewed: viewedStream() }),
    );

    expect(diff.changes).toEqual([]);
  });

  it("reads a lock predating the streams field as a no-streams baseline", () => {
    // A committed lock is JSON on disk; one written before the field existed simply has no `streams`, so
    // adopting the Event lane against it must be compatible adoption, never spurious risk.
    const { streams: _dropped, ...oldLock } = buildRegistryLock(defineSyncRegistry({ tables: { issues } }));
    const diff = diffRegistryAgainstLock(withStreams({ board_issue_viewed: viewedStream() }), oldLock);

    expect(diff.severity).toBe("compatible");
    expect(diff.changes.some((change) => change.detail === "event stream added: board_issue_viewed")).toBe(true);
  });

  it("gates a removed Event stream through runRegistryCheck", () => {
    const lock = buildRegistryLock(withStreams({ board_issue_viewed: viewedStream() }));

    expect(runRegistryCheck({ registry: withStreams({ board_issue_viewed: viewedStream() }), lock }).ok).toBe(true);
    expect(runRegistryCheck({ registry: defineSyncRegistry({ tables: { issues } }), lock }).ok).toBe(false);
  });
});

describe("Event streams are invisible to the registry fingerprint (ADR-0053)", () => {
  // The registry fingerprint is PERSISTED as the local store's read-cache key. An Event stream touches no
  // synced table, no local schema and no apply function, so registering one must not wipe any store's cache.
  it("registering an Event stream leaves fingerprintRegistry identical", () => {
    const withoutStreams = defineSyncRegistry({ tables: { issues } });
    const withOne = withStreams({ board_issue_viewed: viewedStream() });
    const withTwo = withStreams({
      board_issue_viewed: viewedStream(),
      board_issue_edited: viewedStream({ note: true }),
    });

    expect(fingerprintRegistry(withOne)).toBe(fingerprintRegistry(withoutStreams));
    expect(fingerprintRegistry(withTwo)).toBe(fingerprintRegistry(withoutStreams));
  });
});
