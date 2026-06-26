import { afterEach, describe, expect, it, mock } from "bun:test";

import { demoSyncRegistry, DEMO_USER1_ID } from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";

// createSyncServer owns the read-path shape proxy when given `electricUrl`, sharing
// the single resolveAuthClaims adapter with the write path (ADR-0003). The proxy
// route is exercised through `server.fetch` so the Hono wiring is under test, not
// just the proxy function. operationsLog is disabled so construction never touches db.

const fetchMock = mock();
const originalFetch = globalThis.fetch;

function makeServer(resolveAuthClaims?: (request: Request) => unknown) {
  return createSyncServer({
    registry: demoSyncRegistry,
    db: {} as never,
    electricUrl: "http://localhost:3000/v1/shape?secret=test-api-token",
    shapeProxyPath: "/api/shape",
    operationsLog: { enabled: false },
    ...(resolveAuthClaims ? { resolveAuthClaims: resolveAuthClaims as never } : {}),
  });
}

describe("createSyncServer shape proxy", () => {
  afterEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = originalFetch;
  });

  it("serves the shape proxy route and forwards a registered table", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = makeServer(() => ({ sub: DEMO_USER1_ID }));

    const response = await server.fetch(new Request("http://localhost/api/shape?table=authors&offset=-1"));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a table absent from the registry through the route", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = makeServer(() => ({ sub: DEMO_USER1_ID }));

    const response = await server.fetch(new Request("http://localhost/api/shape?table=unknown_table&offset=-1"));

    expect(response.status).toBe(403);
    // Upstream Electric credentials are never lent to an ungoverned table.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes the proxy through the shared resolveAuthClaims adapter", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Same adapter as the write path: returning null must block all rows via the
    // filter's DENY_ALL sentinel (false), proving the proxy used the resolved claims.
    const server = makeServer(() => null);

    await server.fetch(new Request("http://localhost/api/shape?table=authors&offset=-1"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target] = fetchMock.mock.calls[0]!;
    // proxyElectricShapeRequest fetches with a string URL (buildProxyTargetUrl).
    const targetUrl = new URL(target as string);
    expect(targetUrl.searchParams.get("where")).toBe("false");
  });

  it("does not register a shape proxy when electricUrl is omitted", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = createSyncServer({
      registry: demoSyncRegistry,
      db: {} as never,
      operationsLog: { enabled: false },
      resolveAuthClaims: (() => ({ sub: DEMO_USER1_ID })) as never,
    });

    const response = await server.fetch(new Request("http://localhost/api/shape?table=authors&offset=-1"));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
