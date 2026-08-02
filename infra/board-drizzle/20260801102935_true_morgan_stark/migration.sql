CREATE TABLE "board_issue_view_event" (
	"event_id" uuid PRIMARY KEY,
	"viewer_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"occurred_at_us" bigint NOT NULL,
	"received_at_us" bigint DEFAULT public.pgxsinkit_clock_us() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_issue_view_event" ENABLE ROW LEVEL SECURITY;