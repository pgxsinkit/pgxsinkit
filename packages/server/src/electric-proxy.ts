import {
  buildRowFilterShape,
  getOmittedProjectedColumnNames,
  type JwtClaims,
  type RowTransform,
  type RowTransformContext,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

export interface ElectricProxyOptions {
  registry: SyncTableRegistry;
  electricUrl: string;
  /** Extra params passed to customWhere functions (e.g. fromLang, toLang). */
  extraParams?: Record<string, unknown>;
}

/**
 * Proxies an Electric shape request, applying registry-driven row filters
 * and stripping omitted columns from JSON shape-log payloads.
 *
 * The caller is responsible for resolving auth claims from the request.
 * Pass `claims` as `null` for unauthenticated requests (all rows blocked).
 */
export async function proxyElectricShapeRequest(
  request: Request,
  claims: JwtClaims | null,
  options: ElectricProxyOptions,
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

  const response = await fetch(decision.targetUrl, {
    method: "GET",
    signal: request.signal,
  }).catch((error: unknown) => {
    if (isAbortError(error)) {
      // Client disconnected — no meaningful response can be sent.
      // Return a 499 (client closed request) to avoid a 500 in logs.
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    throw error;
  });

  const responseHeaders = new Headers(response.headers);
  // Strip encoding/length since the response body may be re-serialized
  // (column omission path) or streamed through a new Response object.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  const table = new URL(request.url).searchParams.get("table");
  const omittedColumns = table ? getOmittedProjectedColumnsForTable(options.registry, table) : [];
  const rowTransform = table ? getRowTransformForTable(options.registry, table) : undefined;
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
 * does not match a declared Electric shape target **exactly**, is rejected and never
 * reaches Electric. A table that is in the registry but declares no `rowFilter` still
 * forwards — the gate is registry membership, not the presence of a filter.
 */
function decideProxyTarget(
  request: Request,
  claims: JwtClaims | null,
  options: ElectricProxyOptions,
): ProxyTargetDecision {
  const requestedTable = new URL(request.url).searchParams.get("table");

  if (!requestedTable) {
    return { kind: "reject", status: 400, message: "Shape request must specify a table" };
  }

  if (!resolveEntryByElectricTarget(options.registry, requestedTable)) {
    return { kind: "reject", status: 403, message: `Table is not in the sync registry: ${requestedTable}` };
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

  // The registry entry — keyed by its exact Electric target — is the sole shape authority
  // (ADR-0003). Strip any shape-defining param riding on `electricUrl` and re-derive `table`,
  // `where`, and `columns` from the registry. The client-supplied `where` never reaches here
  // either: authorization must never depend on client-controlled SQL — there is no safe way to
  // merge untrusted raw SQL into the ownership predicate (`1=1) OR (1=1` escapes any wrapping and
  // precedence-reduces to all-rows), so the registry row filter is the only `where`.
  targetUrl.searchParams.delete("where");
  targetUrl.searchParams.delete("columns");

  const entry = resolveEntryByElectricTarget(options.registry, requestUrl.searchParams.get("table") ?? "");
  const electricTarget = electricTargetForEntry(entry);

  if (!electricTarget) {
    // Defensive only: decideProxyTarget already validated the table against the registry before we
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
 * The exact Electric shape target an entry declares — `electricTable` if set, otherwise
 * the Drizzle table name. This is the string a client puts in the `table` param and the
 * one Electric receives, so it is the unit of allowlisting.
 */
function electricTargetForEntry(entry: SyncTableEntry | undefined): string | null {
  const shape = entry?.shape;
  if (!shape) {
    return null;
  }
  return shape.electricTable ?? shape.tableName;
}

/**
 * Resolve the registry entry whose declared Electric target equals `requestedTable`
 * **exactly**. Schema qualification is significant: an `authors` entry does not authorize
 * `private.authors` (a different table in a different schema). Returns undefined when no
 * entry declares that exact target — the caller fails closed.
 */
function resolveEntryByElectricTarget(registry: SyncTableRegistry, requestedTable: string): SyncTableEntry | undefined {
  for (const key of Object.keys(registry)) {
    const entry = registry[key as keyof typeof registry] as SyncTableEntry | undefined;
    if (electricTargetForEntry(entry) === requestedTable) {
      return entry;
    }
  }
  return undefined;
}

function getOmittedProjectedColumnsForTable(registry: SyncTableRegistry, table: string): readonly string[] {
  const entry = resolveEntryByElectricTarget(registry, table);
  return entry ? getOmittedProjectedColumnNames(entry) : [];
}

function getRowTransformForTable(registry: SyncTableRegistry, table: string): RowTransform | undefined {
  return resolveEntryByElectricTarget(registry, table)?.serverProjection?.rowTransform;
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
