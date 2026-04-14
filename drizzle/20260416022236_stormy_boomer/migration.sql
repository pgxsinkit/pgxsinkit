CREATE TABLE "operations_log" (
	"id" bigserial PRIMARY KEY,
	"source" varchar(24) NOT NULL,
	"backend" varchar(24) NOT NULL,
	"table_name" varchar(255),
	"operation_kind" varchar(24),
	"entity_key_json" jsonb,
	"payload_json" jsonb,
	"status" varchar(32) NOT NULL,
	"error_message" text,
	"http_status" integer,
	"mutation_id" uuid,
	"mutation_seq" integer,
	"client_timestamp_us" bigint,
	"request_path" text,
	"server_timestamp_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operations_log_created_at_idx" ON "operations_log" ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operations_log_table_name_idx" ON "operations_log" ("table_name");--> statement-breakpoint
CREATE INDEX "operations_log_status_idx" ON "operations_log" ("status");--> statement-breakpoint
CREATE INDEX "operations_log_mutation_id_idx" ON "operations_log" ("mutation_id");