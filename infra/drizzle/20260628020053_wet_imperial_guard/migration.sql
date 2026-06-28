ALTER POLICY "work_items_select_membership" ON "work_items" TO "authenticated" USING ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where "workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid))));--> statement-breakpoint
ALTER POLICY "work_items_insert_membership" ON "work_items" TO "authenticated" WITH CHECK ((((("work_items"."owner_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where "workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)))))) and ((((("work_items"."workspace_id" = any(array(select "workspaces"."id" from "workspaces" where "workspaces"."locked" = false))) or ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."role" = 'manager'))))))) and ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."muted" = false)))))))));--> statement-breakpoint
ALTER POLICY "work_items_update_membership" ON "work_items" TO "authenticated" USING ((((("work_items"."owner_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) or ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."role" = 'manager'))))))) and ((((("work_items"."workspace_id" = any(array(select "workspaces"."id" from "workspaces" where "workspaces"."locked" = false))) or ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."role" = 'manager'))))))) and ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."muted" = false))))))))) WITH CHECK ((((("work_items"."owner_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) or ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."role" = 'manager'))))))) and ((((("work_items"."workspace_id" = any(array(select "workspaces"."id" from "workspaces" where "workspaces"."locked" = false))) or ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."role" = 'manager'))))))) and ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."muted" = false)))))))));--> statement-breakpoint
ALTER POLICY "work_items_delete_membership" ON "work_items" TO "authenticated" USING ((("work_items"."owner_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) or ("work_items"."workspace_id" = any(array(select "workspace_members"."workspace_id" from "workspace_members" where (("workspace_members"."member_id" = (select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid)) and ("workspace_members"."role" = 'manager')))))));