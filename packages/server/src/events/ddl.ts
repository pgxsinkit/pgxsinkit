import { getSyncRegistryStreams, hashString, quoteSqlLiteral, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { eventStreamQueueName } from "./queue";

/**
 * The Event lane's **deploy-time** DDL (ADR-0053 decision 5): the pgmq extension plus one queue per registered
 * Event stream, derived from the registry.
 *
 * Provisioning is deploy-time and never runtime create-if-missing — the ingestion endpoint may enqueue long
 * before any consumer runner first starts, and a create-if-missing probe would put a query back in front of
 * the server's zero-startup-query posture.
 *
 * **pgmq assumptions** (read off pgmq's own extension SQL, and pinned by the integration lane):
 * - `CREATE EXTENSION IF NOT EXISTS pgmq` needs **no `CASCADE`**: pgmq's control file declares no `requires`.
 *   (pg_partman is needed only for PARTITIONED queues, which this DDL never creates.) `CASCADE` would be
 *   harmless but would also silently install whatever a future control file starts requiring.
 * - **No schema qualification is configurable**: the control file is `relocatable = false` with
 *   `schema = 'pgmq'`, so the extension always lives in `pgmq` and every call is `pgmq.`-qualified.
 * - `pgmq.create()` is **idempotent**: it delegates to `create_non_partitioned`, whose tables and indexes are
 *   `IF NOT EXISTS` and whose `pgmq.meta` insert is `ON CONFLICT DO NOTHING`. So the emitted statements need
 *   no guard block and re-applying the migration is a no-op.
 *
 * The artifact is a MIGRATION body (raw SQL text) — `CREATE EXTENSION` and a SQL function call are outside
 * anything Drizzle's builders can express, which is the sanctioned raw-SQL case. Every interpolated queue
 * name is a registry-validated `[a-z][a-z0-9_]*` name, emitted through `quoteSqlLiteral`.
 */

/** Stamped into the emitted DDL so `--check` can detect drift between the registry and a committed migration. */
export const EVENT_LANE_FINGERPRINT_PREFIX = "pgxsinkit:events:fp1:";

/** The registered Event-stream names, SORTED — so the artifact and its fingerprint are registry-order-independent. */
export function eventLaneStreamNames(registry: SyncTableRegistry): string[] {
  return Object.keys(getSyncRegistryStreams(registry) ?? {}).sort();
}

function buildEventLaneDdlBody(streamNames: readonly string[]): string {
  const header =
    "-- The pgxsinkit event lane's queues (ADR-0053 decision 5): one pgmq queue per registered Event stream.\n" +
    "-- Provisioning is DEPLOY-TIME: the ingestion endpoint may enqueue long before any consumer runner starts.\n" +
    "-- No CASCADE: pgmq's control file declares no `requires`. pgmq is non-relocatable (schema = 'pgmq').\n" +
    "-- pgmq.create() is idempotent (IF NOT EXISTS tables/indexes + ON CONFLICT DO NOTHING meta), so\n" +
    "-- re-applying this migration is a no-op and adding a stream only appends a line.";

  const statements = streamNames.map(
    (stream) => `SELECT pgmq.create(${quoteSqlLiteral(eventStreamQueueName(stream))});`,
  );

  return `${header}\nCREATE EXTENSION IF NOT EXISTS pgmq;\n${statements.join("\n")}`;
}

function assertHasStreams(registry: SyncTableRegistry): string[] {
  const streamNames = eventLaneStreamNames(registry);
  if (streamNames.length === 0) {
    throw new Error(
      "pgxsinkit: this registry registers no Event streams, so there is no event-lane DDL to emit. Register one " +
        "with `defineSyncRegistry({ tables, streams: { <name>: defineEventStream({ … }) } })`.",
    );
  }
  return streamNames;
}

/**
 * The fingerprint the event-lane artifact carries for this registry. Derived from the emitted DDL body, so it
 * moves when a stream is added or removed (and when this generator's output changes) — and does NOT move for a
 * payload-schema change, which provisions nothing.
 */
export function eventLaneDdlFingerprint(registry: SyncTableRegistry): string {
  return EVENT_LANE_FINGERPRINT_PREFIX + hashString(buildEventLaneDdlBody(assertHasStreams(registry)));
}

/**
 * The full migration body: the DDL plus its fingerprint as a SQL comment. The comment is what
 * `pgxsinkit-generate --events --check` scans committed migrations for — the same pre-deploy drift detection
 * the apply-function artifact gets, minus the in-database stamp (there is no function here to comment on).
 */
export function renderEventLaneMigration(registry: SyncTableRegistry): string {
  const body = buildEventLaneDdlBody(assertHasStreams(registry));
  return `-- ${EVENT_LANE_FINGERPRINT_PREFIX + hashString(body)}\n${body}`;
}
