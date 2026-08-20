import type { PGliteInterface } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";

import { classifyTableApplyStrategy, type ApplyStrategy, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { resolveApplyTarget, type ApplyTarget } from "../local-tables";
import {
  applyBulkDeletesToTable,
  applyBulkUpdatesToTable,
  applyInsertsToTable,
  applyMessagesToTableWithCopy,
  applyMessagesToTableWithJson,
  applyUpsertsToTable,
  applyUpsertsToTableWithJson,
} from "../sync/apply";
import { drizzleOverPg } from "../sync/drizzle-executor";
import { foldChangeBatch } from "../sync/fold";
import { getSubscriptionState, updateSubscriptionState } from "../sync/subscription-state";
import type { InitialInsertMethod } from "../sync/types";
import { envelopeToChange, type ChangeLike } from "./envelope-to-change";
import { createShapeGroup, type ShapeGroup } from "./shape-group";
import { StreamInbox } from "./stream-inbox";
import type { StreamSourceOptions } from "./stream-source";

/**
 * The engine's convergence barrier, read through the control plane (ADR-0056 decision 4).
 *
 * Never a bare position: `pendingFlips` counts computed-but-undelivered subquery flips — membership
 * move-out and move-in — so a barrier without it reports convergence while a revocation is still in
 * the engine. That is silent staleness on exactly the security-relevant path.
 *
 * `flipFailures` is the term the other three cannot express. A flip batch abandoned after its
 * retries releases its barrier permit on the way out, so `pendingFlips` returns to zero and `sync`
 * stays true — the engine looks converged from every counter — while the membership effect it
 * carried is **gone**. The engine marks itself poisoned and stops advancing its own frontier; this
 * is the client reading the same fact.
 */
export interface ConvergenceBarrier {
  /** Whether the engine's replication tailer has caught up. */
  sync: boolean;
  /** Deferred subquery flip batches not yet propagated. Read engine-global — conservative. */
  pendingFlips: number;
  /**
   * Flip batches the engine abandoned. Non-zero means membership effects were **lost**, not delayed
   * — unrecoverable in-process, and terminal for any group that reads it.
   */
  flipFailures: number;
}

export interface CircuitsShapeSpec {
  /** Absolute URL of this shape's stream through the edge. */
  streamUrl: string;
  /** The registry table key this shape applies into. Several shapes may share one (ADR-0055 d4). */
  tableKey: string;
  /**
   * Scoped cache clear for a must-refetch, replacing the default `TRUNCATE`.
   *
   * **Required when several shapes share a `tableKey`**, and the engine refuses the group otherwise:
   * the default truncate would wipe a co-tenant scope's rows. A shared-tier shape derives it from
   * its scope key, so supplying one is mechanical rather than a burden.
   */
  onMustRefetch?: (db: ReturnType<typeof drizzleOverPg>) => Promise<void>;
  /** Per-shape backfill strategy override; otherwise the registry's classification. */
  initialInsertMethod?: InitialInsertMethod;
}

export interface CircuitsSyncOptions {
  pg: PGliteInterface;
  registry: SyncTableRegistry;
  /** Subscription key for persisted resume state; `null` disables persistence. */
  key: string | null;
  metadataSchema: string;
  shapes: Record<string, CircuitsShapeSpec>;
  token: StreamSourceOptions["token"];
  onTokenRejected?: StreamSourceOptions["onTokenRejected"];
  /** Reads the engine barrier through the control plane. Consulted once per alignment generation. */
  readBarrier: () => Promise<ConvergenceBarrier>;
  sessionScoped?: boolean;
  onInitialSync?: () => void;
  onSyncError?: (error: Error) => void;
  onSyncActivity?: () => void;
  /**
   * Long-poll the tail after catching up (default). `false` reads each stream to its tail and stops
   * — a one-shot hydration rather than a live subscription.
   */
  live?: boolean;
  maxCommitRetries?: number;
  commitRetryDelayMs?: (attempt: number) => number;
  debug?: boolean;
  fetch?: typeof fetch;
}

export interface CircuitsSyncHandle {
  unsubscribe(): void;
  readonly isUpToDate: boolean;
}

/**
 * Map the statically-resolved apply strategy (ADR-0009 decision 3) onto the backfill path. No
 * strategy defaults to `copy`: the COPY TEXT serializer round-trips every built-in type, so it is
 * the safe bootstrap rather than the fast one.
 */
function applyStrategyToInsertMethod(strategy: ApplyStrategy | undefined): InitialInsertMethod {
  switch (strategy) {
    case "json":
      return "json";
    case "insert":
      return "insert";
    default:
      return "copy";
  }
}

const DEFAULT_MAX_COMMIT_RETRIES = 5;
const defaultRetryDelayMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 8000);

/**
 * Sync K Circuits shape streams into one consistency group (ADR-0055 + ADR-0056).
 *
 * The commit gate is the whole of ADR-0056's steady state: **commit when every shape's most recent
 * response asserted up-to-date**. That is a happens-before, not a position comparison — every stream
 * has drained what the server held, so nothing cross-shape can be half-applied. Offsets are
 * per-stream and the protocol only sanctions comparing them within a stream, so no `min` over
 * positions exists to take, and none is taken.
 *
 * The barrier is consulted **once per alignment generation**, at boot and after any must-refetch.
 * Its job there is narrow and specific: every stream can report drained while the engine still holds
 * a computed revocation, and a boot that claimed consistency in that window would present a store
 * missing an eviction. Mid-session the same condition is just a change arriving late.
 */
export async function syncCircuitsShapes(options: CircuitsSyncOptions): Promise<CircuitsSyncHandle> {
  const {
    pg,
    registry,
    key,
    metadataSchema,
    shapes,
    sessionScoped = false,
    debug = false,
    maxCommitRetries = DEFAULT_MAX_COMMIT_RETRIES,
    commitRetryDelayMs = defaultRetryDelayMs,
  } = options;

  const shapeNames = Object.keys(shapes);
  assertScopedClearsForSharedTables(shapes);

  const targets = new Map<string, ApplyTarget>(
    shapeNames.map((shapeName) => [shapeName, resolveApplyTarget(registry, shapes[shapeName]!.tableKey)]),
  );

  const subState =
    key === null ? null : await getSubscriptionState({ pg, metadataSchema, subscriptionKey: key, sessionScoped });

  /**
   * Which shapes may resume, and which must re-snapshot (ADR-0056 decision 6).
   *
   * The native must-refetch trigger is **the handle**, and it is discovered here rather than
   * received. The persisted handle is the stream this shape was reading; the granted one is the
   * stream the control plane has just named for it. When they differ the stored offset addresses a
   * *different stream*, and ds offsets carry no meaning across streams (PROTOCOL.md §10.2) — so
   * resuming from it is not stale, it is undefined.
   *
   * Every native reset funnels through this one check. A shape the engine evicted, a stream deleted
   * (404) or soft-deleted (410) underneath a live read, a stream that closed — each one ends with
   * the client re-subscribing, and re-subscribing is what produces a new path. That is the whole
   * mechanism: Electric needed an out-of-band `must-refetch` control message because its handles
   * were opaque server state the client could not compare, and here the client simply notices.
   */
  const resumable = new Set(
    shapeNames.filter((shapeName) => {
      const persisted = subState?.shape_metadata[shapeName];
      return persisted?.offset != null && persisted.handle === shapes[shapeName]!.streamUrl;
    }),
  );
  const rehydrating = shapeNames.filter((shapeName) => !resumable.has(shapeName) && subState !== null);

  // Per shape, the backfill strategy: an explicit override, else the registry's build-time
  // classification. Resolved per shape rather than per group so one shape's column profile never
  // forces its siblings onto a slower path.
  const insertMethod = new Map<string, InitialInsertMethod>(
    shapeNames.map((shapeName) => [
      shapeName,
      shapes[shapeName]!.initialInsertMethod ??
        applyStrategyToInsertMethod(classifyTableApplyStrategy(registry[shapes[shapeName]!.tableKey]!)),
    ]),
  );
  // A resume starts in plain-insert mode: the bulk backfill path is only ever correct onto an empty
  // table, which is a fresh subscription or a post-must-refetch re-snapshot. A shape whose handle
  // changed is the second of those — its rows are about to be cleared — so it takes the bulk path
  // too, rather than being penalised for a reset it did not cause.
  const useBulkBackfill = new Map<string, boolean>(
    shapeNames.map((shapeName) => [shapeName, !resumable.has(shapeName) && insertMethod.get(shapeName) !== "insert"]),
  );

  const inbox = new StreamInbox(shapeNames);
  // Seeded, not merely declared: a shape re-hydrating onto a store that still holds the previous
  // stream's rows must clear them in the same transaction the new snapshot lands in, or the two
  // memberships merge and every row the shape lost stays visible forever.
  const truncateNeeded = new Set<string>(rehydrating);
  let unsubscribed = false;
  let degraded = false;
  let commitInFlight: Promise<void> | null = null;
  let commitRerun = false;
  let initialSyncSignalled = false;

  const bulkAppliers = {
    json: applyMessagesToTableWithJson,
    copy: applyMessagesToTableWithCopy,
    insert: applyInsertsToTable,
  } as const;

  /**
   * Apply everything currently held, in one transaction, and persist each shape's offset with it.
   *
   * Peek rather than drain: the batch stays in the inbox until the transaction actually succeeds, so
   * a commit that exhausts its retries HOLDS its work instead of losing it, and the persisted offset
   * does not advance — a later resume re-streams exactly that batch.
   */
  const commitHeld = async (): Promise<boolean> => {
    const held = inbox.peekAll();
    const epochsAtPeek = inbox.snapshotEpochs();
    const offsets = inbox.pendingOffsets();
    const shapesToTruncate = new Set(truncateNeeded);

    const runCommit = () =>
      pg.transaction(async (tx) => {
        // Tier ③ (ADR-0028 allow-list): a `SET LOCAL` GUC — the sync-origin flag the apply trigger
        // reads to tell streamed server truth from local writes. GUCs have no tier-①/② builder form.
        await tx.exec(`SET LOCAL ${metadataSchema}.syncing = true;`);

        for (const shapeName of shapeNames) {
          const target = targets.get(shapeName)!;
          const spec = shapes[shapeName]!;
          let changes = held.get(shapeName) ?? [];

          if (shapesToTruncate.has(shapeName)) {
            if (spec.onMustRefetch) {
              await spec.onMustRefetch(drizzleOverPg(tx));
            } else {
              // A must-refetch wipe is engine cache maintenance, not server truth (ADR-0029 D4), so it
              // TRUNCATEs rather than reacting per row. Tier ②: TRUNCATE has no Drizzle builder, so the
              // table object is interpolated rather than its name spliced.
              await drizzleOverPg(tx).execute(sql`TRUNCATE ${target.table}`);
            }
          }

          // The bulk backfill fast path: a leading run of inserts onto an empty table. It is only
          // ever entered on a fresh subscription or straight after a truncate, which is what makes a
          // plain bulk INSERT safe here.
          if (useBulkBackfill.get(shapeName) && changes.length > 0) {
            const leadingInserts: ChangeLike[] = [];
            const remainder: ChangeLike[] = [];
            let sawNonInsert = false;
            for (const change of changes) {
              if (!sawNonInsert && change.headers.operation === "insert") leadingInserts.push(change);
              else {
                sawNonInsert = true;
                remainder.push(change);
              }
            }
            const method = insertMethod.get(shapeName)!;
            // COPY has no ON CONFLICT clause and cannot be mixed with a following per-row apply of the
            // same key, so the last insert is handed back to the fold rather than bulk-loaded.
            if (leadingInserts.length > 0 && method === "copy") remainder.unshift(leadingInserts.pop()!);
            changes = remainder;

            if (leadingInserts.length > 0) {
              // ADR-0045: a table that legitimately receives locally-derived provisional rows must not
              // collide with them here — a trigger firing during another table's apply in the same
              // catch-up can create rows before this snapshot lands.
              const applyBackfill =
                target.applyMode === "upsert"
                  ? method === "insert"
                    ? applyUpsertsToTable
                    : applyUpsertsToTableWithJson
                  : bulkAppliers[method];
              await applyBackfill({ pg: tx, target, messages: leadingInserts as never, debug });
              useBulkBackfill.set(shapeName, false);
            }
          }

          if (changes.length === 0) continue;

          // ADR-0014: fold to one net op per primary key, then DELETE → INSERT → UPDATE. A re-created
          // key's delete must precede its insert; every other key lands in exactly one statement.
          const folded = foldChangeBatch(changes as never);
          if (folded.deletes.length > 0) {
            await applyBulkDeletesToTable({ pg: tx, target, messages: folded.deletes, debug });
          }
          if (folded.inserts.length > 0) {
            if (target.applyMode === "upsert") {
              await applyUpsertsToTable({ pg: tx, target, messages: folded.inserts, debug });
            } else {
              await applyInsertsToTable({ pg: tx, target, messages: folded.inserts, debug });
            }
          }
          if (folded.updates.length > 0) {
            await applyBulkUpdatesToTable({ pg: tx, target, messages: folded.updates, debug });
          }
        }

        if (key !== null) {
          // The offsets ride the SAME transaction as the rows they acknowledge. `last_lsn` has no
          // native meaning — ADR-0056 makes the per-shape offset the only frontier — and the column
          // goes when the Electric path does.
          await updateSubscriptionState({
            pg: tx,
            metadataSchema,
            subscriptionKey: key,
            sessionScoped,
            shapeMetadata: Object.fromEntries(
              shapeNames.map((shapeName) => [
                shapeName,
                { handle: shapes[shapeName]!.streamUrl, offset: (offsets.get(shapeName) ?? "-1") as never },
              ]),
            ),
            lastLsn: BigInt(0),
            debug,
          });
        }

        // Discard rather than persist work during teardown: PGlite skips the COMMIT once the tx is
        // rolled back, so both the rows and the offset advance are undone and a resume re-streams.
        if (unsubscribed) await tx.rollback();
      });

    for (let attempt = 1; ; attempt++) {
      if (unsubscribed) return false;
      try {
        await runCommit();
        if (unsubscribed) return false;
        inbox.ackAll(epochsAtPeek);
        for (const shapeName of shapesToTruncate) truncateNeeded.delete(shapeName);
        signalInitialSyncIfReady();
        return true;
      } catch (error) {
        if (unsubscribed) return false;
        if (attempt >= maxCommitRetries) {
          degraded = true;
          options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, commitRetryDelayMs(attempt)));
      }
    }
  };

  function signalInitialSyncIfReady(): void {
    if (initialSyncSignalled || !inbox.isGroupUpToDate()) return;
    initialSyncSignalled = true;
    options.onInitialSync?.();
  }

  /**
   * Single-flight commit queue: at most one commit runs at a time, and anything buffered while one
   * is in flight coalesces into the next run rather than queueing a second transaction.
   *
   * Refuses to run while degraded — a later batch must never apply over a held, unapplied one.
   */
  const enqueueCommit = (): Promise<void> => {
    if (degraded || unsubscribed) return Promise.resolve();
    if (commitInFlight) {
      commitRerun = true;
      return commitInFlight;
    }
    commitInFlight = (async () => {
      try {
        do {
          commitRerun = false;
          if (!(await gateOpen())) break;
          await commitHeld();
        } while (commitRerun && !degraded && !unsubscribed);
      } finally {
        commitInFlight = null;
      }
    })();
    return commitInFlight;
  };

  /**
   * Whether the group may commit right now.
   *
   * Every shape drained, plus — for the first commit of each alignment generation — the engine
   * barrier. An unsatisfied barrier does not fail: the group simply does not align yet and retries
   * on the next delivery, which is correct if slower.
   *
   * A **poisoned** engine is the one reading that is not a delay, and is handled the opposite way.
   */
  const gateOpen = async (): Promise<boolean> => {
    if (!inbox.isGroupUpToDate()) return false;
    if (!inbox.needsAlignment()) return true;
    if (!inbox.everyShapeReported()) return false;

    try {
      const barrier = await options.readBarrier();
      // Lost membership effects are terminal, and waiting them out is the one wrong response: the
      // other three terms report converged forever, so a group that merely held would be
      // indistinguishable from a slow engine while quietly never aligning. The engine has declared
      // itself unrecoverable in-process and needs a restart; the client says so and stops.
      if (barrier.flipFailures > 0) {
        degraded = true;
        options.onSyncError?.(
          new Error(
            `[pgxsinkit] the sync engine lost ${barrier.flipFailures} membership flip batch(es) and is degraded: ` +
              `its frontier will not advance again and this store cannot be proven consistent. The engine must be restarted.`,
          ),
        );
        return false;
      }
      if (!barrier.sync || barrier.pendingFlips > 0) {
        if (debug) console.log("alignment barrier unsatisfied", barrier);
        return false;
      }
      inbox.markAligned();
      if (debug) console.log("aligned on barrier", barrier);
      return true;
    } catch (error) {
      // A barrier the client cannot read is a DELAY, not a failure (ADR-0056): the group stays on the
      // pre-alignment gate and tries again on the next delivery.
      if (debug) console.log("alignment barrier unreachable", error);
      return false;
    }
  };

  const group: ShapeGroup = createShapeGroup({
    shapes: Object.fromEntries(
      shapeNames.map((shapeName) => [
        shapeName,
        {
          url: shapes[shapeName]!.streamUrl,
          ...(resumable.has(shapeName) ? { offset: String(subState!.shape_metadata[shapeName]!.offset) } : {}),
        },
      ]),
    ),
    token: options.token,
    live: options.live ?? true,
    ...(options.onTokenRejected ? { onTokenRejected: options.onTokenRejected } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  group.subscribe(async (batch) => {
    if (unsubscribed) return;
    // A delivered batch means a fetch just succeeded — the read path is alive, so a runtime can clear
    // an auth-needed status once a fresh token starts working again (ADR-0013).
    options.onSyncActivity?.();

    const target = targets.get(batch.shape)!;
    inbox.ingestBatch(
      batch.shape,
      batch.envelopes.map((envelope) => envelopeToChange(target, envelope)),
      batch.offset,
      batch.upToDate,
    );
    await enqueueCommit();
  });

  await group.start();

  return {
    unsubscribe(): void {
      unsubscribed = true;
      group.unsubscribeAll();
    },
    get isUpToDate(): boolean {
      // Never claim up-to-date on an unapplied commit or after going degraded: the read cache must
      // not assert it matches the server while work is held (ADR-0009 decision 5).
      return !degraded && commitInFlight === null && !inbox.hasBufferedBatches() && inbox.isGroupUpToDate();
    },
  };
}

/**
 * K shapes may share one table (ADR-0055 decision 4), but only when each brings a scoped clear.
 *
 * The default must-refetch is a TRUNCATE of the whole table, which would wipe a co-tenant scope's
 * rows — so this is the same condition the Electric engine's per-table lock enforced, stated as the
 * requirement it always was rather than as a prohibition on sharing.
 */
function assertScopedClearsForSharedTables(shapes: Record<string, CircuitsShapeSpec>): void {
  const byTable = new Map<string, string[]>();
  for (const [shapeName, spec] of Object.entries(shapes)) {
    const sharing = byTable.get(spec.tableKey) ?? [];
    sharing.push(shapeName);
    byTable.set(spec.tableKey, sharing);
  }

  for (const [tableKey, sharing] of byTable) {
    if (sharing.length < 2) continue;
    const bare = sharing.filter((shapeName) => !shapes[shapeName]!.onMustRefetch);
    if (bare.length > 0) {
      throw new Error(
        `[pgxsinkit] shapes ${bare.join(", ")} share table "${tableKey}" without an onMustRefetch — the ` +
          `default must-refetch truncates the whole table and would wipe the other shapes' rows. A ` +
          `shared-tier shape derives a scoped clear from its scope key.`,
      );
    }
  }
}
