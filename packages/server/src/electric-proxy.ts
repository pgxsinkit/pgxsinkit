import {
  buildRowFilterWhere,
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

function buildProxyTargetUrl(request: Request, claims: JwtClaims | null, options: ElectricProxyOptions): string {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(options.electricUrl);

  // Merge incoming request params into the electric URL, preserving any pre-existing
  // params (e.g. the secret API token from electricUrl). The client-supplied `where` is
  // deliberately NOT forwarded: authorization must never depend on client-controlled SQL
  // (ADR-0003). There is no safe way to merge untrusted raw SQL into the ownership
  // predicate — unbalanced parens/operators escape any wrapping (e.g. `1=1) OR (1=1`
  // becomes `(1=1) OR (1=1) AND (owner=…)`, which precedence reduces to all-rows). The
  // only `where` that reaches Electric is the registry-derived filter set below.
  requestUrl.searchParams.forEach((value, key) => {
    if (key === "where") {
      return;
    }
    targetUrl.searchParams.set(key, value);
  });
  // Belt-and-braces: never let a `where` from `electricUrl`'s own query string survive
  // either — the row filter is the sole authority.
  targetUrl.searchParams.delete("where");

  const table = targetUrl.searchParams.get("table");

  if (!table) {
    return targetUrl.toString();
  }

  const rowFilter = resolveEntryByElectricTarget(options.registry, table)?.shape?.rowFilter;

  if (!rowFilter) {
    return targetUrl.toString();
  }

  const whereClause = buildRowFilterWhere(rowFilter, claims, options.extraParams);

  if (whereClause) {
    targetUrl.searchParams.set("where", whereClause);
  }

  // Apply column projection from registry if configured
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
