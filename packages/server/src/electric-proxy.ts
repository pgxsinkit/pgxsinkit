import {
  buildRowFilterShape,
  getOmittedProjectedColumnNames,
  type JwtClaims,
  type RowTransform,
  type RowTransformContext,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { resolveCorsOrigin } from "./cors-origin";

export interface ElectricProxyCors {
  /**
   * Browser origins allowed to read this shape: exact strings (e.g. a hosted SPA + localhost dev),
   * or a `"*"` entry to allow every origin by reflection (see {@link resolveCorsOrigin}).
   */
  origins: string[];
}

export interface ElectricProxyOptions {
  registry: SyncTableRegistry;
  electricUrl: string;
  /** Extra params passed to customWhere functions (e.g. fromLang, toLang). */
  extraParams?: Record<string, unknown>;
  /**
   * CORS for a browser-facing deployment with **no CORS-adding gateway in front** — e.g. a Supabase
   * Cloud edge function, which the platform routes to directly. When set, OPTIONS preflights are
   * answered here and the response carries the allowed origin plus the Electric headers the client
   * must read off each shape. Omit it where a gateway already handles CORS (the local stack's Envoy).
   */
  cors?: ElectricProxyCors;
  /**
   * Opt-in per-request timing log (default off). When on, each forwarded shape request emits one compact
   * `[pgxsinkit-timing]` line (route `"shape"`) with the request's table/live/offset and the upstream
   * Electric fetch duration + status, for attributing read-path latency. Off by default — a pure
   * diagnostic surface that adds no standing query or latency when unset.
   */
  logTimings?: boolean;
  /**
   * Append a unique `cache-buster` to every `live=true` request forwarded upstream (default ON; set
   * `false` to restore upstream CDN collapse of live long-polls). Stopgap for Electric Cloud serving
   * live long-polls from a layer blind to fresh commits: consecutive full-hold (~41s) `up-to-date`
   * responses at an unmoved offset despite an advancing `cursor`, measured cross-client propagation
   * of 40–89s (backlog 0001, 2026-07-04; upstream report alongside it). Only the live tail is busted —
   * catch-up responses keep their CDN cold-fanout sharing, and per-user-filtered live polls share
   * ~nothing across clients anyway. Remove when Electric fixes the live path (backlog 0001's close).
   */
  bustLiveUpstreamCache?: boolean;
}

const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Per-request shape-proxy timing scratch: the upstream Electric fetch duration + its HTTP status. */
interface ShapeProxyTiming {
  upstreamMs: number;
  upstreamStatus: number;
}

// Electric response headers the browser client reads off each shape response (offset/handle drive
// resumption, schema/cursor drive parsing, up-to-date ends the initial sync). They must be exposed via
// CORS or the client cannot resume — the classic Electric "MissingHeadersError".
const ELECTRIC_EXPOSED_HEADERS = "electric-offset,electric-handle,electric-schema,electric-cursor,electric-up-to-date";

/**
 * Proxies an Electric shape request, applying registry-driven row filters and stripping omitted
 * columns from JSON shape-log payloads. Optionally answers CORS preflights and adds CORS headers
 * ({@link ElectricProxyOptions.cors}) for gateway-less browser deployments.
 *
 * The caller is responsible for resolving auth claims from the request.
 * Pass `claims` as `null` for unauthenticated requests (all rows blocked).
 */
export async function proxyElectricShapeRequest(
  request: Request,
  claims: JwtClaims | null,
  options: ElectricProxyOptions,
): Promise<Response> {
  if (options.cors && request.method === "OPTIONS") {
    return corsPreflightResponse(request, options.cors);
  }
  const timing: ShapeProxyTiming | undefined = options.logTimings ? { upstreamMs: 0, upstreamStatus: 0 } : undefined;
  const start = timing ? perfNow() : 0;
  const response = await forwardShapeRequest(request, claims, options, timing);
  const finalResponse = options.cors ? withCorsResponseHeaders(request, response, options.cors) : response;
  if (timing) {
    logShapeTiming(request, timing, perfNow() - start);
  }
  return finalResponse;
}

/** Emit the one-line shape-proxy timing log: table/live/offset from the request, upstream + total ms. */
function logShapeTiming(request: Request, timing: ShapeProxyTiming, totalMs: number): void {
  const params = new URL(request.url).searchParams;
  console.log(
    "[pgxsinkit-timing]",
    JSON.stringify({
      route: "shape",
      table: params.get("table") ?? undefined,
      live: params.get("live") === "true",
      offset: params.get("offset") ?? undefined,
      upstreamMs: Math.round(timing.upstreamMs),
      upstreamStatus: timing.upstreamStatus,
      totalMs: Math.round(totalMs),
    }),
  );
}

async function forwardShapeRequest(
  request: Request,
  claims: JwtClaims | null,
  options: ElectricProxyOptions,
  timing?: ShapeProxyTiming,
): Promise<Response> {
  const decision = decideProxyTarget(request, claims, options);

  if (decision.kind === "reject") {
    // Fail closed: never forward, so the upstream Electric credentials in
    // `electricUrl` are not lent to a request the registry does not govern.
    return new Response(JSON.stringify({ message: decision.message }), {
      status: decision.status,
      headers: { "content-type": "application/json" },
    });
  }

  const upstreamStart = timing ? perfNow() : 0;
  const response = await fetch(decision.targetUrl, {
    method: "GET",
    signal: request.signal,
  }).catch((error: unknown) => {
    // Client disconnected — no meaningful response can be sent.
    // Return a 499 (client closed request) to avoid a 500 in logs.
    // Keyed on the signal's aborted state first: Bun can reject an aborted fetch with a
    // literal `null` (no AbortError to pattern-match), and once the caller aborted there is
    // nobody to answer regardless of what the rejection value looks like.
    if (request.signal.aborted || isAbortError(error)) {
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    throw error;
  });
  if (timing) {
    timing.upstreamMs = perfNow() - upstreamStart;
    timing.upstreamStatus = response.status;
  }

  const responseHeaders = new Headers(response.headers);
  // Strip encoding/length since the response body may be re-serialized
  // (column omission path) or streamed through a new Response object.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  // The ingress `table` param carries the shape's unique `shapeKey` (the client identifies the shape;
  // the proxy maps it to the physical Electric table on egress). Resolve the entry by it.
  const shapeKey = new URL(request.url).searchParams.get("table");
  const omittedColumns = shapeKey ? getOmittedProjectedColumnsForTable(options.registry, shapeKey) : [];
  const rowTransform = shapeKey ? getRowTransformForTable(options.registry, shapeKey) : undefined;
  const contentType = responseHeaders.get("content-type") ?? "";

  // Re-serialize the shape log when this table needs any row-level rewriting: column
  // omission and/or a registry-declared row transform. The transform runs first so it can
  // read a column (e.g. a control flag) that omission then strips from the client row.
  if ((omittedColumns.length > 0 || rowTransform) && contentType.includes("application/json")) {
    const payload = await response
      .clone()
      .json()
      .catch(() => undefined);

    if (Array.isArray(payload)) {
      const context: RowTransformContext = { claims, ...(options.extraParams ? { params: options.extraParams } : {}) };
      const rewritten = rewriteShapeLogEntries(payload, omittedColumns, rowTransform, context);
      return new Response(JSON.stringify(rewritten), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

type ProxyTargetDecision = { kind: "forward"; targetUrl: string } | { kind: "reject"; status: number; message: string };

/**
 * Decide whether a shape request may be forwarded. The proxy serves only
 * registry-governed shapes (ADR-0003): a request with no `table`, or one whose `table`
 * (the shape's `shapeKey`) does not match a declared shape **exactly**, is rejected and never
 * reaches Electric. A shape that is in the registry but declares no `rowFilter` still
 * forwards — the gate is registry membership, not the presence of a filter.
 */
function decideProxyTarget(
  request: Request,
  claims: JwtClaims | null,
  options: ElectricProxyOptions,
): ProxyTargetDecision {
  const requestedShapeKey = new URL(request.url).searchParams.get("table");

  if (!requestedShapeKey) {
    return { kind: "reject", status: 400, message: "Shape request must specify a table" };
  }

  if (!resolveEntryByShapeKey(options.registry, requestedShapeKey)) {
    return { kind: "reject", status: 403, message: `Shape is not in the sync registry: ${requestedShapeKey}` };
  }

  return { kind: "forward", targetUrl: buildProxyTargetUrl(request, claims, options) };
}

/**
 * Electric protocol resume/control query params a client may legitimately set on a shape request.
 * These drive resumption and long-poll; they do **not** define the shape's data. Every
 * shape-DEFINING param (`table`, `where`, `columns`, and any shape option such as `replica`) is
 * derived from the registry below, never forwarded from the client (ADR-0003 ISS-08).
 *
 * Kept as an explicit local allowlist — mirroring the `*_QUERY_PARAM` constants in
 * `@electric-sql/client` (1.5.x) — so the proxy fails **closed** on any unknown or future param
 * rather than lending it upstream Electric authority. `@electric-sql/client` exposes no aggregate
 * "protocol params" export to import, and `@pgxsinkit/server` deliberately takes no client-package
 * dependency, so the set is enumerated here with each Electric param it maps to.
 */
const ELECTRIC_CONTROL_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "offset", // OFFSET_QUERY_PARAM — resume position
  "handle", // SHAPE_HANDLE_QUERY_PARAM — shape handle
  "live", // LIVE_QUERY_PARAM — long-poll mode
  "cursor", // LIVE_CACHE_BUSTER_QUERY_PARAM — live cursor
  "cache-buster", // CACHE_BUSTER_QUERY_PARAM
  "expired_handle", // EXPIRED_HANDLE_QUERY_PARAM — resume after a handle expires
  "experimental_live_sse", // EXPERIMENTAL_LIVE_SSE_QUERY_PARAM
  "live_sse", // LIVE_SSE_QUERY_PARAM
  "log", // LOG_MODE_QUERY_PARAM
]);

function buildProxyTargetUrl(request: Request, claims: JwtClaims | null, options: ElectricProxyOptions): string {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(options.electricUrl);

  // The registry entry — resolved by the request's `shapeKey` — is the sole shape authority
  // (ADR-0003). Strip any shape-defining param riding on `electricUrl` and re-derive `table`,
  // `where`, and `columns` from the registry. The client-supplied `where` never reaches here
  // either: authorization must never depend on client-controlled SQL — there is no safe way to
  // merge untrusted raw SQL into the ownership predicate (`1=1) OR (1=1` escapes any wrapping and
  // precedence-reduces to all-rows), so the registry row filter is the only `where`.
  targetUrl.searchParams.delete("where");
  targetUrl.searchParams.delete("columns");

  // Resolve by the ingress shapeKey, then set the EGRESS `table` to the entry's physical Electric
  // target (a read projection's owning table differs from its shapeKey).
  const entry = resolveEntryByShapeKey(options.registry, requestUrl.searchParams.get("table") ?? "");
  const electricTarget = electricTargetForEntry(entry);

  if (!electricTarget) {
    // Defensive only: decideProxyTarget already validated the shapeKey against the registry before we
    // get here. Without a registry-resolved target there is no governed shape to serve.
    return targetUrl.toString();
  }

  targetUrl.searchParams.set("table", electricTarget);

  // Forward ONLY Electric protocol resume/control params from the client. A client-supplied
  // `columns`, `replica`, or any unknown/future param is never lent upstream authority — it cannot
  // alter the shape beyond what the registry authorized.
  requestUrl.searchParams.forEach((value, key) => {
    if (ELECTRIC_CONTROL_QUERY_PARAMS.has(key)) {
      targetUrl.searchParams.set(key, value);
    }
  });

  // Live-tail cache bust ({@link ElectricProxyOptions.bustLiveUpstreamCache}): a unique
  // Electric-recognized `cache-buster` per live long-poll keeps any upstream CDN from answering the
  // poll out of a collapsed/cached entry that cannot see fresh commits (backlog 0001). Catch-up
  // requests are left untouched so cold-fanout CDN sharing keeps working. Set AFTER the forward loop
  // so a client-sent buster (the stale-cache ladder rides catch-up, not live) is never clobbered on
  // non-live requests and a live request always gets a fresh one.
  if (options.bustLiveUpstreamCache !== false && targetUrl.searchParams.get("live") === "true") {
    targetUrl.searchParams.set("cache-buster", crypto.randomUUID());
  }

  const rowFilter = entry?.shape?.rowFilter;

  if (!rowFilter) {
    return targetUrl.toString();
  }

  // A `customWhere` that returns a Drizzle `SQL` fragment is emitted as a *parameterized* Electric
  // where — `where=… $1 …` plus `params[1]=…` — so no request-derived value is ever inlined/escaped by
  // hand (Drizzle owns identifiers + structure, Electric binds the leaves). `ownership`/`shared` and a
  // string `customWhere` stay inline; `buildRowFilterShape` composes both forms.
  const shape = buildRowFilterShape(rowFilter, claims, options.extraParams);

  if (shape) {
    targetUrl.searchParams.set("where", shape.where);
    shape.params.forEach((param, index) => {
      targetUrl.searchParams.set(`params[${index + 1}]`, param);
    });
  }

  // Registry-declared column projection (an explicit opt-in). Per-row `omitColumns` is enforced
  // separately by post-hoc JSON stripping (below), so an omitted column never reaches the client
  // even when no projection is set here.
  if (rowFilter.columns && rowFilter.columns.length > 0) {
    targetUrl.searchParams.set("columns", rowFilter.columns.join(","));
  }

  return targetUrl.toString();
}

/**
 * The physical Electric table an entry reads — `electricTable` (a read projection's owning table) if
 * set, otherwise the shape's own table name. This is the value the proxy sends UPSTREAM in the egress
 * `table` param; several shapes may share it (a projection and its owner), which is exactly why an
 * incoming request is resolved by `shapeKey` (below), not by this.
 */
function electricTargetForEntry(entry: SyncTableEntry | undefined): string | null {
  const shape = entry?.shape;
  if (!shape) {
    return null;
  }
  return shape.electricTable ?? shape.tableName;
}

/**
 * Resolve the registry entry a request selects by its **`shapeKey`** — the unique per-shape identity a
 * client puts in the ingress `table` param. Resolving by shapeKey (not by physical Electric target) is
 * what lets several shapes read ONE physical table: a read projection and its owner share an Electric
 * target but carry distinct shapeKeys. Schema qualification is significant (`authors` ≠
 * `private.authors`). Returns undefined when no entry declares that shapeKey — the caller fails closed.
 */
function resolveEntryByShapeKey(registry: SyncTableRegistry, requestedShapeKey: string): SyncTableEntry | undefined {
  for (const key of Object.keys(registry)) {
    const entry = registry[key as keyof typeof registry] as SyncTableEntry | undefined;
    if (entry?.shape?.shapeKey === requestedShapeKey) {
      return entry;
    }
  }
  return undefined;
}

function getOmittedProjectedColumnsForTable(registry: SyncTableRegistry, shapeKey: string): readonly string[] {
  const entry = resolveEntryByShapeKey(registry, shapeKey);
  return entry ? getOmittedProjectedColumnNames(entry) : [];
}

function getRowTransformForTable(registry: SyncTableRegistry, shapeKey: string): RowTransform | undefined {
  return resolveEntryByShapeKey(registry, shapeKey)?.serverProjection?.rowTransform;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Subset of an Electric shape-log entry the proxy rewrites: `value` carries the
 * row, `old_value` the prior row on updates. Runtime guards still validate both
 * before use; the declared shape is the wire-protocol expectation.
 */
interface ShapeLogEntry {
  value?: Record<string, unknown>;
  old_value?: Record<string, unknown>;
  [key: string]: unknown;
}

function isShapeLogEntry(value: unknown): value is ShapeLogEntry {
  return isObjectRecord(value);
}

/**
 * Rewrite each shape-log row: apply the registry row transform (if any), then strip
 * omitted columns. Both passes preserve object identity when nothing changes, so an
 * untouched entry flows through unmodified.
 */
function rewriteRow(
  row: Record<string, unknown>,
  omittedColumns: readonly string[],
  rowTransform: RowTransform | undefined,
  context: RowTransformContext,
): Record<string, unknown> {
  const transformed = rowTransform ? rowTransform(row, context) : row;
  return omittedColumns.length > 0 ? omitColumnsFromRow(transformed, omittedColumns) : transformed;
}

function rewriteShapeLogEntries(
  payload: unknown[],
  omittedColumns: readonly string[],
  rowTransform: RowTransform | undefined,
  context: RowTransformContext,
): unknown[] {
  return payload.map((entry) => {
    if (!isShapeLogEntry(entry)) {
      return entry;
    }

    let currentEntry: ShapeLogEntry = entry;

    if (isObjectRecord(entry.value)) {
      const nextValue = rewriteRow(entry.value, omittedColumns, rowTransform, context);
      if (nextValue !== entry.value) {
        currentEntry = { ...currentEntry, value: nextValue };
      }
    }

    if (isObjectRecord(currentEntry.old_value)) {
      const nextOldValue = rewriteRow(currentEntry.old_value, omittedColumns, rowTransform, context);
      if (nextOldValue !== currentEntry.old_value) {
        currentEntry = { ...currentEntry, old_value: nextOldValue };
      }
    }

    return currentEntry;
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      // Bun wraps aborted fetch as DOMException with numeric code
      (typeof (error as unknown as { code?: unknown }).code === "number" &&
        (error as unknown as { code: number }).code === 20))
  );
}

/** The request's `Origin` if it is on the allow-list, else `null` (so a disallowed origin gets no CORS). */
function allowedCorsOrigin(request: Request, cors: ElectricProxyCors): string | null {
  return resolveCorsOrigin(request, cors.origins);
}

/** Answer a browser preflight: allowed origin, GET-only, the requested headers, cached for an hour. */
function corsPreflightResponse(request: Request, cors: ElectricProxyCors): Response {
  const headers = new Headers();
  const origin = allowedCorsOrigin(request, cors);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  // Echo what the browser asks to send (authorization + apikey for a Supabase function), falling back
  // to the standard set — so any client header is permitted without enumerating every one here.
  headers.set(
    "Access-Control-Allow-Headers",
    request.headers.get("access-control-request-headers") ?? "authorization,apikey,content-type",
  );
  headers.set("Access-Control-Max-Age", "3600");
  return new Response(null, { status: 204, headers });
}

/** Add the allowed origin + the exposed Electric headers to a real shape response (no-op off-list). */
function withCorsResponseHeaders(request: Request, response: Response, cors: ElectricProxyCors): Response {
  const origin = allowedCorsOrigin(request, cors);
  if (!origin) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", ELECTRIC_EXPOSED_HEADERS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function omitColumnsFromRow(row: Record<string, unknown>, omittedColumns: readonly string[]): Record<string, unknown> {
  let changed = false;
  const nextRow = { ...row };

  for (const column of omittedColumns) {
    if (Object.prototype.hasOwnProperty.call(nextRow, column)) {
      delete nextRow[column];
      changed = true;
    }
  }

  return changed ? nextRow : row;
}
