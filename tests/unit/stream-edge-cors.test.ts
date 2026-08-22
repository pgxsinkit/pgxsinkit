import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { importStreamTokenKey, mintStreamToken, STREAM_READ_EXPOSED_HEADERS } from "@pgxsinkit/server";

import { createBoardStreamHandler } from "../../apps/board-api/src/core/handlers";
import { placementCorsHeaders } from "../../scripts/placement-fixture-server";

// The edge's CORS obligation (ADR-0055 decision 8): the gate proxies durable-streams bytes, and every
// header the ds client steers by is outside the CORS response safelist. A mount that does not name them
// on `Access-Control-Expose-Headers` serves a cross-origin reader a headerless response — no error, no
// offset, so the client re-asks for `offset=-1` forever instead of going live. That failure is invisible
// to every server-side lane (node fetch ignores CORS entirely), which is why it is pinned here.

const repoRoot = join(import.meta.dir, "..", "..");

const exposedBy = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

describe("stream edge CORS exposure", () => {
  // A stand-in for durable-streams that answers with the protocol's real response headers. The gate
  // under test is the shipped one and the hop is real HTTP, so what the assertions see is what a browser
  // would be offered.
  const upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("[]", {
        headers: {
          "content-type": "application/json",
          "stream-next-offset": "0_42",
          "stream-cursor": "cur-7",
          "stream-up-to-date": "",
        },
      }),
  });

  afterAll(() => {
    void upstream.stop(true);
  });

  it("board-stream exposes every header it proxies, on the actual response", async () => {
    const secret = "board-stream-cors-secret";
    const handler = await createBoardStreamHandler({
      durableStreamsUrl: `http://127.0.0.1:${upstream.port}/v1/stream`,
      streamTokenSecret: secret,
      allowedOrigins: ["https://board.example"],
    });

    const now = Math.floor(Date.now() / 1000);
    const token = await mintStreamToken(await importStreamTokenKey(secret), {
      sub: "person-a",
      grants: [{ path: "shape/s1", shapeId: "s1", shapeKey: "issues" }],
      now,
    });

    const response = await handler(
      new Request("https://board-stream.example/board-stream/v1/stream/shape/s1?offset=-1&live=true", {
        headers: { origin: "https://board.example", authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://board.example");

    const exposed = exposedBy(response.headers.get("access-control-expose-headers"));
    for (const header of STREAM_READ_EXPOSED_HEADERS) expect(exposed).toContain(header);

    // The property that actually matters, stated over the response rather than over the constant: no
    // `stream-*` header the edge hands back is invisible to the reader it was sent for.
    const proxied = [...response.headers.keys()].filter((name) => name.startsWith("stream-"));
    expect(proxied).toContain("stream-next-offset");
    for (const header of proxied) expect(exposed).toContain(header);
  });

  it("the placement fixture exposes them on the origin its edge shares with the control plane", () => {
    const headers = placementCorsHeaders("http://localhost:4173", ["http://localhost:4173", "http://127.0.0.1:4173"]);

    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:4173");
    const exposed = exposedBy(headers["Access-Control-Expose-Headers"]);
    for (const header of STREAM_READ_EXPOSED_HEADERS) expect(exposed).toContain(header);
  });
});

// A new mount is where this regresses: the gate is a two-line thing to host, and the exposure list is
// the part with no local symptom. Any source file that both mounts the gate and decides a CORS policy
// has to name the constant.
it("every browser-facing mount of the gate names the exposure list", () => {
  const mounts: string[] = [];
  const missing: string[] = [];

  for (const pattern of ["scripts/*.ts", "apps/*/src/**/*.ts", "packages/*/src/**/*.ts"]) {
    for (const relative of new Bun.Glob(pattern).scanSync({ cwd: repoRoot })) {
      const source = readFileSync(join(repoRoot, relative), "utf8");
      if (source.includes("export const STREAM_READ_EXPOSED_HEADERS")) continue; // the definition itself
      if (!source.includes("createStreamGate(")) continue;
      // A mount with no CORS policy at all is not browser-facing — the integration lanes' in-process edge
      // is read by node `fetch`, which ignores CORS — and has nothing to expose.
      if (!source.includes("Access-Control-Allow-Origin") && !source.includes("cors(")) continue;
      mounts.push(relative);
      if (!source.includes("STREAM_READ_EXPOSED_HEADERS")) missing.push(relative);
    }
  }

  expect(missing).toEqual([]);
  // Guard the guard: a glob that matches nothing would pass silently.
  expect(mounts.length).toBeGreaterThanOrEqual(3);
});

// The list is a claim about someone else's client, so it is checked against that client rather than
// against our memory of it: every stream header name the INSTALLED `@durable-streams/client` ships must
// be exposable. Resolved from `packages/client`, the workspace package that depends on it.
it("covers every stream header name the installed durable-streams client ships", () => {
  const manifest = Bun.resolveSync("@durable-streams/client/package.json", join(repoRoot, "packages", "client"));
  const dist = readFileSync(join(dirname(manifest), "dist", "index.js"), "utf8");

  const shipped = new Set(
    [...dist.matchAll(/[`"']([Ss]tream-[A-Za-z-]+)[`"']/g)].map((match) => match[1]!.toLowerCase()),
  );

  expect(shipped.size).toBeGreaterThanOrEqual(8);
  expect(shipped).toContain("stream-next-offset");
  for (const header of shipped) expect(STREAM_READ_EXPOSED_HEADERS).toContain(header);
});
