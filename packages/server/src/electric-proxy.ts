import { buildRowFilterWhere, getOmittedProjectedColumnNames, type SyncTableRegistry } from "@pgxsinkit/contracts";

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
  claims: Record<string, unknown> | null,
  options: ElectricProxyOptions,
): Promise<Response> {
  const targetUrl = buildProxyTargetUrl(request, claims, options);

  const response = await fetch(targetUrl, {
    method: "GET",
    headers: buildForwardHeaders(request.headers),
    signal: request.signal,
  });

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("Vary", appendVaryHeader(headers.get("Vary"), "Authorization"));

  const table = new URL(request.url).searchParams.get("table");
  const omittedColumns = table ? getOmittedProjectedColumnsForTable(options.registry, table) : [];
  const contentType = headers.get("content-type") ?? "";

  if (omittedColumns.length > 0 && contentType.includes("application/json")) {
    const payload = await response
      .clone()
      .json()
      .catch(() => undefined);

    if (Array.isArray(payload)) {
      const stripped = stripOmittedColumnsFromShapeLogEntries(payload, omittedColumns);
      return new Response(JSON.stringify(stripped), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildProxyTargetUrl(
  request: Request,
  claims: Record<string, unknown> | null,
  options: ElectricProxyOptions,
): string {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(options.electricUrl);

  // Merge incoming request params into the electric URL, preserving
  // any pre-existing params (e.g. secret API token from electricUrl).
  requestUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  const table = targetUrl.searchParams.get("table");

  if (!table) {
    return targetUrl.toString();
  }

  const entry = getRegistryEntry(options.registry, table);

  if (!entry) {
    return targetUrl.toString();
  }

  const rowFilter = entry.shape?.rowFilter;

  if (!rowFilter) {
    return targetUrl.toString();
  }

  const whereClause = buildRowFilterWhere(rowFilter, claims, options.extraParams);

  if (!whereClause) {
    return targetUrl.toString();
  }

  const existingWhere = targetUrl.searchParams.get("where");

  if (!existingWhere) {
    targetUrl.searchParams.set("where", whereClause);
  } else {
    targetUrl.searchParams.set("where", `(${existingWhere}) AND (${whereClause})`);
  }

  // Apply column projection from registry if configured
  if (rowFilter.columns && rowFilter.columns.length > 0) {
    targetUrl.searchParams.set("columns", rowFilter.columns.join(","));
  }

  return targetUrl.toString();
}

function getRegistryEntry(registry: SyncTableRegistry, table: string) {
  // Table names may be qualified (schema.table) — normalize to just the table name
  const parts = table.split(".");
  const key = parts.at(-1) ?? table;
  return registry[key as keyof typeof registry];
}

function getOmittedProjectedColumnsForTable(registry: SyncTableRegistry, table: string): readonly string[] {
  const entry = getRegistryEntry(registry, table);
  return entry ? getOmittedProjectedColumnNames(entry) : [];
}

function buildForwardHeaders(headers: Headers): Headers {
  const next = new Headers();

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();

    if (lower === "host" || lower === "authorization") {
      continue;
    }

    next.set(name, value);
  }

  return next;
}

function appendVaryHeader(existingValue: string | null, nextValue: string): string {
  if (!existingValue) {
    return nextValue;
  }

  const values = existingValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.includes(nextValue)) {
    return values.join(", ");
  }

  values.push(nextValue);
  return values.join(", ");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripOmittedColumnsFromShapeLogEntries(payload: unknown[], omittedColumns: readonly string[]): unknown[] {
  return payload.map((entry) => {
    if (!isObjectRecord(entry)) {
      return entry;
    }

    let nextEntry: Record<string, unknown> | null = null;

    if (isObjectRecord(entry.value)) {
      const nextValue = omitColumnsFromRow(entry.value, omittedColumns);
      if (nextValue !== entry.value) {
        nextEntry = { ...entry, value: nextValue };
      }
    }

    const currentEntry = nextEntry ?? entry;
    if (isObjectRecord(currentEntry.old_value)) {
      const nextOldValue = omitColumnsFromRow(currentEntry.old_value, omittedColumns);
      if (nextOldValue !== currentEntry.old_value) {
        return { ...currentEntry, old_value: nextOldValue };
      }
    }

    return currentEntry;
  });
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
