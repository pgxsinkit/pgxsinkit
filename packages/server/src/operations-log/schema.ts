import { sql } from "drizzle-orm";
import { bigint, bigserial, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

const nowMicrosecondsSql = sql`(floor((EXTRACT(epoch FROM clock_timestamp()) * (1000000)::numeric)))`;

export const operationsLogTable = pgTable(
  "operations_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tableName: varchar("table_name", { length: 255 }),
    operationKind: varchar("operation_kind", { length: 24 }),
    userId: uuid("user_id"),
    entityKeyJson: jsonb("entity_key_json"),
    payloadJson: jsonb("payload_json"),
    status: varchar("status", { length: 32 }).notNull(),
    errorMessage: text("error_message"),
    httpStatus: integer("http_status"),
    mutationId: uuid("mutation_id"),
    mutationSeq: integer("mutation_seq"),
    clientTimestampUs: bigint("client_timestamp_us", { mode: "bigint" }),
    requestPath: text("request_path"),
    serverTimestampUs: bigint("server_timestamp_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("operations_log_created_at_idx").on(table.createdAt.desc()),
    index("operations_log_table_name_idx").on(table.tableName),
    index("operations_log_user_id_idx").on(table.userId),
    index("operations_log_status_idx").on(table.status),
    index("operations_log_mutation_id_idx").on(table.mutationId),
  ],
);

export type OperationsLogRow = typeof operationsLogTable.$inferSelect;
export type NewOperationsLogRow = typeof operationsLogTable.$inferInsert;
