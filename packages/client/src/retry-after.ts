/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date, RFC 9110 §10.2.3) into ms, or null when
 * absent/unreadable.
 *
 * Shared by the two clients that honour it: the Event lane's flush loop and the stream reader. Both treat
 * it as a floor under their own backoff, never as a replacement for it.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number): number | null {
  if (headerValue == null) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) {
    return null;
  }
  return Math.max(0, parsedDate - nowMs);
}
