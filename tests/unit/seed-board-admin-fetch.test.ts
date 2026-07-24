import { describe, expect, it } from "bun:test";

import { adminFetch, isTransientBadJwt } from "../../scripts/seed-board";

// `adminFetch` is the transient-tolerant wrapper the board seed uses for every GoTrue admin call. Beyond
// the long-standing 5xx retry, it now also retries a transient `403 bad_jwt` (a stale edge/GoTrue node
// minting a kid-less token while a Supabase signing-key rotation propagates) while failing fast on any
// genuine 403. These tests drive it with an injected fake fetch + fake sleep — no real timers or network.

// Build a JSON body + Response the way GoTrue would, so the classifier + reconstruction paths are exercised
// against realistic bodies rather than bare strings.
function jsonResponse(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), init);
}

const BAD_JWT_BODY = {
  code: 403,
  error_code: "bad_jwt",
  msg: "invalid JWT: unable to parse or verify signature, unrecognized JWT kid <nil> for algorithm ES256",
};

describe("adminFetch bad_jwt retry", () => {
  it("retries a transient 403 bad_jwt and succeeds on the following 200", async () => {
    const responses = [jsonResponse(BAD_JWT_BODY, { status: 403 }), jsonResponse({ id: "user-1" }, { status: 200 })];
    let calls = 0;
    const sleeps: number[] = [];

    const response = await adminFetch("http://gotrue/admin/users", undefined, {
      fetchImpl: async () => responses[calls++]!,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]); // the short fixed bad_jwt delay, not the attempt*1000 5xx backoff
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "user-1" });
  });

  it("returns a non-bad_jwt 403 to the caller without retry, body still readable", async () => {
    const body = JSON.stringify({ code: 403, error_code: "not_admin", msg: "forbidden" });
    let calls = 0;

    const response = await adminFetch("http://gotrue/admin/users", undefined, {
      fetchImpl: async () => {
        calls++;
        return new Response(body, { status: 403, statusText: "Forbidden" });
      },
      sleep: async () => {
        throw new Error("must not sleep/retry on a genuine 403");
      },
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(403);
    expect(response.statusText).toBe("Forbidden");
    expect(await response.text()).toBe(body); // reconstructed Response — body was consumed once but is re-readable
  });

  it("treats a non-JSON 403 body as non-retryable and returns it readable", async () => {
    const body = "<html>403 Forbidden</html>";
    let calls = 0;

    const response = await adminFetch("http://gotrue/admin/users", undefined, {
      fetchImpl: async () => {
        calls++;
        return new Response(body, { status: 403 });
      },
      sleep: async () => {
        throw new Error("must not retry a non-JSON 403");
      },
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(body);
  });

  it("passes a 2xx through untouched — same Response instance, readable body", async () => {
    const original = jsonResponse({ id: "abc" }, { status: 200 });
    let calls = 0;

    const response = await adminFetch("http://gotrue/admin/users", undefined, {
      fetchImpl: async () => {
        calls++;
        return original;
      },
      sleep: async () => {
        throw new Error("must not sleep on the success path");
      },
    });

    expect(calls).toBe(1);
    expect(response).toBe(original); // untouched — not reconstructed
    expect(await response.json()).toEqual({ id: "abc" });
  });

  it("throws a clear rotation/propagation error when bad_jwt persists across the whole bound", async () => {
    let calls = 0;
    const sleeps: number[] = [];

    let thrown: unknown;
    try {
      await adminFetch("http://gotrue/admin/users", undefined, {
        fetchImpl: async () => {
          calls++;
          return jsonResponse(BAD_JWT_BODY, { status: 403 });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/transient 403 bad_jwt[\s\S]*signing-key rotation[\s\S]*propagation lag/);
    expect(calls).toBe(8); // the existing attempt bound is preserved
    expect(sleeps).toEqual(Array(8).fill(500));
  });
});

describe("isTransientBadJwt", () => {
  it("matches only a JSON body whose error_code is bad_jwt", () => {
    expect(isTransientBadJwt(JSON.stringify({ error_code: "bad_jwt" }))).toBe(true);
    expect(isTransientBadJwt(JSON.stringify({ error_code: "not_admin" }))).toBe(false);
    expect(isTransientBadJwt(JSON.stringify({ msg: "no error_code here" }))).toBe(false);
    expect(isTransientBadJwt("not json at all")).toBe(false);
    expect(isTransientBadJwt("")).toBe(false);
  });
});
