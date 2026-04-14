CREATE TABLE "authors" (
	"id" uuid PRIMARY KEY,
	"name" varchar(120) NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY,
	"title" varchar(120) NOT NULL,
	"description" text,
	"author_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'todo' NOT NULL,
	"priority" varchar(24) DEFAULT 'medium' NOT NULL,
	"created_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL,
	"updated_at_us" bigint DEFAULT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_author_id_authors_id_fkey" FOREIGN KEY ("author_id") REFERENCES "authors"("id");