import type { EventConsumer } from "@pgxsinkit/server";

import type { BoardDb, FetchHandler } from "./handlers";
import { createBoardIssueViewConsumer } from "./issue-view-consumer";

/**
 * The board's **serverless drain** for the Event lane (pgxsinkit ADR-0053, amendment 2026-08-02).
 *
 * `bun-consumer.ts` — the long-lived runner — is still the board's primary and local mode. But the board
 * also deploys to managed Supabase, where the ONLY compute is edge functions: nothing can hold a `start()`,
 * so on that stack the queue would simply never drain. This is the third function that fixes it. It runs
 * exactly the same consumer the long-lived process runs (`createBoardIssueViewConsumer`), in the toolkit's
 * bounded-drain mode: one `drainOnce()` pass per invocation.
 *
 * Two things invoke it, and the split matters:
 *
 * - **A Supabase Cron schedule (every 10 s) is the delivery GUARANTEE.** It sweeps whatever is queued,
 *   whoever put it there, however the ingest went.
 * - **The ingest-side nudge is only LATENCY** ({@link createBoardDrainNudge}, wired into board-write's
 *   `onEventsEnqueued`): it fetches this endpoint fire-and-forget the moment a batch is enqueued, so a
 *   click in the demo archives in milliseconds instead of up to ten seconds later. A lost nudge costs
 *   nothing but that.
 *
 * Overlapping invocations are safe by design — a nudge landing on top of a cron tick just means two readers
 * on one pgmq queue, which the visibility timeout arbitrates exactly as it would two long-lived runners.
 *
 * **Auth is a shared secret, not a user session.** Nothing about this endpoint is per-user: it is
 * infrastructure talking to infrastructure (pg_cron's `net.http_post`, and board-write's own worker), and
 * neither has a GoTrue session to present. So the gate is a constant-time compare of a header against
 * `BOARD_EVENTS_DRAIN_SECRET`, and the function deploys with `verify_jwt = false` for the same reason
 * board-write and board-sync do — the function itself is the single auth point.
 */

/** The header the caller presents the shared secret in. */
export const BOARD_EVENTS_DRAIN_SECRET_HEADER = "x-board-drain-secret";

/**
 * The board's per-invocation drain budget.
 *
 * Well under Supabase's edge wall-clock cap (and under the vendored local router's 60 s worker budget),
 * and deliberately under the 10-second cron cadence too: a pass that finds work normally finishes before
 * the next tick starts, so ticks rarely overlap — and when a backlog does make them overlap, that is safe.
 * A pass cut short by the budget reports `empty: false`, and the next tick picks the rest up.
 */
export const BOARD_EVENTS_DRAIN_BUDGET_MS = 8_000;

export interface BoardEventsDrainHandlerOptions {
  /**
   * The runner to drain. Production passes the board's own consumer; {@link createBoardIssueViewDrainHandler}
   * is the one-liner that builds it from a `db`.
   *
   * A FRESH consumer per handler, and a fresh handler per worker, is the intended shape: the toolkit's
   * handle drives one pacing mode at a time and its lifecycle is one-way, while construction is query-free
   * — so a per-request edge worker building one costs nothing.
   */
  consumer: Pick<EventConsumer, "drainOnce">;
  /** The shared secret the caller must present in {@link BOARD_EVENTS_DRAIN_SECRET_HEADER}. */
  secret: string;
  /** Defaults to {@link BOARD_EVENTS_DRAIN_BUDGET_MS}. */
  budgetMs?: number;
}

export function createBoardEventsDrainHandler(options: BoardEventsDrainHandlerOptions): FetchHandler {
  if (!options.secret) {
    // Fail at construction, loudly: a drain function that accepted an empty secret would be an unauthenticated
    // public endpoint that runs database work.
    throw new Error("board: the events-drain handler needs a non-empty shared secret (BOARD_EVENTS_DRAIN_SECRET).");
  }
  const budgetMs = options.budgetMs ?? BOARD_EVENTS_DRAIN_BUDGET_MS;

  return async (request) => {
    if (request.method !== "POST") {
      // The endpoint does work and is invoked by machines; GET is never right, and answering 405 before the
      // secret compare keeps a browser's stray probe from costing a hash.
      return Response.json({ message: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
    }

    const presented = request.headers.get(BOARD_EVENTS_DRAIN_SECRET_HEADER);
    if (presented == null || !(await secretsMatch(presented, options.secret))) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const summary = await options.consumer.drainOnce({ budgetMs });
    // `empty: false` is the caller's "there is more" signal — the cron tick that reads it can invoke again
    // rather than waiting out its period. It is reported, never acted on here.
    console.log("[board-events-drain]", JSON.stringify(summary));
    return Response.json(summary);
  };
}

export interface BoardIssueViewDrainHandlerOptions {
  db: BoardDb;
  secret: string;
  budgetMs?: number;
}

/** The production wiring: the board's own issue-view consumer, drained one bounded pass per invocation. */
export function createBoardIssueViewDrainHandler(options: BoardIssueViewDrainHandlerOptions): FetchHandler {
  return createBoardEventsDrainHandler({
    consumer: createBoardIssueViewConsumer({ db: options.db }),
    secret: options.secret,
    ...(options.budgetMs != null ? { budgetMs: options.budgetMs } : {}),
  });
}

export interface BoardDrainNudgeOptions {
  /** The drain function's URL. Absent → no nudge is wired. */
  url: string | undefined;
  /** The shared secret. Absent → no nudge is wired. */
  secret: string | undefined;
}

/**
 * The ingest-side nudge: board-write's `onEventsEnqueued` hook (pgxsinkit ADR-0053, amendment).
 *
 * Returns `undefined` when either half of the configuration is missing, and that is a first-class outcome
 * rather than a failure — the LOCAL stack drains through the long-lived runner and wants no nudge at all,
 * so "absent env ⇒ unwired" is how one codebase serves both deployments.
 *
 * The fetch is never awaited. On Supabase, `EdgeRuntime.waitUntil` keeps the worker alive long enough for
 * the request to leave without holding the client's response; everywhere else it is a plain floating
 * promise. Either way a rejection is swallowed to a debug line: the cron sweep is the guarantee, so a lost
 * nudge costs latency only.
 */
export function createBoardDrainNudge(
  options: BoardDrainNudgeOptions,
): ((info: { streams: string[] }) => void) | undefined {
  const { url, secret } = options;
  if (!url || !secret) {
    return undefined;
  }

  return (info) => {
    const pending = fetch(url, {
      method: "POST",
      headers: { [BOARD_EVENTS_DRAIN_SECRET_HEADER]: secret, "content-type": "application/json" },
      body: JSON.stringify({ streams: info.streams }),
    }).then(
      () => undefined,
      (error: unknown) => {
        console.log("[board-events-drain] nudge failed (the cron sweep still drains)", error);
      },
    );

    const waitUntil = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime
      ?.waitUntil;
    if (typeof waitUntil === "function") {
      waitUntil(pending);
    }
  };
}

const encoder = new TextEncoder();

/**
 * Constant-time secret comparison, by construction: both sides are SHA-256'd first, so the loop always runs
 * over two 32-byte digests and neither the CONTENT nor the LENGTH of the real secret can be recovered from
 * how long the comparison took. (A naive `===`, or a byte loop over the raw strings, leaks both.)
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
