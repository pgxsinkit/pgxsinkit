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
	"description" text,
	"author_id" uuid NOT NULL,
	"owner_id" uuid,
	"modified_by" uuid,
	"status" varchar(24) DEFAULT 'todo' NOT NULL,
	"priority" varchar(24) DEFAULT 'medium' NOT NULL,
	"created_at_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL,
	"updated_at_us" bigint DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric))) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "operations_log" (
	"id" bigserial PRIMARY KEY,
	"source" varchar(24) NOT NULL,
	"backend" varchar(24) NOT NULL,
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
);