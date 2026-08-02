import { createBoardIssueViewConsumer } from "../core/issue-view-consumer";
import { createBunBoardDb } from "./bun-db";
import { requireEnv } from "./env";

/**
 * The board's Event-lane consumer PROCESS (pgxsinkit ADR-0053 decision 7): a long-lived Bun process beside
 * `bun.ts` (the board's fetch host), not a route on it. The toolkit's runner is the first long-lived server
 * artifact it ships, deliberately separate from the serverless posture the write/sync functions run under —
 * so the board hosts it the same way: its own entry, its own script, started by hand for the demo.
 *
 * It runs against the same board database the write function writes to. The queues it reads are provisioned
 * at deploy time by the event-lane migration (`bun run db:board:events`), never created here.
 *
 * `bun run --cwd apps/board-api consumer`
 */
const databaseUrl = requireEnv(
  process.env,
  ["BOARD_DATABASE_URL", "DATABASE_URL", "SUPABASE_DB_URL"],
  "BOARD_DATABASE_URL, DATABASE_URL or SUPABASE_DB_URL is required for the board event consumer.",
);

const consumer = createBoardIssueViewConsumer({
  db: createBunBoardDb(databaseUrl),
  onArchived: (count) => {
    console.log(`[board-consumer] archived ${count} board_issue_viewed event(s)`);
  },
});

console.log("[board-consumer] starting — polling pgxsinkit_events_board_issue_viewed");
consumer.start();

// The app owns its process lifecycle: the runner has no supervisor and no signal handling of its own, so
// the graceful stop (no new reads, in-flight callbacks awaited) is wired here.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[board-consumer] ${signal} — draining in-flight callbacks…`);
    void consumer.stop().then(() => {
      console.log("[board-consumer] stopped");
      process.exit(0);
    });
  });
}
