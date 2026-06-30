import { afterEach, describe, expect, it, mock } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";

import { defineReadProjection, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
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

  it("resolves two shapes over ONE physical table by shapeKey — a read projection and its owner", async () => {
    // An owner (full table, learner where) + a defineReadProjection over it (admin where, light column
    // subset). Both read the physical `papers` table; the proxy must tell them apart by shapeKey, map
    // each to the physical table on egress, and apply each shape's own where + column allow-list.
    const owner = defineSyncTable({
      tableName: "papers",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        title: varchar("title", { length: 200 }).notNull(),
        body: varchar("body", { length: 9000 }).notNull(),
      }),
      mode: "readonly",
      shape: { rowFilter: { customWhere: () => "title = 'owner'" } },
    });
    const adminSummary = defineReadProjection(owner, {
      as: "papers_admin_summary",
      columns: ["title"],
      rowFilter: { customWhere: () => "title = 'admin'" },
    });
    const registry = defineSyncRegistry({ papers: owner, papersAdminSummary: adminSummary });

    fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const server = createSyncServer({
      registry,
      db: {} as never,
      electricUrl: "http://localhost:3000/v1/shape?secret=test-api-token",
      shapeProxyPath: "/api/shape",
      operationsLog: { enabled: false },
      resolveAuthClaims: (() => ({ sub: DEMO_USER1_ID })) as never,
    });

    // The PROJECTION resolves by its own shapeKey (would 403 under the old electric-target resolution),
    // egresses to the PHYSICAL table, and carries its admin where + light column allow-list.
    const adminRes = await server.fetch(new Request("http://localhost/api/shape?table=papers_admin_summary&offset=-1"));
    expect(adminRes.status).toBe(200);
    const adminUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(adminUrl.searchParams.get("table")).toBe("papers");
    expect(adminUrl.searchParams.get("where")).toBe("title = 'admin'");
    expect(adminUrl.searchParams.get("columns")?.split(",").sort()).toEqual(["id", "title"]);

    // The OWNER resolves to its own full shape — same physical table, its own where, no allow-list.
    fetchMock.mockClear();
    const ownerRes = await server.fetch(new Request("http://localhost/api/shape?table=papers&offset=-1"));
    expect(ownerRes.status).toBe(200);
    const ownerUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(ownerUrl.searchParams.get("table")).toBe("papers");
    expect(ownerUrl.searchParams.get("where")).toBe("title = 'owner'");
    expect(ownerUrl.searchParams.get("columns")).toBeNull();
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
