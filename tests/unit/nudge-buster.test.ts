/**
 * Unit test of the live-tail sibling nudge cache-buster (ADR-0031 live-tail completion). `withNudgeBuster`
 * is pure and dependency-free (it lives in its own module precisely so this test doesn't drag PGlite/Electric
 * in through the engine): given a per-shape one-shot token, it stamps `cache-buster` onto the NEXT non-live
 * catch-up URL and consumes the token, leaving live long-polls (and the token) untouched.
 */
import { describe, expect, it } from "bun:test";

import { withNudgeBuster } from "../../packages/client/src/sync/nudge";

const BASE = "http://localhost:3000/v1/shape?table=todo&offset=-1";

/** The URL of whatever form `fetch`'s first argument took (string | URL | Request). */
function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

/** A recording fetchClient: captures the URL it was handed and returns a dummy 200. */
function recordingFetch(): { calls: string[]; fetchClient: typeof fetch } {
  const calls: string[] = [];
  const fetchClient = ((input: Parameters<typeof fetch>[0]) => {
    calls.push(inputUrl(input));
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;
  return { calls, fetchClient };
}

describe("withNudgeBuster (ADR-0031 live-tail nudge cache-buster)", () => {
  it("appends cache-buster once on a non-live request and consumes the token", async () => {
    const { calls, fetchClient } = recordingFetch();
    const busters = new Map<string, string>([["todo", "tok-123"]]);
    const wrapped = withNudgeBuster(fetchClient, busters, "todo");

    await wrapped(BASE);

    const url = new URL(calls[0]!);
    expect(url.searchParams.get("cache-buster")).toBe("tok-123");
    // One-shot: the token is consumed on use.
    expect(busters.has("todo")).toBe(false);
  });

  it("leaves a second request untouched once the token is consumed", async () => {
    const { calls, fetchClient } = recordingFetch();
    const busters = new Map<string, string>([["todo", "tok-123"]]);
    const wrapped = withNudgeBuster(fetchClient, busters, "todo");

    await wrapped(BASE);
    await wrapped(BASE);

    expect(new URL(calls[1]!).searchParams.has("cache-buster")).toBe(false);
  });

  it("does NOT bust a live long-poll and retains the token for the following catch-up", async () => {
    const { calls, fetchClient } = recordingFetch();
    const busters = new Map<string, string>([["todo", "tok-123"]]);
    const wrapped = withNudgeBuster(fetchClient, busters, "todo");

    const liveUrl = `${BASE}&live=true&cursor=99`;
    await wrapped(liveUrl);
    // Live request passes through unmodified, and the token survives for the non-live catch-up next.
    expect(calls[0]).toBe(liveUrl);
    expect(busters.get("todo")).toBe("tok-123");

    // The subsequent non-live request gets the retained token.
    await wrapped(BASE);
    expect(new URL(calls[1]!).searchParams.get("cache-buster")).toBe("tok-123");
    expect(busters.has("todo")).toBe(false);
  });

  it("passthrough when no token is pending for the shape", async () => {
    const { calls, fetchClient } = recordingFetch();
    const wrapped = withNudgeBuster(fetchClient, new Map(), "todo");

    await wrapped(BASE);
    expect(calls[0]).toBe(BASE);
  });

  it("handles string, URL, and Request inputs", async () => {
    for (const makeInput of [
      (): Parameters<typeof fetch>[0] => BASE,
      (): Parameters<typeof fetch>[0] => new URL(BASE),
      (): Parameters<typeof fetch>[0] => new Request(BASE, { method: "GET", headers: { "x-test": "1" } }),
    ]) {
      const { calls, fetchClient } = recordingFetch();
      const busters = new Map<string, string>([["todo", "tok-abc"]]);
      const wrapped = withNudgeBuster(fetchClient, busters, "todo");

      await wrapped(makeInput());
      expect(new URL(calls[0]!).searchParams.get("cache-buster")).toBe("tok-abc");
    }
  });

  it("overwrites an existing cache-buster param", async () => {
    const { calls, fetchClient } = recordingFetch();
    const busters = new Map<string, string>([["todo", "fresh"]]);
    const wrapped = withNudgeBuster(fetchClient, busters, "todo");

    await wrapped(`${BASE}&cache-buster=stale`);
    const params = new URL(calls[0]!).searchParams;
    expect(params.getAll("cache-buster")).toEqual(["fresh"]);
  });
});
