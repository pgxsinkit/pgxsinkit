ALTER TABLE "authors" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "authors" ADD COLUMN "modified_by" uuid;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "todos" ADD COLUMN "modified_by" uuid;--> statement-breakpoint
ALTER TABLE "operations_log" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "authors" ALTER COLUMN "created_at_us" SET DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)));--> statement-breakpoint
ALTER TABLE "authors" ALTER COLUMN "updated_at_us" SET DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)));--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "created_at_us" SET DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)));--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "updated_at_us" SET DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)));--> statement-breakpoint
ALTER TABLE "operations_log" ALTER COLUMN "server_timestamp_us" SET DEFAULT (floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)));--> statement-breakpoint
CREATE INDEX "operations_log_user_id_idx" ON "operations_log" ("user_id");