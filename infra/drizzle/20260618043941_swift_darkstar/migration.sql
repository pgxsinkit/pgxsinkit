CREATE TYPE "work_item_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "workspace_member_role" AS ENUM('member', 'manager');--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid,
	"body" varchar(4000) NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"status" "work_item_status" DEFAULT 'open'::"work_item_status" NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"role" "workspace_member_role" DEFAULT 'member'::"workspace_member_role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY,
	"owner_id" uuid
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
CREATE POLICY "work_items_select_membership" ON "work_items" AS PERMISSIVE FOR SELECT TO "authenticated" USING (workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  ));--> statement-breakpoint
CREATE POLICY "work_items_insert_membership" ON "work_items" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  ));--> statement-breakpoint
CREATE POLICY "work_items_update_membership" ON "work_items" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) WITH CHECK ((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  ));--> statement-breakpoint
CREATE POLICY "work_items_delete_membership" ON "work_items" AS PERMISSIVE FOR DELETE TO "authenticated" USING ((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  ));