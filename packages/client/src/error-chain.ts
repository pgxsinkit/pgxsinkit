/**
 * Flatten an error's `cause` chain into one message. Driver wrappers (drizzle's "Failed query: …")
 * carry the ACTUAL database error — SQLSTATE code, message, detail — on `.cause`, so surfacing only
 * `error.message` reports the query text while hiding why it failed (observed in production as a
 * degraded engine whose lastError ended at "params: [object Object]"). Every place that stringifies an
 * error into `status.lastError` or a bridge broadcast goes through this instead.
 */
export function describeErrorChain(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current != null; depth += 1) {
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : JSON.stringify(current);
    const code = typeof current === "object" && "code" in current ? (current as { code?: unknown }).code : undefined;
    const detail =
      typeof current === "object" && "detail" in current ? (current as { detail?: unknown }).detail : undefined;
    const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
    parts.push(
      [message, code != null ? `[${asText(code)}]` : undefined, detail != null ? `(${asText(detail)})` : undefined]
        .filter(Boolean)
        .join(" "),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" ← caused by: ");
}
