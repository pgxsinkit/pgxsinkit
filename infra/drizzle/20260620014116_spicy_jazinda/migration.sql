CREATE TYPE "todo_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "todo_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "work_item_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "workspace_member_role" AS ENUM('member', 'manager');--> statement-breakpoint
CREATE TABLE "authors" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL,
	"owner_id" uuid,
	"modified_by" uuid,
	"created_at_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL,
	"updated_at_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY,
	"title" varchar(120) NOT NULL,
	"description" varchar(4000),
	"author_id" uuid NOT NULL,
	"owner_id" uuid,
	"modified_by" uuid,
	"status" "todo_status" DEFAULT 'todo'::"todo_status" NOT NULL,
	"priority" "todo_priority" DEFAULT 'medium'::"todo_priority" NOT NULL,
	"created_at_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL,
	"updated_at_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fk_children" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL,
	"parent_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fk_parents" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL,
	"scheduled_at" timestamp with time zone,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rls_todos" (
	"id" uuid PRIMARY KEY,
	"title" varchar(120) NOT NULL,
	"owner_id" uuid DEFAULT auth.uid()
);
--> statement-breakpoint
ALTER TABLE "rls_todos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
	"role" "workspace_member_role" DEFAULT 'member'::"workspace_member_role" NOT NULL,
	"muted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY,
	"owner_id" uuid,
	"name" varchar(120),
	"locked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations_log" (
	"id" bigserial PRIMARY KEY,
	"table_name" varchar(255),
	"operation_kind" varchar(24),
	"user_id" uuid,
	"entity_key_json" jsonb,
	"payload_json" jsonb,
	"status" varchar(32) NOT NULL,
	"error_message" text,
	"http_status" integer,
	"mutation_id" uuid,
	"mutation_seq" integer,
	"client_timestamp_us" bigint,
	"request_path" text,
	"server_timestamp_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operations_log_created_at_idx" ON "operations_log" ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operations_log_table_name_idx" ON "operations_log" ("table_name");--> statement-breakpoint
CREATE INDEX "operations_log_user_id_idx" ON "operations_log" ("user_id");--> statement-breakpoint
CREATE INDEX "operations_log_status_idx" ON "operations_log" ("status");--> statement-breakpoint
CREATE INDEX "operations_log_mutation_id_idx" ON "operations_log" ("mutation_id");--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_author_id_authors_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id");--> statement-breakpoint
ALTER TABLE "fk_children" ADD CONSTRAINT "fk_children_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "fk_parents"("id");--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");--> statement-breakpoint
CREATE POLICY "authors_select_owner_or_admin" ON "authors" AS PERMISSIVE FOR SELECT TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "authors_insert_owner_or_admin" ON "authors" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "authors_update_owner_or_admin" ON "authors" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
) WITH CHECK (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "authors_delete_owner_or_admin" ON "authors" AS PERMISSIVE FOR DELETE TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "todos_select_owner_or_admin" ON "todos" AS PERMISSIVE FOR SELECT TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "todos_insert_owner_or_admin" ON "todos" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "todos_update_owner_or_admin" ON "todos" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
) WITH CHECK (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "todos_delete_owner_or_admin" ON "todos" AS PERMISSIVE FOR DELETE TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "rls_todos_select_owner_or_admin" ON "rls_todos" AS PERMISSIVE FOR SELECT TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "rls_todos_insert_owner_or_admin" ON "rls_todos" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "rls_todos_update_owner_or_admin" ON "rls_todos" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
) WITH CHECK (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "rls_todos_delete_owner_or_admin" ON "rls_todos" AS PERMISSIVE FOR DELETE TO "authenticated" USING (
  owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(
        (
          coalesce(
            nullif(current_setting('request.jwt.claim', true), ''),
            nullif(current_setting('request.jwt.claims', true), '')
          )::jsonb -> 'app_metadata' -> 'roles'
        ),
        '[]'::jsonb
      )
    ) AS assigned_role(role_name_value)
    WHERE assigned_role.role_name_value = 'admin'
  )
);--> statement-breakpoint
CREATE POLICY "work_items_select_membership" ON "work_items" AS PERMISSIVE FOR SELECT TO "authenticated" USING (workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  ));--> statement-breakpoint
CREATE POLICY "work_items_insert_membership" ON "work_items" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
  )) AND ((workspace_id IN (
    SELECT id
    FROM workspaces
    WHERE locked = false
  )) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND muted = false
  ));--> statement-breakpoint
CREATE POLICY "work_items_update_membership" ON "work_items" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND ((workspace_id IN (
    SELECT id
    FROM workspaces
    WHERE locked = false
  )) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND muted = false
  )) WITH CHECK (((owner_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND ((workspace_id IN (
    SELECT id
    FROM workspaces
    WHERE locked = false
  )) OR workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND role = 'manager'
  )) AND workspace_id IN (
    SELECT workspace_id
    FROM workspace_members
    WHERE member_id = coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid AND muted = false
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