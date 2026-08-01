-- Board table grants + the cross-team-move trigger — both depend on the tables existing (created by the
-- preceding schema migration), so they live here, after it.
--
-- Grants: RLS is a filter ON TOP of table privileges — without a grant, `authenticated` (the role the
-- applier switches into per batch) gets "permission denied for table …" before any policy is consulted.
-- So every table needs SELECT (the RLS subqueries read team_member, and FK checks read parent rows), and
-- the writable tables need the DML grants on top — RLS then decides which rows. The readonly tables
-- (profile/team/channel) get SELECT only, so they stay read-only for `authenticated` regardless of RLS.
-- (`team` is readwrite at the registry level but Admin-only by RLS, so it takes the DML grant too.) The
-- seed and Electric connect as a superuser, so they need none of this.
GRANT SELECT ON TABLE "profile", "team", "team_member", "channel", "issue", "message" TO "authenticated";
--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON TABLE "team", "team_member", "issue", "message" TO "authenticated";
--> statement-breakpoint
-- Attach the cross-team-move guard (function created in the prereqs migration) to `issue`.
CREATE TRIGGER issue_block_cross_team_move
  BEFORE UPDATE ON issue
  FOR EACH ROW EXECUTE FUNCTION board_block_cross_team_move();
