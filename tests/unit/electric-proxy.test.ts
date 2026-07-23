import { afterEach, describe, expect, it, mock } from "bun:test";

import { boolean, jsonb, uuid, varchar } from "drizzle-orm/pg-core";

import { defineReadProjection, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { demoSyncRegistry, DEMO_USER1_ID } from "@pgxsinkit/schema";
import { proxyElectricShapeRequest } from "@pgxsinkit/server";

// A table whose synced jsonb `payload` carries sensitive sub-documents withheld per-row
// via a `keys_withheld` control flag (which is itself omitted from the client row). The
// row transform strips the sub-document only when the flag is set — something a static
// whole-column `omitColumns` cannot express.
const secureItemsRegistry = defineSyncRegistry({
  secure_items: defineSyncTable({
    tableName: "secure_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      payload: jsonb("payload").$type<Record<string, unknown>>(),
      keysWithheld: boolean("keys_withheld").notNull().default(false),
    }),
    clientProjection: {
      omitColumns: ["keysWithheld"],
    },
    serverProjection: {
      rowTransform: (row) => (row["keys_withheld"] === true ? { ...row, payload: { stripped: true } } : row),
    },
  }),
});

// A secure "window" over a keyed table, expressed as a READ PROJECTION (not a plain entry). The owner
// carries the item body (`payload` jsonb, answer key included), a kept `metadata` column, and a
// server-only `keys_withheld` control flag. The projection streams payload + metadata and declares its
// OWN serverProjection.rowTransform (projections do NOT inherit the owner's) plus serverOnlyColumns so the
// flag is fetched for the transform yet stripped before the client wire.
const securedItemOwner = defineSyncTable({
  tableName: "secured_item",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    metadata: varchar("metadata", { length: 200 }),
    keysWithheld: boolean("keys_withheld").notNull().default(false),
  }),
});

const stripCorrectResponse = (row: Record<string, unknown>): Record<string, unknown> => {
  if (row["keys_withheld"] !== true) {
    return row;
  }
  const payload = { ...(row["payload"] as Record<string, unknown>) };
  delete payload["correctResponse"];
  return { ...row, payload };
};

const securedWindowRegistry = defineSyncRegistry({
  secured_item: securedItemOwner,
  // The redacting window: strips the answer key per row when the flag is set.
  secured_item_window: defineReadProjection(securedItemOwner, {
    as: "secured_item_window",
    columns: ["payload", "metadata"],
    serverProjection: { rowTransform: stripCorrectResponse },
    serverOnlyColumns: ["keysWithheld"],
  }),
  // Negative control: the SAME subset over the SAME owner, but with NO serverProjection — pins that a
  // projection does NOT inherit the owner's redaction and egresses the raw body.
  secured_item_window_raw: defineReadProjection(securedItemOwner, {
    as: "secured_item_window_raw",
    columns: ["payload", "metadata"],
  }),
});

// A REDACTING owner (its own egress rowTransform) with an explicit `serverProjection: "unredacted"`
// projection. The fail-closed guard forces the projection to declare a posture; here it opts out, so NO
// transform is attached and the window egresses the RAW owner body (answer key included). Proves the
// escape hatch does exactly what it says.
const redactingItemOwner = defineSyncTable({
  tableName: "redacting_item",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    metadata: varchar("metadata", { length: 200 }),
    keysWithheld: boolean("keys_withheld").notNull().default(false),
  }),
  serverProjection: { rowTransform: stripCorrectResponse },
});

const redactingWindowRegistry = defineSyncRegistry({
  redacting_item: redactingItemOwner,
  redacting_item_window: defineReadProjection(redactingItemOwner, {
    as: "redacting_item_window",
    columns: ["payload", "metadata"],
    serverProjection: "unredacted",
  }),
});

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

  describe("forwarded-param allowlist (ADR-0003 ISS-08)", () => {
    it("does not forward client-supplied shape-defining or unknown params (columns/replica/unknown)", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // A client tries to narrow/alter the upstream shape and smuggle ambient params.
      const request = new Request(
        "http://localhost:3001/v1/electric-proxy?table=authors&offset=-1&columns=id&replica=full&unknown=x",
      );

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      const [targetUrl] = fetchMock.mock.calls[0]!;
      const params = new URL(readFetchTargetUrl(targetUrl)).searchParams;
      // Shape identity is the registry's alone: client columns/replica/unknown never reach Electric.
      expect(params.get("columns")).toBeNull();
      expect(params.get("replica")).toBeNull();
      expect(params.get("unknown")).toBeNull();
      // The validated table and the registry-derived ownership where still apply — now a parameterized
      // Drizzle filter: a bound `$1` plus its value in `params[1]`, never an inlined literal.
      expect(params.get("table")).toBe("authors");
      expect(params.get("where")).toBe(`"owner_id" = $1`);
      expect(params.get("params[1]")).toBe(DEMO_USER1_ID);
    });

    it("forwards legitimate Electric resume/control params (offset/handle/live/cursor)", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request(
        "http://localhost:3001/v1/electric-proxy?table=authors&offset=0_0&handle=h1&live=true&cursor=123",
      );

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      const [targetUrl] = fetchMock.mock.calls[0]!;
      const params = new URL(readFetchTargetUrl(targetUrl)).searchParams;
      // These drive resumption/long-poll and must survive for real sync to work.
      expect(params.get("offset")).toBe("0_0");
      expect(params.get("handle")).toBe("h1");
      expect(params.get("live")).toBe("true");
      expect(params.get("cursor")).toBe("123");
    });
  });

  describe("live-tail upstream cache bust (backlog 0001 stopgap)", () => {
    const liveRequest = () =>
      new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=0_0&handle=h1&live=true&cursor=123");

    it("appends a UNIQUE cache-buster to each live=true upstream request by default", async () => {
      // A fresh Response per call — a single mockResolvedValue Response's body is consumed by the first
      // proxied request and the second would throw "ReadableStream has already been used".
      fetchMock.mockImplementation(() => Promise.resolve(new Response("ok", { status: 200 })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const options = { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" };

      await proxyElectricShapeRequest(liveRequest(), { sub: DEMO_USER1_ID }, options);
      await proxyElectricShapeRequest(liveRequest(), { sub: DEMO_USER1_ID }, options);

      const busters = fetchMock.mock.calls.map((call) =>
        new URL(readFetchTargetUrl(call[0] as Parameters<typeof fetch>[0])).searchParams.get("cache-buster"),
      );
      // Present on both, and distinct — otherwise an upstream CDN can answer a live long-poll out of a
      // collapsed/cached entry that cannot see fresh commits (the 40-89s cross-client propagation).
      expect(busters[0]).not.toBeNull();
      expect(busters[1]).not.toBeNull();
      expect(busters[0]).not.toBe(busters[1]);
    });

    it("leaves catch-up (non-live) requests unbusted so CDN cold-fanout sharing keeps working", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");
      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      const params = new URL(readFetchTargetUrl(fetchMock.mock.calls[0]![0] as Parameters<typeof fetch>[0]))
        .searchParams;
      expect(params.get("cache-buster")).toBeNull();
    });

    it("still forwards the CLIENT's own cache-buster on catch-up (the stale-cache ladder path)", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1&cache-buster=r42");
      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      const params = new URL(readFetchTargetUrl(fetchMock.mock.calls[0]![0] as Parameters<typeof fetch>[0]))
        .searchParams;
      expect(params.get("cache-buster")).toBe("r42");
    });

    it("bustLiveUpstreamCache: false restores untouched live forwarding", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await proxyElectricShapeRequest(
        liveRequest(),
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape", bustLiveUpstreamCache: false },
      );

      const params = new URL(readFetchTargetUrl(fetchMock.mock.calls[0]![0] as Parameters<typeof fetch>[0]))
        .searchParams;
      expect(params.get("cache-buster")).toBeNull();
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
        buildExpectedShapeUrl("authors", "offset=-1", `"owner_id" = $1`, [DEMO_USER1_ID]),
      );
      // Proxy is transparent — headers flow through from Electric unchanged
    });

    it("blocks unauthenticated requests with the DENY_ALL (false) sentinel when a filter is configured", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      await proxyElectricShapeRequest(request, null, {
        registry: demoSyncRegistry,
        electricUrl: "http://localhost:3000/v1/shape",
      });

      const [targetUrl] = fetchMock.mock.calls[0]!;
      expect(readFetchTargetUrl(targetUrl)).toBe(buildExpectedShapeUrl("authors", "offset=-1", "false"));
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

    it("ignores a client-supplied WHERE for a governed table — the row filter is the sole authority", async () => {
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
      // The client `where` (active=true) does not participate — only the registry ownership filter.
      expect(readFetchTargetUrl(targetUrl)).toBe(
        buildExpectedShapeUrl("authors", "offset=-1", `"owner_id" = $1`, [DEMO_USER1_ID]),
      );
    });

    it("does not let a crafted client WHERE widen access past the owner filter (precedence bypass)", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // The classic attack: a merged `(1=1) OR (1=1) AND (owner=…)` reduces (AND binds tighter
      // than OR) to all-rows. The client `where` must be dropped, never merged.
      const request = new Request(
        `http://localhost:3001/v1/electric-proxy?table=authors&offset=-1&where=${encodeURIComponent("1=1) OR (1=1")}`,
      );

      await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      const [targetUrl] = fetchMock.mock.calls[0]!;
      const resultParams = new URL(readFetchTargetUrl(targetUrl)).searchParams;
      // The crafted client `where` is dropped entirely; only the registry filter applies (parameterized).
      expect(resultParams.get("where")).toBe(`"owner_id" = $1`);
      expect(resultParams.get("params[1]")).toBe(DEMO_USER1_ID);
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

  describe("row transform (conditional sub-document projection)", () => {
    function mockShapeResponse(entries: unknown[]): void {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(entries), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }

    async function proxySecureItems(): Promise<Array<Record<string, unknown>>> {
      const request = new Request("http://localhost:3001/v1/electric-proxy?table=secure_items&offset=-1");
      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: secureItemsRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );
      return (await response.json()) as Array<Record<string, unknown>>;
    }

    it("strips the gated sub-document and drops the control flag when keys_withheld is set", async () => {
      mockShapeResponse([
        {
          headers: { operation: "insert" },
          value: { id: "i1", payload: { secret: "answer-key" }, keys_withheld: true },
        },
      ]);

      const payload = await proxySecureItems();

      expect(payload).toEqual([{ headers: { operation: "insert" }, value: { id: "i1", payload: { stripped: true } } }]);
    });

    it("keeps the sub-document when keys_withheld is unset, still dropping the control flag", async () => {
      mockShapeResponse([
        {
          headers: { operation: "insert" },
          value: { id: "i2", payload: { secret: "answer-key" }, keys_withheld: false },
        },
      ]);

      const payload = await proxySecureItems();

      expect(payload).toEqual([
        { headers: { operation: "insert" }, value: { id: "i2", payload: { secret: "answer-key" } } },
      ]);
    });

    it("applies the transform to old_value on updates too", async () => {
      mockShapeResponse([
        {
          headers: { operation: "update" },
          value: { id: "i3", payload: { secret: "new" }, keys_withheld: true },
          old_value: { id: "i3", payload: { secret: "old" }, keys_withheld: true },
        },
      ]);

      const payload = await proxySecureItems();

      expect(payload).toEqual([
        {
          headers: { operation: "update" },
          value: { id: "i3", payload: { stripped: true } },
          old_value: { id: "i3", payload: { stripped: true } },
        },
      ]);
    });
  });

  describe("read projection egress redaction (serverProjection + serverOnlyColumns)", () => {
    function mockShapeResponse(entries: unknown[]): void {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(entries), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }

    async function proxyWindow(shapeKey: string): Promise<Array<Record<string, unknown>>> {
      const request = new Request(`http://localhost:3001/v1/electric-proxy?table=${shapeKey}&offset=-1`);
      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: securedWindowRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );
      return (await response.json()) as Array<Record<string, unknown>>;
    }

    it("strips the answer key from withheld rows, leaves un-withheld rows intact, and drops keys_withheld", async () => {
      mockShapeResponse([
        {
          headers: { operation: "insert" },
          value: {
            id: "w1",
            payload: { prompt: "2+2?", correctResponse: "4" },
            metadata: "q-meta",
            keys_withheld: true,
          },
        },
        {
          headers: { operation: "insert" },
          value: {
            id: "w2",
            payload: { prompt: "3+3?", correctResponse: "6" },
            metadata: "q-meta-2",
            keys_withheld: false,
          },
        },
      ]);

      const payload = await proxyWindow("secured_item_window");

      // (a) withheld → correctResponse stripped; un-withheld → body intact. (b) keys_withheld absent from
      // every egressed row (proxy omission ran AFTER the transform). (c) kept columns (metadata) intact.
      expect(payload).toEqual([
        { headers: { operation: "insert" }, value: { id: "w1", payload: { prompt: "2+2?" }, metadata: "q-meta" } },
        {
          headers: { operation: "insert" },
          value: { id: "w2", payload: { prompt: "3+3?", correctResponse: "6" }, metadata: "q-meta-2" },
        },
      ]);
    });

    it("requests keys_withheld in the Electric fetch allow-list (server-only fetch feeds the transform)", async () => {
      mockShapeResponse([]);
      await proxyWindow("secured_item_window");

      const params = new URL(readFetchTargetUrl(fetchMock.mock.calls[0]![0] as Parameters<typeof fetch>[0]))
        .searchParams;
      const columns = (params.get("columns") ?? "").split(",");
      // Kept names + PK + the server-only fetch — so the transform can READ keys_withheld before it is stripped.
      expect(new Set(columns)).toEqual(new Set(["id", "payload", "metadata", "keys_withheld"]));
    });

    it("negative control: the same projection WITHOUT serverProjection egresses the RAW body (no inheritance)", async () => {
      mockShapeResponse([
        {
          headers: { operation: "insert" },
          value: {
            id: "w3",
            payload: { prompt: "5+5?", correctResponse: "10" },
            metadata: "q-meta-3",
            keys_withheld: true,
          },
        },
      ]);

      const payload = await proxyWindow("secured_item_window_raw");

      // No transform declared → the answer key is NOT stripped; keys_withheld is still dropped because it is
      // omitted from the client keep-set (a static omission, not the per-row transform).
      expect(payload).toEqual([
        {
          headers: { operation: "insert" },
          value: { id: "w3", payload: { prompt: "5+5?", correctResponse: "10" }, metadata: "q-meta-3" },
        },
      ]);
    });

    it('serverProjection: "unredacted" over a REDACTING owner egresses the RAW body (the opt-out does what it says)', async () => {
      mockShapeResponse([
        {
          headers: { operation: "insert" },
          value: {
            id: "w4",
            payload: { prompt: "6+6?", correctResponse: "12" },
            metadata: "q-meta-4",
            keys_withheld: true,
          },
        },
      ]);

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=redacting_item_window&offset=-1");
      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: redactingWindowRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );
      const payload = (await response.json()) as Array<Record<string, unknown>>;

      // The owner redacts, but the projection opted out with "unredacted" → no transform attached, so the
      // answer key survives. keys_withheld is still dropped (static client omission, not a per-row transform).
      expect(payload).toEqual([
        {
          headers: { operation: "insert" },
          value: { id: "w4", payload: { prompt: "6+6?", correctResponse: "12" }, metadata: "q-meta-4" },
        },
      ]);
    });
  });

  describe("fail closed (registry membership gate)", () => {
    it("rejects a table absent from the registry with 403 and does not forward", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=unknown_table&offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape?secret=test-api-token",
        },
      );

      expect(response.status).toBe(403);
      // The upstream Electric credentials must never be lent to an ungoverned table.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a schema-qualified target that is not the exact declared shape target", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // `private.authors` is a different table; the `authors` entry must NOT authorize it.
      const request = new Request("http://localhost:3001/v1/electric-proxy?table=private.authors&offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape?secret=test-api-token" },
      );

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a request with no table with 400 and does not forward", async () => {
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        {
          registry: demoSyncRegistry,
          electricUrl: "http://localhost:3000/v1/shape",
        },
      );

      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still forwards a registered table that declares no rowFilter", async () => {
      fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=secure_items&offset=-1");

      const response = await proxyElectricShapeRequest(
        request,
        { sub: DEMO_USER1_ID },
        { registry: secureItemsRegistry, electricUrl: "http://localhost:3000/v1/shape" },
      );

      expect(response.status).toBe(200);
      // Registry membership is the gate, not the presence of a filter.
      expect(fetchMock).toHaveBeenCalledTimes(1);
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

    it("returns 499 when an aborted fetch rejects with a non-Error value (Bun null rejection)", async () => {
      // Bun can reject an aborted fetch with a literal `null` (not an AbortError), so the guard
      // must key on the request signal's aborted state, not on the rejection value's shape.
      fetchMock.mockRejectedValue(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const abortController = new AbortController();
      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1", {
        signal: abortController.signal,
      });
      abortController.abort();

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

    it("re-throws a non-Error rejection when the request signal is NOT aborted", async () => {
      // Without an aborted signal a `null` rejection cannot be classified as a client
      // disconnect — it must surface to the caller like any other upstream failure.
      fetchMock.mockRejectedValue(null);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
      await expect(
        proxyElectricShapeRequest(
          request,
          { sub: DEMO_USER1_ID },
          {
            registry: demoSyncRegistry,
            electricUrl: "http://localhost:3000/v1/shape",
          },
        ),
      ).rejects.toBeNull();
    });

    it("re-throws non-abort fetch errors", async () => {
      const networkError = new Error("ECONNREFUSED");
      fetchMock.mockRejectedValue(networkError);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const request = new Request("http://localhost:3001/v1/electric-proxy?table=authors&offset=-1");

      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
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

function buildExpectedShapeUrl(table: string, existingSearch: string, where: string, params: string[] = []): string {
  const url = new URL(`http://localhost:3000/v1/shape?table=${table}&${existingSearch}`);
  url.searchParams.set("where", where);
  params.forEach((param, index) => url.searchParams.set(`params[${index + 1}]`, param));
  return url.toString();
}

describe("electric proxy — CORS (gateway-less browser deployment)", () => {
  const ORIGINS = ["https://pgxsinkit.github.io", "http://localhost:5173"];
  const originalFetch = globalThis.fetch;
  const fetchSpy = mock();
  afterEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = originalFetch;
  });

  it("answers an OPTIONS preflight from an allowed origin without forwarding to Electric", async () => {
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const request = new Request("http://fn/v1/shape?table=authors&offset=-1", {
      method: "OPTIONS",
      headers: { origin: "https://pgxsinkit.github.io", "access-control-request-headers": "authorization,apikey" },
    });

    const response = await proxyElectricShapeRequest(request, null, {
      registry: demoSyncRegistry,
      electricUrl: "http://localhost:3000/v1/shape",
      cors: { origins: ORIGINS },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://pgxsinkit.github.io");
    expect(response.headers.get("access-control-allow-headers")).toBe("authorization,apikey");
    expect(fetchSpy).not.toHaveBeenCalled(); // a preflight must never reach Electric
  });

  it("exposes the Electric headers + allowed origin on a real shape response", async () => {
    fetchSpy.mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json", "electric-offset": "0_0" } }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const request = new Request("http://fn/v1/shape?table=authors&offset=-1", {
      headers: { origin: "https://pgxsinkit.github.io", authorization: "Bearer t" },
    });

    const response = await proxyElectricShapeRequest(
      request,
      { sub: DEMO_USER1_ID },
      { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape", cors: { origins: ORIGINS } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBe("https://pgxsinkit.github.io");
    expect(response.headers.get("access-control-expose-headers")).toContain("electric-handle");
    expect(response.headers.get("access-control-expose-headers")).toContain("electric-offset");
  });

  it("gives a disallowed origin no CORS headers (fails closed)", async () => {
    fetchSpy.mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const request = new Request("http://fn/v1/shape?table=authors&offset=-1", {
      headers: { origin: "https://evil.example", authorization: "Bearer t" },
    });

    const response = await proxyElectricShapeRequest(
      request,
      { sub: DEMO_USER1_ID },
      { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape", cors: { origins: ORIGINS } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it('a "*" entry reflects any origin (never a literal * — requests carry Authorization)', async () => {
    fetchSpy.mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json", "electric-offset": "0_0" } }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const request = new Request("http://fn/v1/shape?table=authors&offset=-1", {
      headers: { origin: "http://localhost:5660", authorization: "Bearer t" },
    });

    const response = await proxyElectricShapeRequest(
      request,
      { sub: DEMO_USER1_ID },
      { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape", cors: { origins: ["*"] } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5660");
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("access-control-expose-headers")).toContain("electric-handle");
  });

  it('a "*" entry answers a preflight for any origin', async () => {
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const request = new Request("http://fn/v1/shape?table=authors&offset=-1", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:6111", "access-control-request-headers": "authorization,apikey" },
    });

    const response = await proxyElectricShapeRequest(request, null, {
      registry: demoSyncRegistry,
      electricUrl: "http://localhost:3000/v1/shape",
      cors: { origins: ["*"] },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:6111");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('"*" still yields no CORS headers for a request without an Origin', async () => {
    fetchSpy.mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const request = new Request("http://fn/v1/shape?table=authors&offset=-1", {
      headers: { authorization: "Bearer t" },
    });

    const response = await proxyElectricShapeRequest(
      request,
      { sub: DEMO_USER1_ID },
      { registry: demoSyncRegistry, electricUrl: "http://localhost:3000/v1/shape", cors: { origins: ["*"] } },
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
