import { sql } from "drizzle-orm";

import { eventQueueMessageSchema, type EventQueueMessage } from "@pgxsinkit/contracts";

import {
  assertEventQueueReceipts,
  eventStreamQueueName,
  MalformedEventQueueMessageError,
  type DeadLetteredEventMessage,
  type DeliveredEventMessage,
  type EventQueue,
  type EventQueueExecutor,
  type EventQueueReadOptions,
  type EventQueueReceipt,
} from "./queue";

/**
 * The shipped {@link EventQueue} backend: **pgmq** (ADR-0053 decision 5). Postgres-native, so the Event lane
 * adds no new infrastructure to the supabase-ecosystem stacks consumers already run, and an enqueue joins the
 * endpoint's own transaction rather than crossing a second system.
 *
 * One queue per Event stream (`pgxsinkit_events_<stream>`), so a poison event or a slow consumer in one stream
 * can never head-of-line-block another. Queues are provisioned at DEPLOY time (`pgxsinkit-generate --events`),
 * never created at runtime: the endpoint may enqueue long before any runner first starts, and a
 * create-if-missing probe would put a query back in front of the zero-startup-query posture.
 *
 * **pgmq assumptions**, all read off pgmq's own extension SQL and pinned by the integration lane:
 * - The extension is NOT relocatable and its control file declares `schema = 'pgmq'`, so every call is
 *   `pgmq.`-qualified and the schema is never configurable here.
 * - Its control file declares no `requires`, so the DDL needs no `CASCADE` (pg_partman is needed only for
 *   PARTITIONED queues, which the toolkit never creates).
 * - Per-queue tables are `pgmq.q_<queue>` and `pgmq.a_<queue>` (`pgmq.format_table_name`); the archive is the
 *   dead-letter storage.
 *
 * SQL tier discipline: pgmq's surface IS a set of SQL functions and two dynamically-named tables, so Drizzle's
 * tier-1 builders cannot express any of it. Everything below is tier 2 — a tagged `sql` template with the
 * queue name and every value as BOUND PARAMETERS and each table name as a typed `sql.identifier`; no
 * identifier or value is ever baked into the template text.
 */

/**
 * The reserved key the dead-letter reason is stamped under, INSIDE the archived message body.
 *
 * Least surface, deliberately: pgmq's archive is the dead-letter storage (no library-owned DLQ table), the
 * archive row has no free column to carry a reason, and its `headers` column only exists on newer pgmq
 * versions. So the reason rides one reserved key on the ARCHIVED body — the live queue row is never mutated,
 * a normally-consumed message is byte-identical to what was enqueued, and the key is stripped again by
 * {@link EventQueue.listDeadLetters} / {@link EventQueue.requeueDeadLetter} so a requeued message is exactly
 * the message that was enqueued.
 */
export const PGMQ_DEAD_LETTER_KEY = "__pgxsinkitDeadLetter";

export interface CreatePgmqEventQueueOptions {
  /** The default executor — the server's drizzle handle. Per-call executors (a transaction) take precedence. */
  db: EventQueueExecutor;
}

interface DeliveredRow {
  receipt: string;
  deliveryCount: number;
  enqueuedAtUs: string;
  message: string;
}

interface DeadLetterRow {
  id: string;
  deliveryCount: number;
  deadLetteredAtUs: string;
  message: string;
  reason: string | null;
}

interface CountRow {
  affected: number;
}

interface ReceiptRow {
  receipt: string | null;
}

function toRows<TRow>(result: unknown): TRow[] {
  return Array.from(result as Iterable<unknown>, (row) => row as TRow);
}

/** Parse a queue body back into the contract shape, naming the offending receipt if it is not one. */
function parseQueueMessage(stream: string, receipt: EventQueueReceipt, body: string): EventQueueMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    throw new MalformedEventQueueMessageError(stream, receipt, error instanceof Error ? error.message : "invalid JSON");
  }
  const parsed = eventQueueMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MalformedEventQueueMessageError(stream, receipt, parsed.error.message);
  }
  return parsed.data;
}

export function createPgmqEventQueue(options: CreatePgmqEventQueueOptions): EventQueue {
  const run = (executor: EventQueueExecutor | undefined, query: Parameters<EventQueueExecutor["execute"]>[0]) =>
    (executor ?? options.db).execute(query);

  return {
    enqueueBatch: async (messages, executor) => {
      if (messages.length === 0) {
        return;
      }

      // Group by Event stream, preserving the order the endpoint assembled: one `send_batch` per stream, all
      // inside the CALLER's transaction, so a mixed flush batch is enqueued atomically or not at all.
      const byStream = new Map<string, EventQueueMessage[]>();
      for (const message of messages) {
        const bucket = byStream.get(message.stream);
        if (bucket) {
          bucket.push(message);
        } else {
          byStream.set(message.stream, [message]);
        }
      }

      for (const [stream, streamMessages] of byStream) {
        const queueName = eventStreamQueueName(stream);
        // The bodies ride as ONE bound json parameter expanded to `jsonb[]` in SQL — never a driver-specific
        // array binding, and never string-built SQL.
        await run(
          executor,
          sql`SELECT pgmq.send_batch(${queueName}, ARRAY(SELECT jsonb_array_elements(${JSON.stringify(streamMessages)}::text::jsonb)))`,
        );
      }
    },

    readBatch: async (stream: string, readOptions: EventQueueReadOptions): Promise<DeliveredEventMessage[]> => {
      const queueName = eventStreamQueueName(stream);
      const result = await run(
        undefined,
        sql`SELECT "msg_id"::text AS "receipt", "read_ct" AS "deliveryCount", (EXTRACT(EPOCH FROM "enqueued_at") * 1000000)::bigint::text AS "enqueuedAtUs", "message"::text AS "message" FROM pgmq.read(${queueName}, ${readOptions.visibilityTimeoutSeconds}, ${readOptions.maxMessages})`,
      );

      return toRows<DeliveredRow>(result).map((row) => ({
        receipt: row.receipt,
        stream,
        message: parseQueueMessage(stream, row.receipt, row.message),
        deliveryCount: Number(row.deliveryCount),
        enqueuedAtUs: row.enqueuedAtUs,
      }));
    },

    extendVisibility: async (stream, receipts, visibilityTimeoutSeconds, executor) => {
      if (receipts.length === 0) {
        return 0;
      }
      assertEventQueueReceipts(receipts);
      const queueName = eventStreamQueueName(stream);
      // pgmq gained an ARRAY-taking `set_vt` only in 1.8.0, while the single-message form has existed
      // throughout — and the toolkit pins no pgmq version. So the portable shape is the single-message
      // function applied over the receipts with a LATERAL: still ONE statement and one round trip, but it
      // works on every pgmq a consumer's supabase-ecosystem stack might carry. The `::int` cast picks the
      // seconds-offset overload over the `timestamptz` one.
      const result = await run(
        executor,
        sql`SELECT count(*)::int AS "affected" FROM unnest(string_to_array(${receipts.join(",")}, ',')::bigint[]) AS "renewed"("msg_id"), LATERAL pgmq.set_vt(${queueName}, "renewed"."msg_id", ${visibilityTimeoutSeconds}::int) AS "extended"`,
      );
      return Number(toRows<CountRow>(result)[0]?.affected ?? 0);
    },

    ack: async (stream, receipts) => {
      if (receipts.length === 0) {
        return 0;
      }
      assertEventQueueReceipts(receipts);
      const queueName = eventStreamQueueName(stream);
      const result = await run(
        undefined,
        sql`SELECT count(*)::int AS "affected" FROM pgmq.delete(${queueName}, string_to_array(${receipts.join(",")}, ',')::bigint[])`,
      );
      return Number(toRows<CountRow>(result)[0]?.affected ?? 0);
    },

    deadLetter: async (stream, receipts, reason) => {
      if (receipts.length === 0) {
        return 0;
      }
      assertEventQueueReceipts(receipts);
      const queueName = eventStreamQueueName(stream);
      const ids = receipts.join(",");

      // pgmq's own archive move first — it is the version-correct transfer (it carries every column the
      // installed pgmq version has, including ones this code does not know about).
      const archived = await run(
        undefined,
        sql`SELECT count(*)::int AS "affected" FROM pgmq.archive(${queueName}, string_to_array(${ids}, ',')::bigint[])`,
      );

      // Then stamp the reason onto the ARCHIVED body. Deliberately second: if it fails the message is still
      // dead-lettered (the fail-safe direction), and the archived row is terminal so nothing races this.
      await run(
        undefined,
        sql`UPDATE pgmq.${sql.identifier(`a_${queueName}`)} SET "message" = COALESCE("message", '{}'::jsonb) || jsonb_build_object(${PGMQ_DEAD_LETTER_KEY}::text, jsonb_build_object('reason', ${reason}::text, 'atUs', (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint::text)) WHERE "msg_id" = ANY(string_to_array(${ids}, ',')::bigint[])`,
      );

      return Number(toRows<CountRow>(archived)[0]?.affected ?? 0);
    },

    listDeadLetters: async (stream, limit) => {
      const queueName = eventStreamQueueName(stream);
      const result = await run(
        undefined,
        sql`SELECT "msg_id"::text AS "id", "read_ct" AS "deliveryCount", (EXTRACT(EPOCH FROM "archived_at") * 1000000)::bigint::text AS "deadLetteredAtUs", ("message" - ${PGMQ_DEAD_LETTER_KEY}::text)::text AS "message", "message" -> ${PGMQ_DEAD_LETTER_KEY}::text ->> 'reason' AS "reason" FROM pgmq.${sql.identifier(`a_${queueName}`)} ORDER BY "msg_id" DESC LIMIT ${limit}`,
      );

      return toRows<DeadLetterRow>(result).map((row): DeadLetteredEventMessage => {
        const message = parseQueueMessage(stream, row.id, row.message);
        return {
          id: row.id,
          stream,
          message,
          ...(row.reason != null ? { reason: row.reason } : {}),
          deliveryCount: Number(row.deliveryCount),
          deadLetteredAtUs: row.deadLetteredAtUs,
        };
      });
    },

    requeueDeadLetter: async (stream, id) => {
      assertEventQueueReceipts([id]);
      const queueName = eventStreamQueueName(stream);
      // ONE statement: the archive row is removed and its (reason-stripped) body re-sent in the same command,
      // so a requeue can never leave the message both dead-lettered and queued.
      const result = await run(
        undefined,
        sql`WITH restored AS (DELETE FROM pgmq.${sql.identifier(`a_${queueName}`)} WHERE "msg_id" = ${id}::bigint RETURNING "message") SELECT pgmq.send(${queueName}, "message" - ${PGMQ_DEAD_LETTER_KEY}::text)::text AS "receipt" FROM restored`,
      );
      return toRows<ReceiptRow>(result)[0]?.receipt ?? null;
    },
  };
}
