import { afterEach, describe, expect, it, spyOn } from "bun:test";

import type { StampedEvent } from "@pgxsinkit/contracts";
import { fingerprintRegistry, getSyncRegistryStreams } from "@pgxsinkit/contracts";
import type { EventDrainSummary } from "@pgxsinkit/server";

import {
  BOARD_EVENTS_DRAIN_SECRET_HEADER,
  createBoardDrainNudge,
  createBoardEventsDrainHandler,
} from "../../apps/board-api/src/core/events-drain";
import { toArchiveRows } from "../../apps/board-api/src/core/issue-view-consumer";
import {
  BOARD_ISSUE_VIEWED_STREAM,
  boardMemberRegistry,
  boardSyncRegistry,
} from "../../packages/board-schema/src/index";

// The Board demo's Event stream (ADR-0053 decision 9). The lane's mechanics are pinned by the contracts /
// client / server unit tiers; what is board-specific — and what would break silently — is the registration
// surviving the per-role projection, and the consumer's archive mapping.

const stamped = (overrides: Partial<StampedEvent> = {}): StampedEvent => ({
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAtUs: "1700000000000000",
  identity: { viewerId: "22222222-2222-4222-8222-222222222222" },
  payload: { issueId: "33333333-3333-4333-8333-333333333333" },
  ...overrides,
});

describe("board_issue_viewed registration", () => {
  it("registers the stream with a server-stamped viewer identity", () => {
    const streams = getSyncRegistryStreams(boardSyncRegistry);
    expect(Object.keys(streams ?? {})).toEqual([BOARD_ISSUE_VIEWED_STREAM]);
    expect(streams?.[BOARD_ISSUE_VIEWED_STREAM]?.identity).toEqual({ viewerId: { claimPath: ["sub"] } });
  });

  it("accepts a uuid issueId and refuses anything else (strict payload)", () => {
    const payload = getSyncRegistryStreams(boardSyncRegistry)?.[BOARD_ISSUE_VIEWED_STREAM]?.payload;
    expect(payload?.safeParse({ issueId: "33333333-3333-4333-8333-333333333333" }).success).toBe(true);
    expect(payload?.safeParse({ issueId: "not-a-uuid" }).success).toBe(false);
    // Strict: an extra field is a call-site bug, caught at append rather than at ingest.
    expect(payload?.safeParse({ issueId: "33333333-3333-4333-8333-333333333333", teamId: "x" }).success).toBe(false);
  });

  it("survives the Member role projection", () => {
    // The projection spreads the authoritative registry's ENUMERABLE table keys, and streams ride a
    // non-enumerable symbol — so a projection that forgot to restate them would leave a Member with no
    // Event lane at all, and `appendEvent` would throw for the role that does most of the viewing.
    expect(Object.keys(getSyncRegistryStreams(boardMemberRegistry) ?? {})).toEqual([BOARD_ISSUE_VIEWED_STREAM]);
  });

  it("keeps Event streams out of the canonical fingerprint", () => {
    // Registering a stream touches no synced table, no local schema and no apply function, so it must not
    // move the fingerprint that rebuilds a store's read cache. Both role registries are checked because the
    // member one re-declares the streams independently.
    expect(fingerprintRegistry(boardSyncRegistry)).toBe(fingerprintRegistry({ ...boardSyncRegistry }));
    expect(fingerprintRegistry(boardMemberRegistry)).toBe(fingerprintRegistry({ ...boardMemberRegistry }));
  });
});

describe("the board's issue-view archive mapping", () => {
  it("maps a stamped envelope onto the archive row, keyed on eventId", () => {
    expect(toArchiveRows([stamped()])).toEqual([
      {
        eventId: "11111111-1111-4111-8111-111111111111",
        viewerId: "22222222-2222-4222-8222-222222222222",
        issueId: "33333333-3333-4333-8333-333333333333",
        occurredAtUs: 1700000000000000n,
      },
    ]);
  });

  it("throws rather than archiving an event with no stamped viewer", () => {
    // Only reachable from a hand-inserted queue message: the endpoint refuses the batch when the request
    // carries no verified claims. Throwing retries and then dead-letters — loudly — instead of writing a
    // fact nobody can be attributed with.
    expect(() => toArchiveRows([stamped({ identity: {} })])).toThrow(/no stamped viewerId/);
  });

  it("throws rather than archiving a malformed payload", () => {
    expect(() => toArchiveRows([stamped({ payload: { issueId: "nope" } })])).toThrow();
  });
});

// The board's SERVERLESS drain (pgxsinkit ADR-0053, amendment 2026-08-02): the third edge function and the
// ingest-side nudge that shortens its latency. Both live in `core/` precisely so they are testable without
// a Deno runtime — the runtime shim only reads env and hands the values over.

const SECRET = "0123456789abcdef0123456789abcdef";
const SUMMARY: EventDrainSummary = { delivered: 3, deadLettered: 1, empty: false };

function drainHandler(overrides: { secret?: string } = {}) {
  const calls: Array<{ budgetMs?: number } | undefined> = [];
  const handler = createBoardEventsDrainHandler({
    consumer: {
      drainOnce: async (options) => {
        calls.push(options);
        return SUMMARY;
      },
    },
    secret: overrides.secret ?? SECRET,
    budgetMs: 1_234,
  });
  return { handler, calls };
}

const drainRequest = (init: { method?: string; secret?: string | null } = {}) =>
  new Request("http://localhost/board-events-drain", {
    method: init.method ?? "POST",
    headers: init.secret == null ? {} : { [BOARD_EVENTS_DRAIN_SECRET_HEADER]: init.secret },
  });

describe("the board's events-drain function", () => {
  let log: ReturnType<typeof spyOn<Console, "log">> | null = null;

  afterEach(() => {
    log?.mockRestore();
    log = null;
  });

  it("runs ONE bounded pass on the right secret and answers with the summary", async () => {
    log = spyOn(console, "log").mockImplementation(() => {});
    const { handler, calls } = drainHandler();

    const response = await handler(drainRequest({ secret: SECRET }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUMMARY);
    // Exactly one pass, with the handler's configured budget — never an unbounded drain.
    expect(calls).toEqual([{ budgetMs: 1_234 }]);
  });

  it("401s a request with no secret, and one with the wrong secret, without draining", async () => {
    const { handler, calls } = drainHandler();

    expect((await handler(drainRequest())).status).toBe(401);
    expect((await handler(drainRequest({ secret: "" }))).status).toBe(401);
    expect((await handler(drainRequest({ secret: `${SECRET}x` }))).status).toBe(401);
    // A near-miss of the RIGHT length is the case a `===`-shaped compare leaks; the handler hashes both
    // sides first, so the comparison loop is over two 32-byte digests whatever was presented.
    expect((await handler(drainRequest({ secret: SECRET.replace(/f$/, "e") }))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("405s anything but POST", async () => {
    const { handler, calls } = drainHandler();

    const response = await handler(drainRequest({ method: "GET", secret: SECRET }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(calls).toEqual([]);
  });

  it("refuses to exist without a secret — an unauthenticated drain endpoint is not a degraded mode", () => {
    expect(() => drainHandler({ secret: "" })).toThrow(/non-empty shared secret/);
  });
});

describe("the board's enqueue nudge", () => {
  it("is NOT wired when either half of the configuration is absent (the local stack's runner drains)", () => {
    expect(createBoardDrainNudge({ url: undefined, secret: SECRET })).toBeUndefined();
    expect(
      createBoardDrainNudge({ url: "https://board.example/functions/v1/board-events-drain", secret: undefined }),
    ).toBeUndefined();
    expect(createBoardDrainNudge({ url: undefined, secret: undefined })).toBeUndefined();
  });

  it("fires a fetch at the drain function carrying the secret, without awaiting it", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    let release: (() => void) | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // Never resolves until the test says so: the nudge must be fire-and-forget, so a slow drain function
      // can never hold up the ingest response it was fired from.
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(null, { status: 200 }));
      });
    }) as typeof fetch;

    try {
      const nudge = createBoardDrainNudge({
        url: "https://board.example/functions/v1/board-events-drain",
        secret: SECRET,
      });
      expect(nudge).toBeDefined();

      // Returns immediately — `nudge` is `void`, there is nothing to await.
      expect(nudge?.({ streams: ["board_issue_viewed"] })).toBeUndefined();

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe("https://board.example/functions/v1/board-events-drain");
      expect(call.init?.method).toBe("POST");
      expect((call.init?.headers as Record<string, string> | undefined)?.[BOARD_EVENTS_DRAIN_SECRET_HEADER]).toBe(
        SECRET,
      );
      expect(JSON.parse(call.init?.body as string)).toEqual({ streams: ["board_issue_viewed"] });
      (release as (() => void) | null)?.();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("swallows a failed nudge — the cron sweep is the guarantee, the nudge is only latency", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("drain unreachable"))) as unknown as typeof fetch;

    try {
      const nudge = createBoardDrainNudge({
        url: "https://board.example/functions/v1/board-events-drain",
        secret: SECRET,
      });
      nudge?.({ streams: ["board_issue_viewed"] });
      // Let the rejection settle: an unhandled one here would be a crashed edge worker.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(log.mock.calls.map((call) => String(call[0])).some((line) => line.includes("nudge failed"))).toBe(true);
    } finally {
      globalThis.fetch = original;
      log.mockRestore();
    }
  });
});
