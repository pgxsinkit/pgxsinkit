import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_ADMIN_ID, DEMO_USER1_ID, type DemoJwtClaims } from "@pgxsinkit/demo";

import { proxyElectricShapeRequest } from "../../apps/write-api/src/electric-proxy";

const fetchMock = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

describe("electric proxy", () => {
  afterEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = originalFetch;
  });

  it("adds an ownership filter for non-admin protected table requests and disables caching", async () => {
    fetchMock.mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Vary: "Accept-Encoding",
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const request = new Request("http://localhost:3001/v1/shape-proxy?table=authors&offset=-1", {
      headers: {
        Authorization: "Bearer test-token",
      },
    });

    const response = await proxyElectricShapeRequest(request, buildClaims(DEMO_USER1_ID, ["student"]), {
      electricUrl: "http://localhost:3000/v1/shape",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0]!;

    expect(readFetchTargetUrl(targetUrl)).toBe(
      buildExpectedShapeUrl("authors", "offset=-1", `owner_id = '${DEMO_USER1_ID}'`),
    );
    expect((options as RequestInit).headers).toBeInstanceOf(Headers);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-cache, must-revalidate, max-age=0");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Expires")).toBe("0");
    expect(response.headers.get("Vary")).toBe("Accept-Encoding, Authorization");
  });

  it("does not add an ownership filter for admin requests", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const request = new Request("http://localhost:3001/v1/shape-proxy?table=todos&offset=-1", {
      headers: {
        Authorization: "Bearer admin-token",
      },
    });

    await proxyElectricShapeRequest(request, buildClaims(DEMO_ADMIN_ID, ["admin"]), {
      electricUrl: "http://localhost:3000/v1/shape",
    });

    const [targetUrl] = fetchMock.mock.calls[0]!;
    expect(readFetchTargetUrl(targetUrl)).toBe("http://localhost:3000/v1/shape?table=todos&offset=-1");
  });

  it("rejects anonymous protected table reads by forcing an always-false filter", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const request = new Request("http://localhost:3001/v1/shape-proxy?table=authors&offset=-1");

    await proxyElectricShapeRequest(request, null, {
      electricUrl: "http://localhost:3000/v1/shape",
    });

    const [targetUrl] = fetchMock.mock.calls[0]!;
    expect(readFetchTargetUrl(targetUrl)).toBe(buildExpectedShapeUrl("authors", "offset=-1", "1 = 0"));
  });
});

function readFetchTargetUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function buildExpectedShapeUrl(table: string, existingSearch: string, where: string): string {
  const url = new URL(`http://localhost:3000/v1/shape?table=${table}&${existingSearch}`);
  url.searchParams.set("where", where);
  return url.toString();
}

function buildClaims(sub: string, roles: DemoJwtClaims["app_metadata"]["roles"]): DemoJwtClaims {
  return {
    sub,
    role: "authenticated",
    email: "demo@example.local",
    aud: "authenticated",
    iat: 1_710_000_000,
    app_metadata: {
      roles,
    },
  };
}
