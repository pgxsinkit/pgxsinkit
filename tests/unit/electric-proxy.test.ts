import { afterEach, describe, expect, it, mock } from "bun:test";

import { demoSyncRegistry, DEMO_USER1_ID } from "@pgxsinkit/schema";
import { proxyElectricShapeRequest } from "@pgxsinkit/server";

const fetchMock = mock();
const originalFetch = globalThis.fetch;

describe("electric proxy", () => {
  afterEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = originalFetch;
  });

  describe("URL param merging", () => {
    it("preserves pre-existing URL params like secret token when merging client params", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape?secret=test-api-token",
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [targetUrl] = fetchMock.mock.calls[0]!;
      const urlStr = readFetchTargetUrl(targetUrl);

      expect(urlStr).toContain("secret=test-api-token");
      expect(urlStr).toContain("table=authors");
      expect(urlStr).toContain("offset=-1");
      expect(urlStr).toContain("where=");
    });

    it("preserves multiple pre-existing params when merging client params", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape?secret=abc123&experimental_compaction=true",
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [targetUrl] = fetchMock.mock.calls[0]!;
      const urlStr = readFetchTargetUrl(targetUrl);

      expect(urlStr).toContain("secret=abc123");
      expect(urlStr).toContain("experimental_compaction=true");
      expect(urlStr).toContain("table=authors");
      expect(urlStr).toContain("where=");
    });

    it("does not leak pre-existing params if electricUrl has none", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [targetUrl] = fetchMock.mock.calls[0]!;
      const urlStr = readFetchTargetUrl(targetUrl);

      expect(urlStr).toContain("table=authors");
      expect(urlStr).toContain("offset=-1");
      expect(urlStr).toContain("where=");
      expect(urlStr).not.toContain("secret=");
    });
  });

  describe("ownership filtering", () => {
    it("adds ownership filter from registry rowFilter for authenticated users", async () => {
      fetchMock.mockResolvedValue(
        new Response("ok", {
          status: 200,
          headers: { "Content-Type": "application/json", Vary: "Accept-Encoding" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [targetUrl] = fetchMock.mock.calls[0]!;

      expect(readFetchTargetUrl(targetUrl)).toBe(
        buildExpectedShapeUrl("authors", "offset=-1", `"owner_id" = '${DEMO_USER1_ID}'`),
      );
      // Proxy is transparent — headers flow through from Electric unchanged
    });

    it("blocks unauthenticated requests with 1=0 when ownership filter is configured", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(request, null, {
        registry: demoSyncRegistry,
        electricUrl: "http://localhost:3000/v1/shape",
      });

      const [targetUrl] = fetchMock.mock.calls[0]!;
      expect(readFetchTargetUrl(targetUrl)).toBe(buildExpectedShapeUrl("authors", "offset=-1", "1 = 0"));
    });

    it("does not add ownership WHERE for admin users", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID, app_metadata: { roles: ["admin"] } },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      const [targetUrl] = fetchMock.mock.calls[0]!;
      const urlStr = readFetchTargetUrl(targetUrl);
      expect(urlStr).not.toContain("where=");
    });

    it("merges registry rowFilter with existing WHERE clause from client", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1&where=active=true");

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      const [targetUrl] = fetchMock.mock.calls[0]!;
      expect(readFetchTargetUrl(targetUrl)).toBe(
        buildExpectedShapeUrl("authors", "offset=-1", `(active=true) AND ("owner_id" = '${DEMO_USER1_ID}')`),
      );
    });
  });

  describe("column omission", () => {
    it("passes JSON through unmodified when table has no omitColumns configured", async () => {
      const responsePayload = [
        {
          headers: { operation: "insert" },
          value: { id: "abc", owner_id: "present", name: "Test" },
        },
      ];
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(responsePayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as Array<Record<string, unknown>>;
      // authors.clientProjection has no omitColumns — JSON passes through unchanged
      expect(payload).toEqual(responsePayload);
    });

    it("does not modify non-JSON responses", async () => {
      fetchMock.mockResolvedValue(
        new Response("binary-data", {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("binary-data");
    });
  });

  describe("error handling", () => {
    it("returns 499 when upstream fetch is aborted (client disconnect)", async () => {
      const abortError = new Error("The connection was closed.") as Error & { code: number; name: string };
      abortError.name = "AbortError";
      abortError.code = 20;
      fetchMock.mockRejectedValue(abortError);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      expect(response.status).toBe(499);
    });

    it("re-throws non-abort fetch errors", async () => {
      const networkError = new Error("ECONNREFUSED");
      fetchMock.mockRejectedValue(networkError);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await expect(
        proxyElectricShapeRequest(
          request,
          { sub: DEMO_USER1_ID },
          {
            registry: demoSyncRegistry,
            electricUrl: "http://localhost:3000/v1/shape",
          },
        ),
      ).rejects.toThrow("ECONNREFUSED");
    });
  });
});

function readFetchTargetUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function buildExpectedShapeUrl(table: string, existingSearch: string, where: string): string {
  const url = new URL(`http://localhost:3000/v1/shape?table=${table}&${existingSearch}`);
  url.searchParams.set("where", where);
  return url.toString();
}
