import { describe, expect, it } from "bun:test";

import { FetchRouter } from "@pgxsinkit/server";

// CORS origin resolution on the router (shared with the electric proxy via resolveCorsOrigin):
// exact-match allow-list, plus the "*" entry that reflects any request origin — used by dev/demo
// deployments where auth is a bearer token and enumerating every local origin is churn.
describe("FetchRouter — CORS origins", () => {
  function buildRouter(origins: string[]): FetchRouter {
    const router = new FetchRouter();
    router.get("/thing", () => new Response("ok"));
    router.setCors({ origins, allowMethods: ["GET", "POST"], allowHeaders: ["authorization"] }, [{ exact: "/thing" }]);
    return router;
  }

  it("allows an exact-match origin and denies others (fails closed)", async () => {
    const router = buildRouter(["http://localhost:5660"]);

    const allowed = await router.fetch(
      new Request("http://api/thing", { headers: { origin: "http://localhost:5660" } }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5660");

    const denied = await router.fetch(new Request("http://api/thing", { headers: { origin: "https://evil.example" } }));
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it('a "*" entry reflects any origin on preflight and response', async () => {
    const router = buildRouter(["*"]);

    const preflight = await router.fetch(
      new Request("http://api/thing", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:6111", "access-control-request-headers": "authorization" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:6111");

    const response = await router.fetch(
      new Request("http://api/thing", { headers: { origin: "http://localhost:7222" } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:7222");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it('"*" adds no CORS headers when the request has no Origin', async () => {
    const router = buildRouter(["*"]);
    const response = await router.fetch(new Request("http://api/thing"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
