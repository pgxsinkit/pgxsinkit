CREATE TYPE "todo_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "todo_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "description" SET DATA TYPE varchar(4000) USING "description"::varchar(4000);--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "status" SET DATA TYPE "todo_status" USING "status"::"todo_status";--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "status" SET DEFAULT 'todo'::"todo_status";--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "priority" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "priority" SET DATA TYPE "todo_priority" USING "priority"::"todo_priority";--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "priority" SET DEFAULT 'medium'::"todo_priority";