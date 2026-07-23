import { describe, expect, it } from "bun:test";
// Bridge protocol unit tests (ADR-0032 S2, decision 8 protocol tier): the codec seam + envelope helpers,
// and the worker's single token cache + pull mechanism (decision 3). No transport needed — the token
// cache's broadcast is an injected spy, and the codec/envelope are pure.

import {
  createWorkerTokenCache,
  encodeEnvelope,
  identityCodec,
  isBridgeEnvelope,
} from "../../packages/client/src/index";

describe("bridge envelope + identity codec (ADR-0032 S2 §1)", () => {
  it("wraps a payload in a versioned, channel-tagged envelope the guard accepts", () => {
    const { envelope, transfer } = encodeEnvelope(identityCodec, "rpc", { op: "flush", args: [] }, "rpc-1");
    expect(isBridgeEnvelope(envelope)).toBe(true);
    expect(envelope.type).toBe("rpc");
    expect(envelope.id).toBe("rpc-1");
    // v1 identity codec: the body IS the payload, no transferables.
    expect(identityCodec.decode(envelope.payload)).toEqual({ op: "flush", args: [] });
    expect(transfer).toBeUndefined();
  });

  it("rejects foreign / wrong-version traffic", () => {
    expect(isBridgeEnvelope({ ch: "something-else", v: 1, type: "rpc", payload: {} })).toBe(false);
    expect(isBridgeEnvelope({ ch: "pgxsinkit-bridge", v: 999, type: "rpc", payload: {} })).toBe(false);
    expect(isBridgeEnvelope(null)).toBe(false);
    expect(isBridgeEnvelope("nope")).toBe(false);
  });
});

describe("worker token cache + pull (ADR-0032 decision 3)", () => {
  it("serves a pushed, non-expired token from cache WITHOUT broadcasting a pull", async () => {
    const broadcasts: string[] = [];
    let clock = 1_000_000;
    const cache = createWorkerTokenCache({
      marginMs: 30_000,
      now: () => clock,
      broadcastRequest: (id) => broadcasts.push(id),
    });
    cache.push({ accessToken: "fresh", expiresAt: clock + 3_600_000 });
    expect(await cache.getToken()).toBe("fresh");
    expect(broadcasts).toEqual([]); // cache hit — no pull
  });

  it("on expiry, dedupes concurrent requests onto exactly ONE pull broadcast; first response wins", async () => {
    const broadcasts: string[] = [];
    let clock = 1_000_000;
    const cache = createWorkerTokenCache({
      marginMs: 30_000,
      now: () => clock,
      broadcastRequest: (id) => broadcasts.push(id),
    });
    // Seed a token that is now WITHIN the expiry margin (10s left < 30s margin) → next request must pull.
    cache.push({ accessToken: "stale", expiresAt: clock + 10_000 });

    const first = cache.getToken();
    const second = cache.getToken();
    // Exactly one broadcast for the two concurrent, near-expiry requests.
    expect(broadcasts).toHaveLength(1);
    const requestId = broadcasts[0]!;

    // First tab answers; a second (late) answer for the same request is ignored (first wins).
    cache.respond(requestId, { accessToken: "refreshed", expiresAt: clock + 3_600_000 });
    cache.respond(requestId, { accessToken: "loser", expiresAt: clock + 3_600_000 });

    expect(await first).toBe("refreshed");
    expect(await second).toBe("refreshed");

    // The refreshed token is now cached and comfortably ahead of expiry → still exactly ONE broadcast total.
    expect(await cache.getToken()).toBe("refreshed");
    expect(broadcasts).toHaveLength(1);
  });

  it("a token PUSH satisfies an in-flight pull (the tab volunteered before answering)", async () => {
    const broadcasts: string[] = [];
    const clock = 1_000_000;
    const cache = createWorkerTokenCache({
      marginMs: 30_000,
      now: () => clock,
      broadcastRequest: (id) => broadcasts.push(id),
    });
    const pending = cache.getToken(); // no token yet → pull broadcast
    expect(broadcasts).toHaveLength(1);
    cache.push({ accessToken: "pushed", expiresAt: clock + 3_600_000 });
    expect(await pending).toBe("pushed");
  });
});

describe("worker token cache pushIfFresher (ADR-0032 FIX 5 — attach seeding never clobbers)", () => {
  it("pushIfFresher(null) is a no-op — a later attach's absent token never wipes the cache", async () => {
    const clock = 1_000_000;
    const cache = createWorkerTokenCache({
      marginMs: 30_000,
      now: () => clock,
      broadcastRequest: () => undefined,
    });
    cache.push({ accessToken: "kept", expiresAt: clock + 3_600_000 });
    cache.pushIfFresher(null);
    expect(await cache.getToken()).toBe("kept");
  });

  it("pushIfFresher with an OLDER-or-equal expiry is a no-op — the fresher cached token stands", async () => {
    const clock = 1_000_000;
    const cache = createWorkerTokenCache({
      marginMs: 30_000,
      now: () => clock,
      broadcastRequest: () => undefined,
    });
    cache.push({ accessToken: "fresher", expiresAt: clock + 3_600_000 });
    // A later attach seeds a token that expires SOONER — it must not clobber the fresher one.
    cache.pushIfFresher({ accessToken: "older", expiresAt: clock + 60_000 });
    expect(await cache.getToken()).toBe("fresher");
    // Equal expiry is also a no-op (>= guard): the incumbent stands.
    cache.pushIfFresher({ accessToken: "equal", expiresAt: clock + 3_600_000 });
    expect(await cache.getToken()).toBe("fresher");
  });

  it("pushIfFresher with a STRICTLY fresher token replaces the cache and settles a pending pull", async () => {
    const broadcasts: string[] = [];
    const clock = 1_000_000;
    const cache = createWorkerTokenCache({
      marginMs: 30_000,
      now: () => clock,
      broadcastRequest: (id) => broadcasts.push(id),
    });
    // Cache within the expiry margin (10s < 30s) so the next getToken pulls.
    cache.push({ accessToken: "stale", expiresAt: clock + 10_000 });
    const pending = cache.getToken();
    expect(broadcasts).toHaveLength(1);
    // A later attach seeds a strictly fresher token → adopted AND it settles the in-flight pull.
    cache.pushIfFresher({ accessToken: "seeded", expiresAt: clock + 3_600_000 });
    expect(await pending).toBe("seeded");
    expect(await cache.getToken()).toBe("seeded");
    expect(broadcasts).toHaveLength(1); // no further pull — the seeded token is comfortably ahead
  });
});
