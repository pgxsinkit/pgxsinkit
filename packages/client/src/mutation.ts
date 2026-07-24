import {
  and,
  desc,
  eq,
  exists,
  getColumns,
  gt,
  inArray,
  is,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  SQL,
  sql,
} from "drizzle-orm";
import {
  alias,
  getTableConfig,
  getViewConfig,
  PgDialect,
  type AnyPgTable,
  type PgColumn,
  type PgInsertValue,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import {
  clearMutationRecoveryMarkerIfSettled,
  readMutationRecoveryRequired,
  writeMutationRecoveryRequired,
} from "./local-store";
import {
  getJournalTable,
  getOverlayTable,
  getSyncedLocalTable,
  type JournalTable,
  type OverlayTable,
} from "./local-tables";

// Statements are AUTHORED as Drizzle builders over the journal/overlay/synced table objects
// (rename-safe, typed, schema-qualification handled by the table objects) and rendered to
// text+params here, because they EXECUTE through the caller's raw `MutationDb` seam — the one
// connection the mutation runtime and its tests own (and mock). `drizzle.mock()` builds queries
// without a connection; `queryDialect` renders standalone `sql` fragments the builders cannot
// express (compound CTE shapes, derived-table wrappers).
const queryBuilder = drizzle.mock();
const queryDialect = new PgDialect();

/**
 * Strip the two internal overlay columns that appear on _read_model views
 * (`overlay_kind`, `local_updated_at_us`) from any user-supplied input or
 * patch object before it is serialised into a mutation payload.  Callers
 * that spread a view row directly into a create/update call would otherwise
 * hit `TypeError: Do not know how to serialize a BigInt` because
 * `local_updated_at_us` is stored as a native JS `bigint`.
 */
function stripReadModelOverlayFields<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (!("overlay_kind" in obj) && !("local_updated_at_us" in obj)) return value;
  const { overlay_kind: _ok, local_updated_at_us: _lu, ...rest } = obj;
  return rest as T;
}

/**
 * JSON replacer that serialises `bigint` values as strings. PostgreSQL
 * accepts string literals for BIGINT columns, and JSON has no native bigint
 * type, so this is the safest cross-boundary representation.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? String(value) : value;
}

function jsonStringifyPayload(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

import type {
  BatchMutationAck,
  MutationAck,
  MutationDiagnostics,
  MutationRejection,
  SyncTableCreateInput,
  SyncTableEntry,
  SyncTableName,
  SyncTableRecord,
  SyncTableRegistry,
  SyncTableUpdateInput,
  WriteMode,
} from "@pgxsinkit/contracts";
import {
  batchMutationErrorSchema,
  buildOverlayResolutionBarrier,
  fingerprintRegistry,
  getProjectedColumns as getProjectedTableColumns,
  getSyncRegistrySchema,
  maybeQuoteIdentifier,
  quoteIdentifier,
  resolveServerVersionColumnName,
} from "@pgxsinkit/contracts";

import { syncDebug } from "./debug";
import {
  assertValidMutationTransition,
  classifyFailureStatus,
  DEFAULT_MAX_MUTATION_ATTEMPTS,
  type MutationStatus,
} from "./mutation-state";

export type { MutationStatus } from "./mutation-state";
export type MutationKind = "create" | "update" | "delete";

/**
 * The dynamic write-unit tag (ADR-0022 §2) a `transaction({ mode })` block stamps onto the mutations
 * authored within it: a shared `id` grouping the co-committed mutations, and the unit's `mode`. Persisted
 * on each journal row (`write_unit` / `write_mode`); absent for the default path, where the flusher derives
 * mode + unit from the table's static consistency group.
 */
export interface WriteUnit {
  id: string;
  mode: WriteMode;
}

export type MutationBatchItem<TRegistry extends SyncTableRegistry> = {
  [TKey in SyncTableName<TRegistry>]:
    | {
        table: TKey;
        kind: "create";
        input: SyncTableCreateInput<TRegistry, TKey>;
      }
    | {
        table: TKey;
        kind: "update";
        entityKey: Record<string, string>;
        patch: SyncTableUpdateInput<TRegistry, TKey>;
        /**
         * A **blind** update (ADR-0022 addendum): plan a journal row ONLY — no local base row is required
         * and no optimistic overlay is written. Set exclusively by the transaction handle's `updateBlind`;
         * valid only when the write routes pessimistically (a `pessimistic` unit, or a statically-pessimistic
         * table), and rejected at enqueue otherwise. Absent/false for an ordinary update.
         */
        blind?: boolean;
      }
    | {
        table: TKey;
        kind: "delete";
        entityKey: Record<string, string>;
      };
}[SyncTableName<TRegistry>];

export const DEFAULT_FLUSH_BATCH_SIZE = 100;

export interface MutationDetail {
  tableName: string;
  entityKey: Record<string, string>;
  mutationId: string;
  mutationSeq: number;
  mutationKind: MutationKind;
  status: MutationStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
  updatedAtUs: string;
  /** Registry fingerprint under which the mutation was authored. */
  registryVersion: string;
}

export interface MutationDb {
  exec: (sql: string) => Promise<unknown>;
  query: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
}

export interface CreateMutationRuntimeOptions<TRegistry extends SyncTableRegistry> {
  db: MutationDb;
  registry: TRegistry;
  batchWriteUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  /** Static headers added to every write request (e.g. a Supabase Cloud `apikey`); see {@link CreateSyncClientOptions.requestHeaders}. */
  requestHeaders?: Record<string, string>;
  /** Registry fingerprint stamped onto each enqueued mutation; normally derived from {@link registry}. */
  registryVersion?: string;
  /**
   * Whether pgxsinkit owns the local schema (and therefore the `pgxsinkit_local_meta` table the durable
   * recovery-required marker lives in). Defaults to `true`. A caller-owned `pgliteInstance` boot sets this
   * `false`: the meta table may not exist, so the marker is never read/written and boot recovery runs
   * unconditionally.
   */
  ownsMetaTable?: boolean;
  /**
   * Hard cap on send attempts before a still-failing mutation is quarantined
   * (ADR-0005 congestion policy). Defaults to {@link DEFAULT_MAX_MUTATION_ATTEMPTS}.
   */
  maxMutationAttempts?: number;
  /**
   * Max mutations drained per flush HTTP request; a flush loops slices until the journal is empty.
   * Defaults to {@link DEFAULT_FLUSH_BATCH_SIZE}. Primarily a test seam (a small value exercises the
   * multi-slice drain path without enqueueing hundreds of mutations).
   */
  flushBatchSize?: number;
  /**
   * Invoked after a flush whenever mutations transition to `quarantined` (terminal,
   * permanently rejected). Receives the newly-quarantined details so the app can surface
   * them, then either re-author + resubmit or roll back via {@link MutationRuntime.discardQuarantined}
   * (clears the kept overlay + quarantined journal rows, so the entity accepts new mutations again).
   * The library never silently drops these (ADR-0006 decision 4).
   */
  onQuarantine?: (quarantined: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked after a flush whenever mutations transition to `conflicted` — a stale write the
   * server declined under the `reject-if-stale` Conflict policy (ADR-0015). Distinct from
   * `onQuarantine` (structural rejection): the optimistic Overlay is KEPT, so the app surfaces a
   * resolution/diff UI and resolves each as a new write (or `discardConflict`s it). Never silent.
   */
  onConflict?: (conflicted: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked after an authoritative (pessimistic) flush whenever a write-unit was `rejected` (ADR-0022) —
   * a business decline the client could not evaluate locally (capacity/quota/uniqueness). The inverse of
   * `onConflict`: the optimistic Overlay was **auto-discarded** for every member of the unit, so the app
   * surfaces the typed reason (e.g. "full") rather than a resolve/diff UI. Never silent.
   */
  onReject?: (rejected: MutationDetail[]) => void | Promise<void>;
  /**
   * Invoked once per enqueue with the DISTINCT non-blind table keys of the planned batch (ADR-0039).
   * An ordinary optimistic `create`/`update`/`delete` is a reference to its target, and a reference
   * activates the target's lazy consistency group — the read path does this implicitly, the write path
   * did not. The client wires this to a fire-and-forget `ensureSynced`, so the group is open by the time
   * the echo returns. Purely-blind batches (only `updateBlind`) report nothing: a blind write is the
   * deliberate no-echo, no-activation write-only exception. Fire-and-forget from the runtime's view —
   * never awaited, and a throw here must never fail the enqueue (the runtime guards the call).
   */
  onOrdinaryEnqueue?: (tables: readonly string[]) => void;
}

interface TableContext {
  key: string;
  entry: SyncTableEntry<AnyPgTable>;
  readModel: string;
  syncedTable: string;
  overlayTable: string;
  journalTable: string;
  journalSequence: string;
  pkColumnNames: string[];
  pkPropertyKeys: string[];
  /**
   * The Server version (ADR-0010) column name (e.g. `updated_at_us`) and its drizzle property key,
   * resolved from the table's managed fields. Used to capture the Base server version (ADR-0015) at
   * enqueue — the value the user's edit was authored against. `null` would mean no Server version,
   * which registry validation already forbids for a writable table.
   */
  serverVersionColumnName: string | null;
  serverVersionPropertyKey: string | null;
  /**
   * Property keys of the table's `nowMicroseconds` managed fields (governance), resolved generically
   * rather than by the `createdAtUs`/`updatedAtUs` naming convention. The optimistic overlay stamps
   * these client-side so a custom-named managed timestamp (e.g. a Server version not called
   * `updated_at_us`) is materialised correctly — closing the split interpreter between the generic
   * server applier (which reads governance) and the local path (ADR-0004).
   *
   * - `managedNowMicrosecondsPropertyKeys` — every `nowMicroseconds` field, stamped on create.
   * - `updateManagedNowMicrosecondsPropertyKeys` — those that apply on update, re-stamped each update.
   *
   * These augment, and never remove, the convention fill in `createOptimisticRecordFromContext`,
   * which remains the safety net for a `created_at_us`/`updated_at_us` column that carries a SQL
   * `DEFAULT` (unmaterialisable client-side) yet is not declared a managed field.
   */
  managedNowMicrosecondsPropertyKeys: string[];
  updateManagedNowMicrosecondsPropertyKeys: string[];
  /**
   * The table's `authClaim` managed fields that apply on create (governance), each with the JSON
   * claimPath it stamps from. The server stamps these from the verified request claims, so they are
   * stripped from the create input type and never sent in the flushed payload. But the optimistic
   * overlay still needs a value — such a column is typically `NOT NULL` (an owner/author/created_by) —
   * so the runtime fills it client-side from the decoded JWT claim at the same path (the same value the
   * server will stamp), so the local row renders attributed immediately and never flips on convergence.
   * (`auth.uid()` is just `claimPath: ["sub"]`, so this one path covers it.)
   */
  managedAuthClaimCreateFields: Array<{ propertyKey: string; claimPath: string[] }>;
  recordIncludesOverlayState: boolean;
  columns: Array<{
    propertyKey: string;
    column: ReturnType<typeof getProjectedTableColumns<AnyPgTable>>[number]["column"];
  }>;
  /**
   * The generated local relations as runtime Drizzle table objects (local-tables.ts), so the
   * runtime's statements are AUTHORED as tier-① builders while still EXECUTING through the raw
   * `MutationDb` seam. Journal fixed columns are camelCase-keyed; per-entry PK columns are keyed
   * by DB column name; overlay/synced columns are keyed by drizzle property key.
   */
  tables: {
    synced: AnyPgTable;
    overlay: OverlayTable;
    journal: JournalTable;
  };
  /** Overlay columns keyed by property key (`getColumns` memo — overlay keys are property keys, not DB names). */
  overlayColumnsByPropertyKey: Record<string, PgColumn>;
  /** Synced read-cache columns keyed by property key. */
  syncedColumnsByPropertyKey: Record<string, PgColumn>;
  /** The entry's PK columns ON THE OVERLAY, resolved by DB column name (ordered like `pkColumnNames`). */
  overlayPkColumns: PgColumn[];
  /** The entry's PK columns ON THE SYNCED table, resolved by DB column name (ordered like `pkColumnNames`). */
  syncedPkColumns: PgColumn[];
  /** The Server version column ON THE SYNCED table (ADR-0010), or null when the table declares none. */
  syncedServerVersionColumn: PgColumn | null;
  /**
   * Memoized render of the reconcile idle probe (the per-tick hot statement): built once per
   * context so every convergence tick pays only a plain `db.query` of a cached string.
   */
  reconcileIdleProbe?: { sql: string; params: unknown[] };
}

/**
 * The result of {@link MutationRuntime.runBootRecovery}, shaped to feed the `warmBoot` BootReport fields
 * directly (ADR-0034): whether the per-table recovery loop was skipped, whether recovery was required this
 * boot, how many writable journals were visited, and how many rows were lifted `sending → pending` (`null`
 * when the selected pass is uncounted, a real count on the marker-`true` path).
 */
export interface BootRecoveryOutcome {
  skipped: boolean;
  required: boolean;
  tablesVisited: number;
  rowsRecovered: number | null;
}

export interface MutationRuntime<TRegistry extends SyncTableRegistry> {
  /** Registry fingerprint stamped onto mutations authored by this runtime. */
  registryVersion: string;
  create: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    input: SyncTableCreateInput<TRegistry, TKey>,
  ) => Promise<void>;
  update: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
    patch: SyncTableUpdateInput<TRegistry, TKey>,
  ) => Promise<void>;
  delete: <TKey extends SyncTableName<TRegistry>>(table: TKey, entityKey: Record<string, string>) => Promise<void>;
  /**
   * Enqueue an atomic batch of mutations. An optional {@link WriteUnit} tags every row of the batch as one
   * dynamic write-unit (ADR-0022 §2) — the `transaction({ mode })` block passes it; the per-table
   * `create`/`update`/`delete` helpers do not (their write-mode comes from the static group at flush).
   */
  batch: (items: ReadonlyArray<MutationBatchItem<TRegistry>>, unit?: WriteUnit) => Promise<void>;
  /**
   * Discard a `conflicted` entity (ADR-0015): clear its conflicted journal entries and the kept
   * optimistic Overlay, so the Read model falls back to the synced (server) value. Use when the user
   * abandons their stale edit instead of resolving it as a new write. No-op for an entity with no
   * conflicted entry.
   */
  discardConflict: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
  ) => Promise<void>;
  /**
   * Discard a `quarantined` entity (ADR-0006): clear its quarantined journal entries and the kept
   * optimistic Overlay, so the Read model falls back to the synced (server) value and the entity
   * accepts new mutations again. The rollback path for a permanently-rejected write (e.g. an RLS
   * policy denial routed to quarantine). Symmetric to {@link discardConflict}. No-op for an entity
   * with no quarantined entry; the overlay is kept when another still-owed write depends on it.
   */
  discardQuarantined: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    entityKey: Record<string, string>,
  ) => Promise<void>;
  flush: (table?: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * Flush one pessimistic write-unit (ADR-0022) to the authoritative endpoint and apply its per-mutation
   * result inline: `acked` clears via the synced echo, `conflicted` keeps the overlay (surfaced), and
   * `rejected` auto-discards the overlay for the whole unit (surfaced via `onReject`). A foreground
   * operation — it resolves once the server has decided. Throws on transport failure (the overlay is kept
   * for a retry). Returns the server acks. Used by the client `transaction({ mode: "pessimistic" })` block.
   */
  flushUnit: (unitId: string) => Promise<{ acks: MutationAck[] }>;
  reconcile: (table?: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * Fire the runtime's dispose signal: abort every in-flight write-path fetch AND unblock any await parked on
   * a stalled getAuthToken(). Called FIRST by the client's stop()/destroy() so teardown halts all write-network
   * activity before it awaits the convergence pass. Idempotent; a disposed runtime performs no further network.
   */
  abortInFlight: () => void;
  retryFailed: (table?: SyncTableName<TRegistry>) => Promise<void>;
  recoverSending: (table?: SyncTableName<TRegistry>) => Promise<void>;
  /**
   * Boot-time journal recovery driven by the durable recovery-required marker. The
   * internal boot entry point that decides — from the marker and the boot mode — whether the per-table
   * `sending → pending` recovery loop runs at all, and clears/initializes the marker afterwards. It NEVER
   * runs from a consumer call ({@link recoverSending} keeps today's exact per-table semantics and never
   * touches the marker); {@link BootRecoveryOutcome} feeds the `warmBoot` BootReport fields verbatim.
   *
   * - `ownsMetaTable: false` (caller-owned PGlite) → unconditional recovery, marker untouched.
   * - `restore: true` → unconditional recovery + {@link quarantineRecovered} + self-verifying clear (marker ignored).
   * - marker `false` → skip the loop entirely.
   * - marker absent (not initialized) → one conservative recovery pass, then initialize the marker.
   * - marker `true` → the N per-table updates PLUS the self-verifying clear, wrapped in one transaction.
   */
  runBootRecovery: (opts: { ownsMetaTable: boolean; restore: boolean }) => Promise<BootRecoveryOutcome>;
  /**
   * Quarantine EVERY non-terminal journal row recovered from a backup (`pending`/`sending`/`failed` →
   * `quarantined`) — the restore-boot rule (ADR-0035 decision 6). Nothing recovered from a store backup
   * may ever auto-flush: the write path keeps `mutationId` in `operations_log` but never consults it, so
   * there is no dedupe ledger, and a replayed mutation would silently re-apply stale values over newer
   * writes on a last-write-wins table (and a replayed create collides on its PK). Terminal states
   * (`acked`/`conflicted`/`rejected`) are left untouched. Run ONCE, on the restore boot only, AFTER
   * `recoverSending` (which first lifts any `sending` back to `pending`); the app then inspects
   * `diagnostics()` and resolves each row via `discardQuarantined` (quarantine is terminal — "release"
   * means discard and re-author as a new mutation) before going online. A no-op on a clean journal.
   */
  quarantineRecovered: (table?: SyncTableName<TRegistry>) => Promise<void>;
  readMutationStats: (table?: SyncTableName<TRegistry>) => Promise<MutationDiagnostics>;
  readMutationDetails: (table?: SyncTableName<TRegistry>) => Promise<MutationDetail[]>;
  createOptimisticRecord: <TKey extends SyncTableName<TRegistry>>(
    table: TKey,
    input: SyncTableCreateInput<TRegistry, TKey>,
  ) => SyncTableRecord<TRegistry, TKey>;
}

export function nowMicroseconds(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

/**
 * Best-effort decode of a JWT's claims payload, for stamping `authClaim` managed fields into the
 * optimistic overlay (the value the server will independently stamp from the same claim path). This is
 * **not** a verification — the token is trusted only for a local, optimistic projection that the server
 * re-stamps authoritatively on apply; a forged claim could never make the server attribute the row
 * differently. Returns `undefined` for a malformed token.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const segments = token.split(".");
  if (segments.length < 2 || !segments[1]) {
    return undefined;
  }
  try {
    const normalized = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a claim at a JSON path out of a decoded claims object, returning it as a string (the form the
 * optimistic overlay column expects, mirroring the server's `jsonb #>>` text extraction). Returns
 * `undefined` if the path is absent or the leaf is not a string/number.
 */
export function readJwtClaimPath(claims: Record<string, unknown>, claimPath: string[]): string | undefined {
  let cursor: unknown = claims;
  for (const segment of claimPath) {
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === "string") {
    return cursor;
  }
  return typeof cursor === "number" ? String(cursor) : undefined;
}

export function computeBackoffDelayMs(attemptCount: number) {
  const exponent = Math.max(attemptCount - 1, 0);
  return Math.min(1000 * 2 ** exponent, 30_000);
}

/**
 * Retry delay with equal jitter around the {@link computeBackoffDelayMs} ceiling: half
 * the ceiling plus a random share of the other half. Spreads retries so a fleet of
 * clients does not stampede the server in lockstep after an outage (ADR-0005 congestion
 * policy). `random` is injectable for deterministic tests.
 */
export function computeRetryDelayMs(attemptCount: number, random: () => number = Math.random) {
  const ceiling = computeBackoffDelayMs(attemptCount);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function computeNextRetryAtUs(nowUs: string, attemptCount: number, random: () => number = Math.random) {
  return (BigInt(nowUs) + BigInt(computeRetryDelayMs(attemptCount, random)) * 1000n).toString();
}

export function createMutationRuntime<TRegistry extends SyncTableRegistry>(
  options: CreateMutationRuntimeOptions<TRegistry>,
): MutationRuntime<TRegistry> {
  const mutationUrls = resolveMutationUrls(options.batchWriteUrl);
  const resolveAuthToken = async () => {
    if (options.getAuthToken) {
      return await options.getAuthToken();
    }

    return undefined;
  };

  // The decoded JWT claims for stamping `authClaim` create-managed fields into the optimistic overlay
  // (the same value the server stamps from the same claim path). Resolved only when a create needs it
  // (a table with such a field), so tokenless registries never pay a token lookup.
  const resolveAuthClaims = async (): Promise<Record<string, unknown> | undefined> => {
    const token = await resolveAuthToken();
    return token ? decodeJwtClaims(token) : undefined;
  };

  const tableContexts = buildTableContexts(options.registry);
  const maxMutationAttempts = options.maxMutationAttempts ?? DEFAULT_MAX_MUTATION_ATTEMPTS;
  const flushBatchSize = options.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
  const registryVersion = options.registryVersion ?? fingerprintRegistry(options.registry);
  let flushQueue = Promise.resolve();

  // Teardown halt (see stop()/destroy()): a disposed runtime stops ALL activity at once. The signal is
  // fired once by abortInFlight() and never reset. Every write-path fetch rides it (aborting an in-flight
  // POST), and every getAuthToken() await is raced against it — the board's getAuthToken calls
  // supabase.auth.getSession(), which can stall on token refresh (see flushBatch), so a fetch signal alone
  // would not release teardown. On abort, flush()/flushUnit() reject promptly and the convergence pass settles.
  const disposeController = new AbortController();
  // Reject a pending await the instant the runtime is disposed. Cleans up its listener so per-flush use never leaks.
  const untilAborted = <T>(work: Promise<T>): Promise<T> => {
    if (disposeController.signal.aborted) {
      return Promise.reject(new DOMException("Mutation runtime disposed", "AbortError"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Mutation runtime disposed", "AbortError"));
      disposeController.signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => disposeController.signal.removeEventListener("abort", onAbort));
    });
  };

  // Whether pgxsinkit owns the local schema (and the `pgxsinkit_local_meta` table the durable
  // recovery-required marker lives in). A caller-owned PGlite boot sets this false, so the marker is never
  // touched and the SET/clear seams below are no-ops.
  const ownsMetaTable = options.ownsMetaTable ?? true;
  // Cached "this epoch has already committed the marker `true`" flag. Marker-first ordering:
  // `ensureRecoveryMarker` awaits ONE marker upsert before the first `sending` transition of a dirty epoch,
  // then flips this true, so steady-state flushing pays zero extra crossings. Reset to false only after the
  // self-verifying clear proves no `sending` row remains (`settleRecoveryMarker` / boot recovery).
  let recoveryMarkerDirty = false;

  // In-flight mark-sending span counter (FIX 1 — the concurrent-`flushUnit` marker race). Bumped SYNCHRONOUSLY
  // (before any await) whenever a status-update call transitions a row to `sending`, and dropped in a `finally`
  // once that UPDATE has committed — so it brackets the span from "marker decision" to "committed `sending`
  // row". `settleRecoveryMarker` refuses to clear while any such span is open, so a concurrent pessimistic
  // sender (a `flushUnit` that does NOT ride `flushQueue`) that has passed the cached-dirty check but not yet
  // committed its `sending` UPDATE can never have the marker cleared out from under it.
  //
  // Soundness: EVERY pending→sending transition in existence flows through THIS one runtime on a single JS
  // thread (ADR-0002 single in-DB write path; one engine per store), so the counter fully orders every
  // "marker-decision → commit" span against every clear attempt; the durable guarded clear still protects
  // against already-committed rows. Why not the review's primary fix (BEGIN/COMMIT around marker + claim +
  // `sending`): it adds 3 crossings to every flush's hot path, and a single-crossing data-modifying CTE is
  // not expressible in drizzle-rc.4 — the counter costs ZERO crossings and is sound under the single-runtime
  // invariant.
  let markSendingInFlight = 0;
  const markSendingScope: MarkSendingScope = {
    enter: () => {
      markSendingInFlight += 1;
    },
    exit: () => {
      markSendingInFlight -= 1;
    },
  };

  /**
   * Marker-first SET: commit the marker `true` BEFORE the first
   * pending→sending transition of a dirty epoch. Invoked from the ONE choke point (`applyMutationStatusUpdates`,
   * gated on a `sending` target) immediately before its UPDATE executes. The upsert auto-commits, so the
   * marker is durable before any `sending` row can commit — the invariant the whole slice protects.
   */
  const ensureRecoveryMarker = async () => {
    if (!ownsMetaTable || recoveryMarkerDirty) {
      return;
    }
    await writeMutationRecoveryRequired(options.db, options.registry, true);
    recoveryMarkerDirty = true;
  };

  /**
   * Self-verifying clear at a post-ack seam (in-flight `sending` count has dropped to zero after a flush).
   * Writes the marker `false` only when NOT EXISTS any `sending` row across every writable journal; on a
   * successful clear the epoch-dirty flag resets so the next dirty epoch re-commits the marker.
   */
  const settleRecoveryMarker = async () => {
    if (!ownsMetaTable) {
      return;
    }
    // FIX 1: do NOT attempt the guarded clear while a concurrent mark-sending span is open (between its marker
    // decision and its committed `sending` UPDATE). Clearing now could write `false` before that sender's
    // `sending` row commits, stranding it on a crash. Each sender settles at its OWN end, so the last
    // concurrent unit to close its span still performs the clear — a skipped clear just leaves the
    // conservative `true` for the next settle (or boot recovery) to clear.
    if (markSendingInFlight > 0) {
      return;
    }
    // FIX 1b — reset the epoch-dirty flag SYNCHRONOUSLY here, in the SAME continuation as the counter check and
    // BEFORE the clear's `db.query` is issued (nothing awaits between them: `clearMutationRecoveryMarkerIfSettled`
    // builds the statement synchronously and its first await is `db.query`). Do NOT touch the flag AFTER the
    // clear resolves — a sender that entered mid-clear may have legitimately re-set it `true`, and stomping it
    // back to `false` would reopen the hole.
    //
    // Soundness against a sender racing an IN-FLIGHT clear: every sender's `enter()` + dirty-read is synchronous,
    // so relative to this synchronous check-and-reset block it is either
    //   (i)  BEFORE it → `markSendingInFlight > 0` here → no clear is issued at all (the FIX 1 gate); or
    //   (ii) AFTER it  → the sender reads `recoveryMarkerDirty === false` → it awaits
    //        `writeMutationRecoveryRequired(true)`, and PGlite's single-connection queue serializes that upsert
    //        AFTER the already-issued clear → the marker is durably `true` again BEFORE the sender's `sending`
    //        UPDATE (only issued once the marker await resolves) can commit. A crash between the rewrite and the
    //        UPDATE leaves marker-`true`/no-row (conservative).
    // On a guard-blocked clear (a committed `sending` row made the UPDATE a no-op) the flag stays pessimistically
    // `false`, so the next sender writes a redundant `true` — one extra crossing on a rare path, harmless.
    recoveryMarkerDirty = false;
    await clearMutationRecoveryMarkerIfSettled(options.db, options.registry);
  };

  /** The `sending → pending` recovery UPDATE for one journal (shared by the public + boot recovery paths). */
  const buildRecoverSendingQuery = (journal: JournalTable, nowUs: string) =>
    queryBuilder
      .update(journal)
      .set({
        status: "pending",
        updatedAtUs: nowUs,
        sentAtUs: null,
        nextRetryAtUs: nowUs,
        lastError: null,
        lastHttpStatus: null,
        conflictReason: null,
      })
      .where(eq(journal.status, "sending"))
      .toSQL();

  const readAffectedRows = (result: unknown): number => (result as { affectedRows?: number }).affectedRows ?? 0;

  const getTableContext = (table: SyncTableName<TRegistry>) => {
    const context = tableContexts[table];

    if (!context) {
      throw new Error(`Unknown mutation table: ${String(table)}`);
    }

    return context;
  };

  const runInTransaction = async (operation: () => Promise<void>) => {
    await options.db.exec("BEGIN");

    try {
      await operation();
      await options.db.exec("COMMIT");
    } catch (error) {
      await options.db.exec("ROLLBACK");
      throw error;
    }
  };

  const normalizeBatchItem = (
    item: MutationBatchItem<TRegistry>,
    order: number,
    claims: Record<string, unknown> | undefined,
  ): NormalizedBatchItem => {
    const context = getTableContext(item.table as SyncTableName<TRegistry>);
    const mutationId = globalThis.crypto.randomUUID();
    const nowUs = nowMicroseconds();

    switch (item.kind) {
      case "create": {
        const strippedInput = stripReadModelOverlayFields(item.input);
        const optimisticRecord = ensureRecord(createOptimisticRecordFromContext(context, strippedInput, claims));
        const entityKey = buildEntityKeyFromRecord(context, optimisticRecord);

        return {
          context,
          kind: "create",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          optimisticRecord,
          input: strippedInput,
          mutationId,
          nowUs,
          order,
        };
      }
      case "update": {
        const entityKey = normalizeEntityKey(context, item.entityKey);
        const patch = ensureRecord(stripReadModelOverlayFields(item.patch));

        return {
          context,
          kind: "update",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          patch,
          blind: item.blind ?? false,
          mutationId,
          nowUs,
          order,
        };
      }
      case "delete": {
        const entityKey = normalizeEntityKey(context, item.entityKey);

        return {
          context,
          kind: "delete",
          entityKey,
          entityKeyJson: serializeEntityKey(entityKey),
          mutationId,
          nowUs,
          order,
        };
      }
    }
  };

  const enqueueBatch = async (
    items: ReadonlyArray<MutationBatchItem<TRegistry>>,
    unit?: WriteUnit,
  ): Promise<string[]> => {
    if (items.length === 0) {
      return [];
    }

    // The distinct pessimistic write-unit ids this enqueue tagged — returned so the caller can
    // foreground-route them to the authoritative endpoint (ADR-0022). Empty for a purely optimistic batch.
    const pessimisticUnitIds = new Set<string>();

    // Resolve the decoded claims once per batch, but only if a create actually needs them (a target
    // table with an `authClaim` create-managed field). Avoids a token lookup for every other write.
    const needsAuthClaims = items.some(
      (item) =>
        item.kind === "create" &&
        getTableContext(item.table as SyncTableName<TRegistry>).managedAuthClaimCreateFields.length > 0,
    );
    const claims = needsAuthClaims ? await resolveAuthClaims() : undefined;

    const normalizedItems = items.map((item, index) => normalizeBatchItem(item, index, claims));

    // ADR-0039: report the DISTINCT non-blind table keys so the client can fire-and-forget activate
    // each target's lazy consistency group. A blind update plans a journal row only (no echo, no
    // activation — the write-only pattern), so it is never reported; create/delete are never blind.
    const ordinaryTables = new Set<string>();
    for (const item of normalizedItems) {
      if (item.kind === "update" && item.blind) {
        continue;
      }
      ordinaryTables.add(item.context.key);
    }
    if (ordinaryTables.size > 0 && options.onOrdinaryEnqueue) {
      try {
        options.onOrdinaryEnqueue([...ordinaryTables]);
      } catch {
        // A hook throw must never fail the enqueue (ADR-0039): the activation is a fire-and-forget
        // best-effort; the group self-heals on its next activation regardless.
      }
    }

    const batchGroups = new Map<string, { context: TableContext; items: NormalizedBatchItem[] }>();

    for (const item of normalizedItems) {
      const existing = batchGroups.get(item.context.key);

      if (existing) {
        existing.items.push(item);
        continue;
      }

      batchGroups.set(item.context.key, {
        context: item.context,
        items: [item],
      });
    }

    for (const { context, items: groupedItems } of batchGroups.values()) {
      groupedItems.sort((left, right) => left.order - right.order);
      const uniqueEntities = dedupeBatchEntities(groupedItems);
      const latestMutationStates = await readLatestMutationStates(options.db, context, uniqueEntities);
      const currentRecordStates = await readCurrentRecordStates(options.db, context, uniqueEntities);
      const entityStates = new Map<string, BatchEntityState>();

      for (const entity of uniqueEntities) {
        const latestState = latestMutationStates.get(entity.entityKeyJson);
        const currentState = currentRecordStates.get(entity.entityKeyJson);

        entityStates.set(entity.entityKeyJson, {
          entityKey: entity.entityKey,
          entityKeyJson: entity.entityKeyJson,
          record: currentState ? extractRecordFromState(context, currentState) : null,
          overlayKind: currentState?.overlayKind ?? null,
          localUpdatedAtUs: currentState?.localUpdatedAtUs ?? null,
          latestMutationSeq: latestState?.latestMutationSeq ?? null,
          latestMutationKind: latestState?.latestMutationKind ?? null,
          latestMutationStatus: latestState?.latestMutationStatus ?? null,
        });
      }

      const plannedMutations: PlannedMutationInsert[] = [];
      const plannedOverlays = new Map<string, PlannedOverlayUpsert>();

      for (const item of groupedItems) {
        const entityState = entityStates.get(item.entityKeyJson);

        if (!entityState) {
          throw new Error(`Missing batch state for table ${context.key}`);
        }

        switch (item.kind) {
          case "create": {
            if ((entityState.latestMutationSeq ?? 0) !== 0) {
              throw new Error(`${context.key} already has queued mutations`);
            }

            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "create",
              payloadJson: jsonStringifyPayload({
                kind: "create",
                value: item.input,
              }),
              nowUs: item.nowUs,
              // A create has no Base server version (ADR-0015): its conflict is a PK collision, a
              // separate concern from the stale-write check.
              baseServerVersion: null,
            });

            entityState.record = item.optimisticRecord;
            entityState.overlayKind = "pending_create";
            entityState.localUpdatedAtUs = item.nowUs;
            entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
            entityState.latestMutationKind = "create";
            entityState.latestMutationStatus = "pending";
            plannedOverlays.set(item.entityKeyJson, {
              entityKey: item.entityKey,
              record: item.optimisticRecord,
              overlayKind: "pending_create",
              localUpdatedAtUs: item.nowUs,
            });
            break;
          }
          case "update": {
            if (item.blind) {
              // ADR-0022 addendum — a BLIND update: the write target is excluded from the actor's read
              // shape (its rows never stream here), so there is no local base row to seed and no optimistic
              // state to show. It is meaningful ONLY when the write routes to the authoritative endpoint (the
              // /unit expander is authoritative): an optimistic-routed blind write has nothing to converge, so
              // it is rejected at enqueue. The `unit` fixes the route inside a `transaction` block; a plain
              // enqueue on a statically-pessimistic table earns its own pessimistic unit downstream.
              const routesPessimistic = unit ? unit.mode === "pessimistic" : context.entry.writeMode === "pessimistic";
              if (!routesPessimistic) {
                throw new Error(
                  `${context.key}: updateBlind requires a pessimistic write unit — use transaction({ mode: "pessimistic" }) (an optimistic blind write has nothing to show and no base to converge)`,
                );
              }

              // KEEP the already-queued-for-deletion guard (journal-derived; needs no local record).
              if (entityState.latestMutationKind === "delete" && entityState.latestMutationStatus !== "acked") {
                throw new Error(`${context.key} is already queued for deletion`);
              }

              // Plan a journal row ONLY — no overlay, so nothing enters the read model and nothing can linger
              // there. `baseServerVersion: null`: the /unit expander is authoritative, there is no base to
              // capture. The `pessimistic-blind` marker keeps the row off the optimistic flusher and lets
              // reconcile retire it after ack WITHOUT a synced echo (there is no visible row to converge).
              plannedMutations.push({
                mutationId: item.mutationId,
                entityKey: item.entityKey,
                entityKeyJson: item.entityKeyJson,
                mutationKind: "update",
                payloadJson: jsonStringifyPayload({
                  kind: "update",
                  patch: item.patch,
                }),
                nowUs: item.nowUs,
                baseServerVersion: null,
                writeMode: "pessimistic-blind",
              });

              // Advance only the journal-derived tracking (no record/overlay): so a later same-batch item on
              // this entity chains in author order and sees the pending blind write.
              entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
              entityState.latestMutationKind = "update";
              entityState.latestMutationStatus = "pending";
              break;
            }

            if (!entityState.record) {
              throw new Error(`${context.key} not found in local read model`);
            }

            if (entityState.latestMutationKind === "delete" && entityState.latestMutationStatus !== "acked") {
              throw new Error(`${context.key} is already queued for deletion`);
            }

            // ADR-0015: capture the Base server version BEFORE the record is replaced by the
            // optimistic value below (which overwrites the Server version with the client clock).
            const updateBaseServerVersion = captureChainHeadBase(context, entityState);
            const overlayKind = entityState.overlayKind === "pending_create" ? "pending_create" : "pending_update";
            const optimisticRecord = ensureRecord(
              buildOptimisticRecord(
                context,
                {
                  ...entityState.record,
                  ...item.patch,
                  // Re-stamp the on-update managed timestamp(s) generically (governance-driven) — for a
                  // convention table this is exactly `updatedAtUs`, for a custom-named Server version
                  // it is that column, so the optimistic row never carries a stale managed value.
                  ...buildUpdateManagedNowStamp(context, item.nowUs),
                },
                {
                  overlayKind,
                  localUpdatedAtUs: item.nowUs,
                },
              ),
            );
            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "update",
              payloadJson: jsonStringifyPayload({
                kind: "update",
                patch: item.patch,
              }),
              nowUs: item.nowUs,
              baseServerVersion: updateBaseServerVersion,
            });

            entityState.record = optimisticRecord;
            entityState.overlayKind = overlayKind;
            entityState.localUpdatedAtUs = item.nowUs;
            entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
            entityState.latestMutationKind = "update";
            entityState.latestMutationStatus = "pending";
            plannedOverlays.set(item.entityKeyJson, {
              entityKey: item.entityKey,
              record: optimisticRecord,
              overlayKind,
              localUpdatedAtUs: item.nowUs,
            });
            break;
          }
          case "delete": {
            if (!entityState.record) {
              throw new Error(`${context.key} not found in local read model`);
            }

            if (entityState.latestMutationKind === "delete" && entityState.latestMutationStatus !== "acked") {
              throw new Error(`${context.key} is already queued for deletion`);
            }

            const deleteBaseServerVersion = captureChainHeadBase(context, entityState);
            plannedMutations.push({
              mutationId: item.mutationId,
              entityKey: item.entityKey,
              entityKeyJson: item.entityKeyJson,
              mutationKind: "delete",
              payloadJson: jsonStringifyPayload({
                kind: "delete",
                entityKey: item.entityKey,
              }),
              nowUs: item.nowUs,
              baseServerVersion: deleteBaseServerVersion,
            });

            entityState.overlayKind = "pending_delete";
            entityState.localUpdatedAtUs = item.nowUs;
            entityState.latestMutationSeq = (entityState.latestMutationSeq ?? 0) + 1;
            entityState.latestMutationKind = "delete";
            entityState.latestMutationStatus = "pending";
            plannedOverlays.set(item.entityKeyJson, {
              entityKey: item.entityKey,
              record: entityState.record,
              overlayKind: "pending_delete",
              localUpdatedAtUs: item.nowUs,
            });
            break;
          }
        }
      }

      // ADR-0022: an explicit unit (from a `transaction` block) tags the whole batch; otherwise a
      // statically-`pessimistic` table earns its own per-enqueue unit, so its writes route to the
      // authoritative endpoint too. An optimistic table with no explicit unit stays untagged.
      const effectiveUnit: WriteUnit | undefined =
        unit ??
        (context.entry.writeMode === "pessimistic"
          ? { id: globalThis.crypto.randomUUID(), mode: "pessimistic" }
          : undefined);
      if (effectiveUnit?.mode === "pessimistic") {
        pessimisticUnitIds.add(effectiveUnit.id);
      }
      await insertMutationsBulk(options.db, context, plannedMutations, registryVersion, effectiveUnit);
      await upsertOverlayRecordsBulk(options.db, context, [...plannedOverlays.values()]);
    }

    return [...pessimisticUnitIds];
  };

  const runFlush = async (table?: SyncTableName<TRegistry>) => {
    const affectedContexts = new Map<string, TableContext>();
    const quarantinedMutationIds = new Set<string>();
    const conflictedMutationIds = new Set<string>();
    let processedCount = 0;

    do {
      const batchResult = await flushBatch(
        options.db,
        tableContexts as Record<string, TableContext>,
        mutationUrls.batch,
        maxMutationAttempts,
        flushBatchSize,
        table,
        resolveAuthToken,
        options.requestHeaders,
        ensureRecoveryMarker,
        markSendingScope,
        disposeController.signal,
      );

      processedCount = batchResult.processedCount;

      for (const context of batchResult.affectedContexts) {
        affectedContexts.set(context.key, context);
      }

      for (const mutationId of batchResult.quarantinedMutationIds) {
        quarantinedMutationIds.add(mutationId);
      }

      for (const mutationId of batchResult.conflictedMutationIds) {
        conflictedMutationIds.add(mutationId);
      }
    } while (processedCount > 0);

    for (const context of affectedContexts.values()) {
      await reconcileTable(options.db, context);
    }

    // Post-ack seam (optimistic path): the drain loop above has settled every `sending` row this pass
    // produced (into acked/failed/quarantined/conflicted), so try the self-verifying clear — it writes the
    // marker `false` iff no `sending` row remains across any journal, resetting the epoch-dirty flag.
    await settleRecoveryMarker();

    // Surface newly-quarantined mutations after reconciliation so the app never has to
    // poll for permanently-rejected writes (ADR-0006 decision 4). Never silent loss.
    if (quarantinedMutationIds.size > 0 && options.onQuarantine) {
      const details = await readMutationDetailsForContexts(
        options.db,
        [...affectedContexts.values()],
        quarantinedMutationIds,
      );

      if (details.length > 0) {
        await options.onQuarantine(details);
      }
    }

    // Surface newly-conflicted (stale) writes (ADR-0015). The optimistic Overlay is kept, so the app
    // can show a resolution/diff UI and resolve each as a new write (or discard it). Never silent.
    if (conflictedMutationIds.size > 0 && options.onConflict) {
      const details = await readMutationDetailsForContexts(
        options.db,
        [...affectedContexts.values()],
        conflictedMutationIds,
      );

      if (details.length > 0) {
        await options.onConflict(details);
      }
    }
  };

  const runtime: MutationRuntime<TRegistry> = {
    registryVersion,
    create: async (table, input) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch([{ table, kind: "create", input }]);
      });
      // A statically-`pessimistic` table foreground-routes its write to the authoritative endpoint
      // (ADR-0022) — the write is server-authoritative, so it is sent immediately, not left for the
      // optimistic convergence loop (which skips pessimistic rows).
      for (const unitId of unitIds) {
        await runtime.flushUnit(unitId);
      }
    },
    update: async (table, entityKeyInput, patch) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch([{ table, kind: "update", entityKey: entityKeyInput, patch }]);
      });
      for (const unitId of unitIds) {
        await runtime.flushUnit(unitId);
      }
    },
    delete: async (table, entityKeyInput) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch([{ table, kind: "delete", entityKey: entityKeyInput }]);
      });
      for (const unitId of unitIds) {
        await runtime.flushUnit(unitId);
      }
    },
    batch: async (items, unit) => {
      let unitIds: string[] = [];
      await runInTransaction(async () => {
        unitIds = await enqueueBatch(items, unit);
      });
      // An explicit unit (from a `transaction` block) is flushed by the caller; only foreground-route the
      // units a plain `batch()` generated for statically-pessimistic tables.
      if (!unit) {
        for (const unitId of unitIds) {
          await runtime.flushUnit(unitId);
        }
      }
    },
    discardConflict: async (table, entityKeyInput) => {
      const context = getTableContext(table);
      const entityKey = normalizeEntityKey(context, entityKeyInput);
      const entityKeyJson = serializeEntityKey(entityKey);

      // discardTerminalEntity owns its own transaction (like reconcileTable), so it is not wrapped.
      await discardTerminalEntity(options.db, context, entityKey, entityKeyJson, "conflicted");
    },
    discardQuarantined: async (table, entityKeyInput) => {
      const context = getTableContext(table);
      const entityKey = normalizeEntityKey(context, entityKeyInput);
      const entityKeyJson = serializeEntityKey(entityKey);

      // Symmetric to discardConflict — retire the entity's `quarantined` journal rows and clear the
      // kept overlay behind the same owed-guard, so a permanently-rejected write is a real rollback.
      await discardTerminalEntity(options.db, context, entityKey, entityKeyJson, "quarantined");
    },
    flush: async (table) => {
      const nextFlush = flushQueue.then(() => runFlush(table));
      flushQueue = nextFlush.catch(() => undefined);
      await nextFlush;
    },
    abortInFlight: () => disposeController.abort(),
    flushUnit: async (unitId) => {
      const contexts = Object.values(tableContexts).filter((context): context is TableContext => context != null);
      const unitRows = await readUnitPendingRows(options.db, contexts, unitId);
      if (unitRows.length === 0) {
        return { acks: [] };
      }

      // Prepare the unit's rows (entity key + envelope payload) and group them by table.
      const prepared: PreparedBatchRow[] = [];
      const byContext = new Map<string, PreparedBatchRow[]>();
      for (const row of unitRows) {
        const context = tableContexts[row.tableKey];
        if (!context) {
          continue;
        }
        const entityKey = JSON.parse(row.entityKeyJson) as Record<string, string>;
        const rawPayload = JSON.parse(row.payloadJson) as Record<string, unknown>;
        const preparedRow: PreparedBatchRow = {
          ...row,
          context,
          entityKey,
          envelopePayload:
            row.mutationKind === "delete"
              ? entityKey
              : toSqlColumnPayload(
                  context,
                  stripManagedFields(
                    context,
                    (rawPayload["value"] ?? rawPayload["patch"] ?? rawPayload) as Record<string, unknown>,
                    row.mutationKind as "create" | "update",
                  ),
                ),
          sqlTableName: context.entry.shape?.tableName ?? context.key,
        };
        prepared.push(preparedRow);
        const list = byContext.get(context.key);
        if (list) {
          list.push(preparedRow);
        } else {
          byContext.set(context.key, [preparedRow]);
        }
      }

      // Mark every member sending (persist the resolved Base server version, like the batch path).
      const sentAtUs = nowMicroseconds();
      for (const rows of byContext.values()) {
        await applyMutationStatusUpdates(
          options.db,
          rows[0]!.context,
          rows.map((row) => ({
            mutationId: row.mutationId,
            status: "sending" as const,
            attemptCount: row.attemptCount + 1,
            updatedAtUs: sentAtUs,
            sentAtUs,
            replaceSentAtUs: true,
            baseServerVersion: row.baseServerVersion,
            replaceBaseServerVersion: true,
            lastError: null,
            nextRetryAtUs: null,
            lastHttpStatus: null,
            conflictReason: null,
          })),
          ensureRecoveryMarker,
          markSendingScope,
        );
      }

      const mutations = prepared.map((row) => ({
        tableName: row.sqlTableName,
        entityKey: row.entityKey,
        mutationId: row.mutationId,
        mutationSeq: row.mutationSeq,
        kind: row.mutationKind as "create" | "update" | "delete",
        payload: row.envelopePayload,
        clientTimestampUs: sentAtUs,
        ...(row.baseServerVersion != null ? { baseServerVersion: row.baseServerVersion } : {}),
      }));

      const url = mutationUrls.authoritative;
      let acksByMutationId: Map<string, BatchMutationAck["acks"][number]>;

      try {
        const authToken = await untilAborted(Promise.resolve(options.getAuthToken?.()));
        let response = await fetch(url, {
          method: "POST",
          headers: buildRequestHeaders(authToken, options.requestHeaders),
          body: jsonStringifyPayload({ writeUnit: unitId, mutations }),
          signal: disposeController.signal,
        });

        if ([401, 403].includes(response.status) && options.getAuthToken) {
          const retryToken = await untilAborted(Promise.resolve(options.getAuthToken()));
          response = await fetch(url, {
            method: "POST",
            headers: buildRequestHeaders(retryToken, options.requestHeaders),
            body: jsonStringifyPayload({ writeUnit: unitId, mutations }),
            signal: disposeController.signal,
          });
        }

        if (!response.ok) {
          const text = await response.text();
          throw new MutationRequestError(
            text.length > 0 ? text : `Authoritative write responded with ${response.status}`,
            response.status,
            parseBatchRejections(text),
          );
        }

        const responseJson = (await response.json()) as BatchMutationAck;
        acksByMutationId = new Map(responseJson.acks.map((ack) => [ack.mutationId, ack]));
      } catch (error) {
        // A pessimistic write is foreground: it never reached the server (transport / non-2xx), so the
        // unit did not happen. Mark it failed — KEEPING the optimistic overlay so a retry can resend — and
        // rethrow so the caller surfaces it. There is no background retry for pessimistic units.
        const failedAtUs = nowMicroseconds();
        const httpStatus = error instanceof MutationRequestError ? error.status : null;
        const errorMessage = error instanceof Error ? error.message : "Authoritative write failed";
        for (const rows of byContext.values()) {
          await applyMutationStatusUpdates(
            options.db,
            rows[0]!.context,
            rows.map((row) => {
              const attemptCount = row.attemptCount + 1;
              const outcome = resolveBatchFailureOutcome(attemptCount, maxMutationAttempts, failedAtUs);
              return {
                mutationId: row.mutationId,
                status: outcome.status,
                attemptCount,
                updatedAtUs: failedAtUs,
                lastError: errorMessage,
                nextRetryAtUs: outcome.nextRetryAtUs,
                lastHttpStatus: httpStatus,
                conflictReason: null,
              };
            }),
          );
        }
        throw error;
      }

      // Apply each member's ack.
      const ackedAtUs = nowMicroseconds();
      const failedAtUs = nowMicroseconds();
      const rejectedIds = new Set<string>();
      const conflictedIds = new Set<string>();

      for (const rows of byContext.values()) {
        await applyMutationStatusUpdates(
          options.db,
          rows[0]!.context,
          rows.map((row) => {
            const ack = acksByMutationId.get(row.mutationId);

            if (ack?.status === "rejected") {
              // ADR-0022 §4: a business rejection. Terminal `rejected`; the overlay is auto-discarded below.
              rejectedIds.add(row.mutationId);
              return {
                mutationId: row.mutationId,
                status: "rejected" as const,
                attemptCount: row.attemptCount + 1,
                updatedAtUs: failedAtUs,
                lastError: ack.rejectionReason ?? "Rejected by the authoritative endpoint",
                nextRetryAtUs: null,
                lastHttpStatus: ack.httpStatus ?? 409,
                conflictReason: ack.rejectionReason ?? "Rejected by the authoritative endpoint",
              };
            }

            if (ack?.status === "conflicted") {
              // ADR-0015: a stale member — terminal `conflicted`, overlay KEPT (resolve as a new write).
              conflictedIds.add(row.mutationId);
              return {
                mutationId: row.mutationId,
                status: "conflicted" as const,
                attemptCount: row.attemptCount + 1,
                updatedAtUs: failedAtUs,
                serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
                replaceServerUpdatedAtUs: true,
                lastError: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
                nextRetryAtUs: null,
                lastHttpStatus: ack.httpStatus ?? 409,
                conflictReason: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
              };
            }

            if (!ack || ack.status !== "acked") {
              const attemptCount = row.attemptCount + 1;
              const outcome = resolveFailureOutcome(
                ack?.httpStatus ?? null,
                attemptCount,
                maxMutationAttempts,
                failedAtUs,
              );
              return {
                mutationId: row.mutationId,
                status: outcome.status,
                attemptCount,
                updatedAtUs: failedAtUs,
                lastError: ack?.conflictReason ?? "Authoritative write not acknowledged",
                nextRetryAtUs: outcome.nextRetryAtUs,
                lastHttpStatus: ack?.httpStatus ?? null,
                conflictReason: null,
              };
            }

            return {
              mutationId: row.mutationId,
              status: "acked" as const,
              attemptCount: row.attemptCount + 1,
              updatedAtUs: ackedAtUs,
              ackedAtUs,
              replaceAckedAtUs: true,
              serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
              replaceServerUpdatedAtUs: true,
              lastError: null,
              nextRetryAtUs: null,
              lastHttpStatus: row.mutationKind === "delete" ? 204 : 200,
              conflictReason: null,
            };
          }),
        );
      }

      // ADR-0022 §4: auto-discard the optimistic overlay for every rejected entity (the whole unit was
      // declined). The terminal `rejected` journal row is kept for diagnostics + `onReject`.
      for (const row of prepared) {
        if (rejectedIds.has(row.mutationId)) {
          await discardOverlayForSettledEntity(options.db, row.context, row.entityKey, row.entityKeyJson);
        }
      }

      const affectedContexts = [...byContext.keys()]
        .map((key) => tableContexts[key])
        .filter((context): context is TableContext => context != null);
      for (const context of affectedContexts) {
        await reconcileTable(options.db, context);
      }

      if (rejectedIds.size > 0 && options.onReject) {
        const details = await readMutationDetailsForContexts(options.db, affectedContexts, rejectedIds);
        if (details.length > 0) {
          await options.onReject(details);
        }
      }
      if (conflictedIds.size > 0 && options.onConflict) {
        const details = await readMutationDetailsForContexts(options.db, affectedContexts, conflictedIds);
        if (details.length > 0) {
          await options.onConflict(details);
        }
      }

      // Post-ack seam (pessimistic path): every member of the unit has left `sending`, so try the
      // self-verifying clear — it settles the marker to `false` iff no `sending` row remains anywhere.
      await settleRecoveryMarker();

      return { acks: [...acksByMutationId.values()] };
    },
    reconcile: async (table) => {
      const contexts = filterContexts(tableContexts, table);

      for (const context of contexts) {
        await reconcileTable(options.db, context);
      }
    },
    retryFailed: async (table) => {
      assertValidMutationTransition("failed", "pending");
      const contexts = filterContexts(tableContexts, table);
      const nowUs = nowMicroseconds();

      for (const context of contexts) {
        const journal = context.tables.journal;
        const query = queryBuilder
          .update(journal)
          .set({ status: "pending", nextRetryAtUs: nowUs, updatedAtUs: nowUs, conflictReason: null })
          .where(eq(journal.status, "failed"))
          .toSQL();
        await options.db.query(query.sql, query.params as unknown[]);
      }
    },
    recoverSending: async (table) => {
      assertValidMutationTransition("sending", "pending");
      const contexts = filterContexts(tableContexts, table);
      const nowUs = nowMicroseconds();

      for (const context of contexts) {
        const query = buildRecoverSendingQuery(context.tables.journal, nowUs);
        await options.db.query(query.sql, query.params as unknown[]);
      }
    },
    runBootRecovery: async ({ ownsMetaTable: bootOwnsMetaTable, restore }) => {
      assertValidMutationTransition("sending", "pending");
      const contexts = filterContexts(tableContexts, undefined);
      const tablesVisited = contexts.length;

      // Caller-owned PGlite: the meta table may not exist, so never touch the marker and always recover.
      if (!bootOwnsMetaTable) {
        await runtime.recoverSending();
        return { skipped: false, required: true, tablesVisited, rowsRecovered: null };
      }

      // Restore boot ignores the marker entirely: unconditional recovery lifts any `sending` back to
      // `pending`, quarantine parks every recovered non-terminal row, then the self-verifying clear settles
      // the marker (a clean marker in the backup must never bypass quarantine — quarantine ran first).
      if (restore) {
        await runtime.recoverSending();
        await runtime.quarantineRecovered();
        await settleRecoveryMarker();
        return { skipped: false, required: true, tablesVisited, rowsRecovered: null };
      }

      const marker = await readMutationRecoveryRequired(options.db, options.registry);

      // Marker `false`: a clean prior settle proved no `sending` row remains — skip the per-table loop.
      if (marker === false) {
        return { skipped: true, required: false, tablesVisited: 0, rowsRecovered: 0 };
      }

      // Marker absent (not initialized): one conservative recovery pass, then initialize the marker
      // (the pass just guaranteed no `sending` row remains, so an unconditional `false` is correct).
      if (marker === null) {
        await runtime.recoverSending();
        await writeMutationRecoveryRequired(options.db, options.registry, false);
        recoveryMarkerDirty = false;
        return { skipped: false, required: true, tablesVisited, rowsRecovered: null };
      }

      // Marker `true`: a crash may have left committed `sending` rows. Run the N per-table updates PLUS the
      // self-verifying clear atomically (a correctness upgrade over today's un-wrapped loop), counting the
      // rows lifted `sending → pending` from each UPDATE's affected-row count.
      const nowUs = nowMicroseconds();
      let rowsRecovered = 0;
      await runInTransaction(async () => {
        for (const context of contexts) {
          const query = buildRecoverSendingQuery(context.tables.journal, nowUs);
          const result = await options.db.query(query.sql, query.params as unknown[]);
          rowsRecovered += readAffectedRows(result);
        }
        await clearMutationRecoveryMarkerIfSettled(options.db, options.registry);
      });
      recoveryMarkerDirty = false;
      return { skipped: false, required: true, tablesVisited, rowsRecovered };
    },
    quarantineRecovered: async (table) => {
      // The restore-boot quarantine (ADR-0035 decision 6): every non-terminal recovered row is parked in the
      // terminal `quarantined` state so NOTHING recovered from a backup auto-flushes (no dedupe ledger →
      // unsafe replay). `pending -> quarantined` is a restore-only edge (see mutation-state.ts); `sending`
      // and `failed` already reach quarantine. Assert all three edges up front so a future transition-table
      // change that breaks restore fails loudly here rather than silently skipping the quarantine.
      assertValidMutationTransition("pending", "quarantined");
      assertValidMutationTransition("sending", "quarantined");
      assertValidMutationTransition("failed", "quarantined");
      const contexts = filterContexts(tableContexts, table);
      const nowUs = nowMicroseconds();

      for (const context of contexts) {
        const journal = context.tables.journal;
        const query = queryBuilder
          .update(journal)
          .set({
            status: "quarantined",
            updatedAtUs: nowUs,
            // Terminal: never retried, so clear the retry cursor and name restore as the cause on the row so
            // an inspecting app can tell a restore-quarantined write from a server-rejected one.
            nextRetryAtUs: null,
            lastError: "Quarantined on restore: recovered from a store backup, not replayed (ADR-0035).",
            conflictReason: null,
          })
          .where(inArray(journal.status, ["pending", "sending", "failed"]))
          .toSQL();
        await options.db.query(query.sql, query.params as unknown[]);
      }
    },
    readMutationStats: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      const totals: MutationDiagnostics = {
        pendingCount: 0,
        sendingCount: 0,
        failedCount: 0,
        quarantinedCount: 0,
        conflictedCount: 0,
        rejectedCount: 0,
        ackedCount: 0,
      };

      for (const context of contexts) {
        const journal = context.tables.journal;
        // Drizzle has no `FILTER` operator (tier ②): each aggregate is a typed `sql` fragment over the
        // journal `status` column object with a bound status literal, aliased to the exact camelCase row
        // key the totals below read (the raw seam returns rows UNMAPPED, so aliases are load-bearing).
        const filteredCount = (status: MutationStatus, columnAlias: string) =>
          sql<number>`count(*) filter (where ${journal.status} = ${status})::int`.as(columnAlias);
        const query = queryBuilder
          .select({
            pendingCount: filteredCount("pending", "pendingCount"),
            sendingCount: filteredCount("sending", "sendingCount"),
            failedCount: filteredCount("failed", "failedCount"),
            quarantinedCount: filteredCount("quarantined", "quarantinedCount"),
            conflictedCount: filteredCount("conflicted", "conflictedCount"),
            rejectedCount: filteredCount("rejected", "rejectedCount"),
            ackedCount: filteredCount("acked", "ackedCount"),
          })
          .from(journal)
          .toSQL();
        const result = await options.db.query<MutationDiagnostics & Record<string, unknown>>(
          query.sql,
          query.params as unknown[],
        );

        const row = result.rows[0];
        if (!row) {
          continue;
        }

        totals.pendingCount += row.pendingCount;
        totals.sendingCount += row.sendingCount;
        totals.failedCount += row.failedCount;
        totals.quarantinedCount += row.quarantinedCount;
        totals.conflictedCount += row.conflictedCount;
        totals.rejectedCount += row.rejectedCount;
        totals.ackedCount += row.ackedCount;
      }

      return totals;
    },
    readMutationDetails: async (table) => {
      const contexts = filterContexts(tableContexts, table);
      return readMutationDetailsForContexts(options.db, contexts);
    },
    createOptimisticRecord: (table, input) => {
      const context = getTableContext(table);
      return createOptimisticRecordFromContext(context, input);
    },
  };

  return runtime;
}

/**
 * Read journal entries across the given contexts as {@link MutationDetail}s, newest first.
 * Shared by the public `readMutationDetails` and the flush path's quarantine surfacing,
 * optionally narrowed to a set of mutation ids.
 */
async function readMutationDetailsForContexts(
  db: MutationDb,
  contexts: TableContext[],
  mutationIds?: ReadonlySet<string>,
): Promise<MutationDetail[]> {
  const rows: MutationDetail[] = [];

  for (const context of contexts) {
    const journal = context.tables.journal;
    // The raw seam returns rows UNMAPPED (no drizzle result mapping), so every field is aliased
    // explicitly to its camelCase row key, and the `_us` bigints keep their `::text` casts.
    const query = queryBuilder
      .select({
        mutationId: sql<string>`${journal.mutationId}`.as("mutationId"),
        entityKeyJson: sql<string>`${journal.entityKeyJson}`.as("entityKeyJson"),
        mutationSeq: sql<number>`${journal.mutationSeq}`.as("mutationSeq"),
        mutationKind: sql<MutationKind>`${journal.mutationKind}`.as("mutationKind"),
        status: journal.status,
        attemptCount: sql<number>`${journal.attemptCount}`.as("attemptCount"),
        lastHttpStatus: sql<number | null>`${journal.lastHttpStatus}`.as("lastHttpStatus"),
        lastError: sql<string | null>`${journal.lastError}`.as("lastError"),
        conflictReason: sql<string | null>`${journal.conflictReason}`.as("conflictReason"),
        nextRetryAtUs: sql<string | null>`${journal.nextRetryAtUs}::text`.as("nextRetryAtUs"),
        serverUpdatedAtUs: sql<string | null>`${journal.serverUpdatedAtUs}::text`.as("serverUpdatedAtUs"),
        updatedAtUs: sql<string>`${journal.updatedAtUs}::text`.as("updatedAtUs"),
        registryVersion: sql<string>`${journal.registryVersion}`.as("registryVersion"),
      })
      .from(journal)
      .orderBy(desc(journal.updatedAtUs), desc(journal.mutationSeq))
      .toSQL();
    const result = await db.query<MutationDetailRow>(query.sql, query.params as unknown[]);

    for (const row of result.rows) {
      if (mutationIds && !mutationIds.has(row.mutationId)) {
        continue;
      }

      rows.push({
        tableName: context.key,
        entityKey: JSON.parse(row.entityKeyJson) as Record<string, string>,
        mutationId: row.mutationId,
        mutationSeq: row.mutationSeq,
        mutationKind: row.mutationKind,
        status: row.status,
        attemptCount: row.attemptCount,
        lastHttpStatus: row.lastHttpStatus,
        lastError: row.lastError,
        conflictReason: row.conflictReason,
        nextRetryAtUs: row.nextRetryAtUs,
        serverUpdatedAtUs: row.serverUpdatedAtUs,
        updatedAtUs: row.updatedAtUs,
        registryVersion: row.registryVersion,
      });
    }
  }

  return rows.sort((left, right) => Number(right.updatedAtUs) - Number(left.updatedAtUs));
}

interface MutationRow extends Record<string, unknown> {
  mutationId: string;
  entityKeyJson: string;
  mutationSeq: number;
  mutationKind: MutationKind;
  status: MutationStatus;
  payloadJson: string;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
  registryVersion: string;
}

interface MutationDetailRow extends Record<string, unknown> {
  mutationId: string;
  entityKeyJson: string;
  mutationSeq: number;
  mutationKind: MutationKind;
  status: MutationStatus;
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
  updatedAtUs: string;
  registryVersion: string;
}

interface CurrentRecordStateRow extends Record<string, unknown> {
  overlayKind: string;
  localUpdatedAtUs: string;
  latestMutationSeq: number | null;
  latestMutationKind: MutationKind | null;
  latestMutationStatus: MutationStatus | null;
}

interface BatchLatestMutationStateRow extends Record<string, unknown> {
  entityKeyJson: string;
  latestMutationSeq: number | null;
  latestMutationKind: MutationKind | null;
  latestMutationStatus: MutationStatus | null;
}

interface BatchCurrentRecordStateRow extends Record<string, unknown> {
  entityKeyJson: string;
  overlayKind: string;
  localUpdatedAtUs: string;
}

interface BatchEntityRef {
  entityKey: Record<string, string>;
  entityKeyJson: string;
}

interface PlannedMutationInsert {
  mutationId: string;
  entityKey: Record<string, string>;
  entityKeyJson: string;
  mutationKind: MutationKind;
  payloadJson: string;
  nowUs: string;
  /**
   * The Base server version (ADR-0015) stamped at enqueue: the synced Server version the user saw,
   * for a **chain head** (the first staged write on the entity). `null` for a `create` (no base) and
   * for a **chained** write — the latter resolves its base at flush from its acked predecessor
   * (readPendingBatchRows), by Per-entity flush serialization (ADR-0014).
   */
  baseServerVersion: string | null;
  /**
   * A per-row `write_mode` override (ADR-0022 addendum). Left unset for an ordinary row, which inherits the
   * unit's mode at insert. A blind update sets `"pessimistic-blind"` so the row is flushed only by its unit's
   * foreground path (never the optimistic batch) and retires from the journal without a synced echo.
   */
  writeMode?: string | null;
}

interface PlannedOverlayUpsert {
  entityKey: Record<string, string>;
  record: Record<string, unknown>;
  overlayKind: string;
  localUpdatedAtUs: string;
}

interface BatchEntityState {
  entityKey: Record<string, string>;
  entityKeyJson: string;
  record: Record<string, unknown> | null;
  overlayKind: string | null;
  localUpdatedAtUs: string | null;
  latestMutationSeq: number | null;
  latestMutationKind: MutationKind | null;
  latestMutationStatus: MutationStatus | null;
}

type NormalizedBatchItem =
  | {
      context: TableContext;
      kind: "create";
      entityKey: Record<string, string>;
      entityKeyJson: string;
      optimisticRecord: Record<string, unknown>;
      input: unknown;
      mutationId: string;
      nowUs: string;
      order: number;
    }
  | {
      context: TableContext;
      kind: "update";
      entityKey: Record<string, string>;
      entityKeyJson: string;
      patch: Record<string, unknown>;
      /** A blind update (ADR-0022 addendum): journal-only, no base-row presence check, no overlay. */
      blind: boolean;
      mutationId: string;
      nowUs: string;
      order: number;
    }
  | {
      context: TableContext;
      kind: "delete";
      entityKey: Record<string, string>;
      entityKeyJson: string;
      mutationId: string;
      nowUs: string;
      order: number;
    };

/**
 * The Base server version (ADR-0015) to stamp at enqueue for an update/delete. Only a **chain head**
 * — the first staged write on the entity (no earlier unresolved mutation) — captures an enqueue-time
 * base: the synced Server version the user's edit was authored against, so a genuine external write
 * between view and apply is caught. A **chained** write (an earlier same-entity mutation is still
 * owed) returns `null` here; it resolves its base at flush from its acked predecessor, so an entity's
 * own successive edits never self-conflict (decision 2).
 */
function captureChainHeadBase(context: TableContext, entityState: BatchEntityState): string | null {
  if ((entityState.latestMutationSeq ?? 0) !== 0) {
    return null;
  }

  if (!context.serverVersionPropertyKey || !entityState.record) {
    return null;
  }

  // The Server version is a bigint count of microseconds, surfaced as a string/number/bigint
  // depending on the read path. Anything else (null/object) means no observable base.
  const raw = entityState.record[context.serverVersionPropertyKey];
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint") {
    return String(raw);
  }

  return null;
}

function buildTableContexts<TRegistry extends SyncTableRegistry>(registry: TRegistry) {
  const localSchema = getSyncRegistrySchema(registry);

  return Object.fromEntries(
    Object.entries(registry)
      .filter(([, entry]) => entry.mode !== "readonly")
      .map(([key, entry]) => [key, buildTableContext(registry, key, entry, localSchema)]),
  ) as Partial<Record<SyncTableName<TRegistry>, TableContext>>;
}

function buildTableContext<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  key: string,
  entry: SyncTableEntry<AnyPgTable>,
  localSchema: string,
): TableContext {
  if (!entry.clientProjection?.overlayTable || !entry.clientProjection.journalTable) {
    throw new Error(`overlay and journal tables are required for writable table ${key}`);
  }

  const columns = getProjectedTableColumns(entry).map(({ propertyKey, column }) => ({
    propertyKey,
    column,
  }));

  const pkPropertyKeys = entry.primaryKey.columns.map((columnName) => {
    const column = columns.find((candidate) => candidate.column.name === columnName);

    if (!column) {
      throw new Error(`Primary key column ${columnName} was not found on table ${key}`);
    }

    return column.propertyKey;
  });

  const serverVersionColumnName = resolveServerVersionColumnName(entry) ?? null;
  const serverVersionPropertyKey = serverVersionColumnName
    ? (columns.find((candidate) => candidate.column.name === serverVersionColumnName)?.propertyKey ?? null)
    : null;

  // Resolve the `nowMicroseconds` managed fields generically from governance, not by property name.
  // `field.column` is the canonical drizzle property key (registry validation rejects a column-name
  // declaration — ADR-0012), so match on the property key alone.
  const resolveManagedPropertyKey = (fieldColumn: string): string | undefined =>
    columns.find((candidate) => candidate.propertyKey === fieldColumn)?.propertyKey;
  const nowMicrosecondsManagedFields = (entry.governance?.managedFields ?? []).filter(
    (field) => field.strategy === "nowMicroseconds",
  );
  const managedNowMicrosecondsPropertyKeys = nowMicrosecondsManagedFields
    .map((field) => resolveManagedPropertyKey(field.column as string))
    .filter((propertyKey): propertyKey is string => propertyKey !== undefined);
  const updateManagedNowMicrosecondsPropertyKeys = nowMicrosecondsManagedFields
    .filter((field) => field.applyOn.includes("update"))
    .map((field) => resolveManagedPropertyKey(field.column as string))
    .filter((propertyKey): propertyKey is string => propertyKey !== undefined);

  const managedAuthClaimCreateFields = (entry.governance?.managedFields ?? [])
    .filter((field) => field.strategy === "authClaim" && field.applyOn.includes("create"))
    .flatMap((field) => {
      const propertyKey = resolveManagedPropertyKey(field.column as string);
      return propertyKey && field.claimPath ? [{ propertyKey, claimPath: field.claimPath }] : [];
    });

  // The generated local relations as runtime Drizzle objects (memoized per registry+key in
  // local-tables.ts), plus name-resolved column handles the statement authors below need:
  // overlay/synced columns are keyed by PROPERTY key, so PK columns (a DB-column-name concept,
  // ADR-0012) are resolved once here by matching `.name`.
  const tables = {
    synced: getSyncedLocalTable(registry, key as string & keyof TRegistry),
    overlay: getOverlayTable(registry, key as string & keyof TRegistry),
    journal: getJournalTable(registry, key as string & keyof TRegistry),
  };
  const overlayColumnsByPropertyKey = getColumns(tables.overlay) as Record<string, PgColumn>;
  const syncedColumnsByPropertyKey = getColumns(tables.synced) as Record<string, PgColumn>;
  const resolvePkColumns = (columnsByKey: Record<string, PgColumn>, relation: string) =>
    entry.primaryKey.columns.map((columnName) => {
      const column = Object.values(columnsByKey).find((candidate) => candidate.name === columnName);
      if (!column) {
        throw new Error(`Primary key column ${columnName} was not found on the ${relation} table for ${key}`);
      }
      return column;
    });
  const syncedServerVersionColumn = serverVersionColumnName
    ? (Object.values(syncedColumnsByPropertyKey).find((candidate) => candidate.name === serverVersionColumnName) ??
      null)
    : null;

  return {
    key,
    entry,
    readModel: qualifyLocalIdentifier(
      localSchema,
      entry.view != null
        ? getViewConfig(entry.view).name
        : (entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name),
    ),
    syncedTable: qualifyLocalIdentifier(
      localSchema,
      entry.clientProjection?.syncedTable ?? getTableConfig(entry.table).name,
    ),
    overlayTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.overlayTable),
    journalTable: qualifyLocalIdentifier(localSchema, entry.clientProjection.journalTable),
    journalSequence: qualifyLocalIdentifier(localSchema, buildJournalSequenceName(entry.clientProjection.journalTable)),
    pkColumnNames: [...entry.primaryKey.columns],
    pkPropertyKeys,
    serverVersionColumnName,
    serverVersionPropertyKey,
    managedNowMicrosecondsPropertyKeys,
    updateManagedNowMicrosecondsPropertyKeys,
    managedAuthClaimCreateFields,
    recordIncludesOverlayState: "overlayTable" in (entry.clientProjection ?? {}),
    columns,
    tables,
    overlayColumnsByPropertyKey,
    syncedColumnsByPropertyKey,
    overlayPkColumns: resolvePkColumns(overlayColumnsByPropertyKey, "overlay"),
    syncedPkColumns: resolvePkColumns(syncedColumnsByPropertyKey, "synced"),
    syncedServerVersionColumn,
  };
}

function filterContexts<TRegistry extends SyncTableRegistry>(
  contexts: Partial<Record<SyncTableName<TRegistry>, TableContext>>,
  table?: SyncTableName<TRegistry>,
) {
  if (table) {
    const context = contexts[table];
    return context ? [context] : [];
  }

  return Object.values(contexts).filter((context): context is TableContext => context !== undefined);
}

/**
 * Materialise a column's default into a concrete JS value for the optimistic overlay
 * row. The overlay INSERT writes an explicit value for every projected column (an
 * omitted column becomes a literal `NULL`, which overrides any table-level DEFAULT), so
 * a column declared `NOT NULL DEFAULT <x>` that the caller omits would violate the
 * overlay's NOT NULL constraint unless we fill the default here — mirroring what the
 * authoritative server applies on the base table.
 *
 * Only values we can produce client-side are materialised: a value-returning `defaultFn`
 * (e.g. `$defaultFn`) or a literal `.default(value)`. SQL-expression defaults
 * (`.default(sql\`…\`)`, `defaultRandom()`, `defaultNow()`) cannot be evaluated without
 * the database, so they are left to the server (the column is then expected to be either
 * caller-supplied or nullable in the optimistic row).
 */
function materializeColumnDefault(column: TableContext["columns"][number]["column"]): {
  ok: boolean;
  value?: unknown;
} {
  if (!column.hasDefault) {
    return { ok: false };
  }

  if (typeof column.defaultFn === "function") {
    const produced = column.defaultFn();
    return is(produced, SQL) ? { ok: false } : { ok: true, value: produced };
  }

  if (column.default !== undefined && !is(column.default, SQL)) {
    return { ok: true, value: column.default };
  }

  return { ok: false };
}

function createOptimisticRecordFromContext<TCreate, TRecord>(
  context: TableContext,
  input: TCreate,
  claims?: Record<string, unknown>,
): TRecord {
  const record = {
    ...(isRecord(input) ? input : {}),
  };
  const nowUs = nowMicroseconds();

  // Stamp `authClaim` create-managed fields (owner/author/created_by) from the decoded claim at the
  // field's path, so the optimistic overlay row is attributed locally and satisfies the column's NOT
  // NULL — the server independently stamps the same claim on apply, so the value never flips on
  // convergence. (`auth.uid()` is just `claimPath: ["sub"]`.)
  if (claims != null) {
    for (const { propertyKey, claimPath } of context.managedAuthClaimCreateFields) {
      if (record[propertyKey] === undefined) {
        const value = readJwtClaimPath(claims, claimPath);
        if (value !== undefined) {
          record[propertyKey] = value;
        }
      }
    }
  }

  // Conventional audit-timestamp fill — distinct from the governance-driven fill below, not redundant
  // with it. The `createdAtUs`/`updatedAtUs` columns are conventionally NOT NULL with a SQL-expression
  // default (`pgxsinkit_clock_us()`, ADR-0004) the client cannot evaluate: `materializeColumnDefault`
  // leaves an unmaterialisable SQL default undefined, and the overlay INSERT then writes an explicit NULL
  // (overriding the table DEFAULT), violating the NOT NULL. This stamps them BY NAME regardless of
  // governance, so a table carrying `created_at_us` WITHOUT declaring it a `nowMicroseconds` managed field
  // (e.g. the `projects` fixture, whose only managed field is `updated_at_us`) still gets a valid
  // optimistic timestamp. The governance-driven fill below stamps only DECLARED managed fields, so it
  // cannot cover an undeclared-but-present conventional column — the two paths are complementary.
  if (hasProperty(context, "createdAtUs") && record["createdAtUs"] === undefined) {
    record["createdAtUs"] = nowUs;
  }

  if (hasProperty(context, "updatedAtUs") && record["updatedAtUs"] === undefined) {
    record["updatedAtUs"] = nowUs;
  }

  // Governance-driven managed-timestamp fill: stamp every `nowMicroseconds` managed field the convention
  // above did not reach — a Server version column not named `updated_at_us` (ADR-0010), or any
  // custom-named nowMicroseconds field. Idempotent with the convention fill (a conventionally-named
  // managed field is already stamped, so the `undefined` guard skips the re-stamp).
  for (const propertyKey of context.managedNowMicrosecondsPropertyKeys) {
    if (record[propertyKey] === undefined) {
      record[propertyKey] = nowUs;
    }
  }

  for (const { propertyKey, column } of context.columns) {
    if (record[propertyKey] !== undefined) {
      continue;
    }

    const materialized = materializeColumnDefault(column);
    if (materialized.ok) {
      record[propertyKey] = materialized.value;
    }
  }

  return buildOptimisticRecord(context, record, {
    overlayKind: "pending_create",
    localUpdatedAtUs: nowUs,
  }) as TRecord;
}

/**
 * Stamp every on-update `nowMicroseconds` managed field with `nowUs` (governance-driven, ADR-0004),
 * keyed by drizzle property key. For a convention table this is exactly `{ updatedAtUs: nowUs }`; for
 * a custom-named Server version it targets that column — so the local optimistic path never assumes
 * the demo naming the generic server applier does not.
 */
function buildUpdateManagedNowStamp(context: TableContext, nowUs: string): Record<string, string> {
  return Object.fromEntries(
    context.updateManagedNowMicrosecondsPropertyKeys.map((propertyKey) => [propertyKey, nowUs]),
  );
}

function buildOptimisticRecord(
  context: TableContext,
  record: Record<string, unknown>,
  options: {
    overlayKind: string;
    localUpdatedAtUs: string;
  },
) {
  if (!context.recordIncludesOverlayState) {
    return record;
  }

  return {
    ...record,
    overlayKind: options.overlayKind,
    localUpdatedAtUs: options.localUpdatedAtUs,
  };
}

function buildEntityKeyFromRecord(context: TableContext, record: unknown) {
  const recordObject = ensureRecord(record);
  return normalizeEntityKey(
    context,
    Object.fromEntries(context.pkPropertyKeys.map((propertyKey) => [propertyKey, String(recordObject[propertyKey])])),
  );
}

function normalizeEntityKey(context: TableContext, input: Record<string, string>) {
  // The public API accepts the identity by drizzle property name (ergonomics); past this
  // boundary the canonical Entity identity is column-keyed (ADR-0012), matching the
  // journal/overlay PK columns, entity_key_json, and the applier's `v_entity_key->>'<column>'`.
  // pkPropertyKeys[i] ↔ pkColumnNames[i] by construction (buildTableContext), so we map once here.
  return Object.fromEntries(
    context.pkPropertyKeys.map((propertyKey, index) => {
      const value = input[propertyKey];

      if (value === undefined) {
        throw new Error(`Missing entity key property ${propertyKey} for table ${context.key}`);
      }

      return [context.pkColumnNames[index]!, String(value)];
    }),
  );
}

function serializeEntityKey(entityKey: Record<string, string>) {
  return JSON.stringify(entityKey);
}

function dedupeBatchEntities(items: ReadonlyArray<NormalizedBatchItem>): BatchEntityRef[] {
  const entities = new Map<string, BatchEntityRef>();

  for (const item of items) {
    if (!entities.has(item.entityKeyJson)) {
      entities.set(item.entityKeyJson, {
        entityKey: item.entityKey,
        entityKeyJson: item.entityKeyJson,
      });
    }
  }

  return [...entities.values()];
}

async function readLatestMutationStates(
  db: MutationDb,
  context: TableContext,
  entities: ReadonlyArray<BatchEntityRef>,
) {
  if (entities.length === 0) {
    return new Map<string, BatchLatestMutationStateRow>();
  }

  // The old VALUES-CTE + LEFT-JOIN-back-to-input existed only to emit null rows for entities with
  // no journal history; the caller reads via `map.get(...) ?? null`, so a missing key is equivalent.
  const journal = context.tables.journal;
  const query = queryBuilder
    .selectDistinctOn([journal.entityKeyJson], {
      entityKeyJson: sql<string>`${journal.entityKeyJson}`.as("entityKeyJson"),
      latestMutationSeq: sql<number>`${journal.mutationSeq}`.as("latestMutationSeq"),
      latestMutationKind: sql<MutationKind>`${journal.mutationKind}`.as("latestMutationKind"),
      latestMutationStatus: sql<MutationStatus>`${journal.status}`.as("latestMutationStatus"),
    })
    .from(journal)
    .where(
      inArray(
        journal.entityKeyJson,
        entities.map((entity) => entity.entityKeyJson),
      ),
    )
    .orderBy(journal.entityKeyJson, desc(journal.mutationSeq))
    .toSQL();
  const result = await db.query<BatchLatestMutationStateRow>(query.sql, query.params as unknown[]);

  return new Map(result.rows.map((row) => [row.entityKeyJson, row]));
}

async function readCurrentRecordStates(db: MutationDb, context: TableContext, entities: ReadonlyArray<BatchEntityRef>) {
  if (entities.length === 0) {
    return new Map<string, BatchCurrentRecordStateRow>();
  }

  // Tier ②: the overlay-∪-synced shape over an input VALUES table. The input CTE carries each
  // entity's `entity_key_json` alongside its PK values (the caller maps rows back by that JSON), so
  // it cannot be a plain builder select; every identifier still comes from the table objects /
  // `sql.identifier`, and every value is a bound (cast-typed) param.
  const overlay = context.tables.overlay;
  const synced = context.tables.synced;
  const inputCte = buildEntityInputCte(context, entities);
  const overlaySelectColumns = buildProjectedSelectColumns(context, context.overlayColumnsByPropertyKey);
  const syncedSelectColumns = buildProjectedSelectColumns(context, context.syncedColumnsByPropertyKey);
  const inputOverlayJoin = buildEntityInputJoin(context.pkColumnNames, context.overlayPkColumns);
  const inputSyncedJoin = buildEntityInputJoin(context.pkColumnNames, context.syncedPkColumns);
  const syncedUpdatedAtColumn = context.syncedColumnsByPropertyKey["updatedAtUs"];
  const syncedLocalUpdated =
    hasProperty(context, "updatedAtUs") && syncedUpdatedAtColumn
      ? sql`${syncedUpdatedAtColumn}::text AS "localUpdatedAtUs"`
      : sql`'0' AS "localUpdatedAtUs"`;

  const query = queryDialect.sqlToQuery(sql`
      WITH ${inputCte},
      overlay_rows AS (
        SELECT
          input.entity_key_json AS "entityKeyJson",
          ${overlaySelectColumns},
          ${overlay.overlayKind} AS "overlayKind",
          ${overlay.localUpdatedAtUs}::text AS "localUpdatedAtUs"
        FROM input_entities AS input
        JOIN ${overlay}
          ON ${inputOverlayJoin}
      ),
      synced_rows AS (
        SELECT
          input.entity_key_json AS "entityKeyJson",
          ${syncedSelectColumns},
          ${"synced"} AS "overlayKind",
          ${syncedLocalUpdated}
        FROM input_entities AS input
        JOIN ${synced}
          ON ${inputSyncedJoin}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${overlay}
          WHERE ${inputOverlayJoin}
        )
      )
      SELECT *
      FROM overlay_rows
      UNION ALL
      SELECT *
      FROM synced_rows
    `);
  const result = await db.query<BatchCurrentRecordStateRow>(query.sql, query.params as unknown[]);

  return new Map(result.rows.map((row) => [row.entityKeyJson, row]));
}

async function insertMutationsBulk(
  db: MutationDb,
  context: TableContext,
  rows: ReadonlyArray<PlannedMutationInsert>,
  registryVersion: string,
  unit?: WriteUnit,
) {
  if (rows.length === 0) {
    return;
  }

  // ADR-0022: a dynamic write-unit tags every row of the batch with one shared unit id + mode; the
  // default path leaves both NULL (the flusher derives mode/unit from the static group). A blind row
  // carries its own `write_mode` override (`pessimistic-blind`), so the mode is resolved per row.
  const writeUnit = unit?.id ?? null;
  const journal = context.tables.journal;
  // `mutationSeq` is intentionally omitted: the generated journal DDL carries
  // `mutation_seq ... DEFAULT nextval(<journal sequence>)`, so the DB default assigns it — drizzle
  // renders `default` for every column a row does not provide.
  const values = rows.map((row) => ({
    mutationId: row.mutationId,
    ...Object.fromEntries(context.pkColumnNames.map((columnName) => [columnName, row.entityKey[columnName]])),
    entityKeyJson: row.entityKeyJson,
    mutationKind: row.mutationKind,
    status: "pending",
    registryVersion,
    baseServerVersion: row.baseServerVersion,
    payloadJson: row.payloadJson,
    enqueuedAtUs: row.nowUs,
    nextRetryAtUs: row.nowUs,
    updatedAtUs: row.nowUs,
    writeUnit,
    writeMode: row.writeMode ?? unit?.mode ?? null,
  }));

  const query = queryBuilder
    .insert(journal)
    .values(values as PgInsertValue<JournalTable>[])
    .toSQL();
  await db.query(query.sql, query.params as unknown[]);

  // Lifecycle origin: the moment each mutation is first staged into the journal. Correlates by id with
  // the later "board-write sending"/"board-write acks" lines (staged → sent → acked, per id).
  for (const row of rows) {
    syncDebug("mutation staged", { mutationId: row.mutationId, table: context.key });
  }
}

async function upsertOverlayRecordsBulk(
  db: MutationDb,
  context: TableContext,
  rows: ReadonlyArray<PlannedOverlayUpsert>,
) {
  if (rows.length === 0) {
    return;
  }

  const overlay = context.tables.overlay;
  const values = rows.map((row) => ({
    ...Object.fromEntries(context.columns.map(({ propertyKey }) => [propertyKey, row.record[propertyKey] ?? null])),
    overlayKind: row.overlayKind,
    localUpdatedAtUs: row.localUpdatedAtUs,
  }));
  // Every inserted column (the projection + the two overlay columns) takes its EXCLUDED value on
  // conflict — the fixed alias PostgreSQL defines for the proposed row; its column names are the
  // table's own, so they come from the column objects via `sql.identifier`.
  const excludedSet = Object.fromEntries([
    ...context.columns.map(({ propertyKey, column }) => [propertyKey, sql`excluded.${sql.identifier(column.name)}`]),
    ["overlayKind", sql`excluded.${sql.identifier(overlay.overlayKind.name)}`],
    ["localUpdatedAtUs", sql`excluded.${sql.identifier(overlay.localUpdatedAtUs.name)}`],
  ]) as Record<string, SQL>;

  const query = queryBuilder
    .insert(overlay)
    .values(values as PgInsertValue<OverlayTable>[])
    .onConflictDoUpdate({ target: context.overlayPkColumns, set: excludedSet })
    .toSQL();
  await db.query(query.sql, query.params as unknown[]);
}

/**
 * The batch-input CTE as a typed fragment: `input_entities (entity_key_json, <pks…>) AS (VALUES …)`
 * with every value a bound param, cast to its PK column's type (an untyped VALUES column would
 * otherwise default to text and break the join against a uuid/int PK).
 */
function buildEntityInputCte(context: TableContext, entities: ReadonlyArray<BatchEntityRef>): SQL {
  const columnNames = ["entity_key_json", ...context.pkColumnNames];
  const tuples = entities.map((entity) => {
    const values = [
      sql`${entity.entityKeyJson}`,
      ...context.pkColumnNames.map((columnName) => {
        const columnEntry = context.columns.find(({ column }) => column.name === columnName);
        const castSuffix = columnEntry ? resolveInputCastSuffix(columnEntry.column.columnType) : "";
        // The cast keyword is a FIXED type suffix selected from the closed switch below — never
        // derived from user data — so `sql.raw` is safe here; the value itself is a bound param.
        return castSuffix
          ? sql`${entity.entityKey[columnName]}${sql.raw(castSuffix)}`
          : sql`${entity.entityKey[columnName]}`;
      }),
    ];
    return sql`(${sql.join(values, sql`, `)})`;
  });

  return sql`input_entities (${sql.join(
    columnNames.map((columnName) => sql.identifier(columnName)),
    sql`, `,
  )}) AS (VALUES ${sql.join(tuples, sql`, `)})`;
}

function resolveInputCastSuffix(columnType: string): string {
  switch (columnType) {
    case "PgUUID":
      return "::uuid";
    case "PgBigInt64":
    case "PgBigInt53":
      return "::bigint";
    case "PgInteger":
    case "PgSerial":
    case "PgSmallInt":
      return "::int";
    case "PgBoolean":
      return "::boolean";
    case "PgTimestamp":
    case "PgTimestampString":
      return "::timestamp";
    default:
      return "";
  }
}

/**
 * The projected columns of one branch (overlay or synced) as select-list fragments, aliased to
 * their camelCase property keys — the raw seam returns rows unmapped, so the aliases ARE the row
 * keys — with `::text` casts on the bigint columns (matching how the runtime reads them).
 */
function buildProjectedSelectColumns(context: TableContext, columnsByPropertyKey: Record<string, PgColumn>): SQL {
  return sql.join(
    context.columns.map(({ propertyKey, column }) => {
      const target = columnsByPropertyKey[propertyKey];
      if (!target) {
        throw new Error(`Projected column ${propertyKey} was not found on the local tables for ${context.key}`);
      }
      if (column.columnType === "PgBigInt64" || column.columnType === "PgBigInt53") {
        return sql`${target}::text AS ${sql.identifier(propertyKey)}`;
      }
      return sql`${target} AS ${sql.identifier(propertyKey)}`;
    }),
    sql`, `,
  );
}

/** PK equality between a branch table's columns and the `input` CTE, as a typed fragment. */
function buildEntityInputJoin(pkColumnNames: string[], pkColumns: PgColumn[]): SQL {
  return sql.join(
    pkColumnNames.map((columnName, index) => sql`${pkColumns[index]!} = input.${sql.identifier(columnName)}`),
    sql` AND `,
  );
}

// ---------------------------------------------------------------------------
// Batch flush — sends one send-eligible slice of pending mutations across all
// target tables in a single POST /api/mutations call. The public flush()
// wrapper loops until no more eligible rows remain.
// ---------------------------------------------------------------------------

interface PendingBatchRow extends MutationRow {
  tableKey: string;
  enqueuedAtUs: string;
  /** The resolved Base server version (ADR-0015), or null for a create or blind write. */
  baseServerVersion: string | null;
}

interface PreparedBatchRow extends PendingBatchRow {
  context: TableContext;
  entityKey: Record<string, string>;
  envelopePayload: Record<string, unknown>;
  sqlTableName: string;
}

interface FlushBatchResult {
  processedCount: number;
  affectedContexts: TableContext[];
  /** Mutation ids that transitioned to `quarantined` in this slice (ADR-0006), for surfacing. */
  quarantinedMutationIds: string[];
  /** Mutation ids that transitioned to `conflicted` in this slice (ADR-0015), for surfacing. */
  conflictedMutationIds: string[];
}

/**
 * Runtime-scoped enter/exit seam for the in-flight mark-sending span counter (FIX 1). Threaded into
 * `applyMutationStatusUpdates` so the free function can bracket a `sending` transition against the runtime's
 * `settleRecoveryMarker`, which the free function cannot otherwise see. `enter` is called synchronously before
 * the marker await; `exit` in a `finally` after the `sending` UPDATE commits.
 */
interface MarkSendingScope {
  enter: () => void;
  exit: () => void;
}

interface MutationStatusUpdate {
  mutationId: string;
  status: MutationStatus;
  attemptCount: number;
  updatedAtUs: string;
  sentAtUs?: string | null;
  replaceSentAtUs?: boolean;
  ackedAtUs?: string | null;
  replaceAckedAtUs?: boolean;
  serverUpdatedAtUs?: string | null;
  replaceServerUpdatedAtUs?: boolean;
  baseServerVersion?: string | null;
  replaceBaseServerVersion?: boolean;
  lastError?: string | null;
  nextRetryAtUs?: string | null;
  lastHttpStatus?: number | null;
  conflictReason?: string | null;
}

/**
 * The resolved Base server version (ADR-0015) for a row at flush. A **chain head** already carries
 * `base_server_version` (stamped at enqueue), so COALESCE returns it untouched — keeping the
 * enqueue-time base means a genuine external write between view and apply is still caught. A
 * **chained** write has NULL there; it resolves to its **acked predecessor's** Server version (by
 * Per-entity flush serialization the predecessor is already acked when this row flushes), falling
 * back to the entity's current synced version once that predecessor has been reconciled away. Either
 * fallback yields the entity's own latest server state, so its own chain never self-conflicts.
 */
function buildResolvedBaseServerVersion(context: TableContext): SQL {
  const journal = context.tables.journal;
  const synced = context.tables.synced;
  const pred = alias(journal, "pred");
  const predecessor = queryBuilder
    .select({ value: sql`MAX(${pred.serverUpdatedAtUs})` })
    .from(pred)
    .where(
      and(
        eq(pred.entityKeyJson, journal.entityKeyJson),
        lt(pred.mutationSeq, journal.mutationSeq),
        eq(pred.status, "acked"),
      ),
    );

  if (!context.syncedServerVersionColumn) {
    return sql`COALESCE(${journal.baseServerVersion}, ${predecessor})::text`;
  }

  const syncedFallback = queryBuilder
    .select({ value: sql`${context.syncedServerVersionColumn}` })
    .from(synced)
    .where(
      and(
        ...context.pkColumnNames.map((columnName, index) => eq(context.syncedPkColumns[index]!, journal[columnName]!)),
      ),
    );

  return sql`COALESCE(${journal.baseServerVersion}, ${predecessor}, ${syncedFallback})::text`;
}

/**
 * One table's send-eligible journal rows as a builder select with the shared {@link PendingBatchRow}
 * projection — the aliases ARE the row keys (raw seam), `tableKey` rides as a bound param, and the
 * resolved Base server version (ADR-0015) is the typed COALESCE fragment above.
 */
function buildPendingRowsProjection(context: TableContext) {
  const journal = context.tables.journal;
  return {
    tableKey: sql<string>`${context.key}`.as("tableKey"),
    mutationId: sql<string>`${journal.mutationId}`.as("mutationId"),
    entityKeyJson: sql<string>`${journal.entityKeyJson}`.as("entityKeyJson"),
    mutationSeq: sql<number>`${journal.mutationSeq}`.as("mutationSeq"),
    mutationKind: sql<MutationKind>`${journal.mutationKind}`.as("mutationKind"),
    status: journal.status,
    payloadJson: sql<string>`${journal.payloadJson}`.as("payloadJson"),
    attemptCount: sql<number>`${journal.attemptCount}`.as("attemptCount"),
    lastHttpStatus: sql<number | null>`${journal.lastHttpStatus}`.as("lastHttpStatus"),
    lastError: sql<string | null>`${journal.lastError}`.as("lastError"),
    conflictReason: sql<string | null>`${journal.conflictReason}`.as("conflictReason"),
    nextRetryAtUs: sql<string | null>`${journal.nextRetryAtUs}::text`.as("nextRetryAtUs"),
    serverUpdatedAtUs: sql<string | null>`${journal.serverUpdatedAtUs}::text`.as("serverUpdatedAtUs"),
    baseServerVersion: buildResolvedBaseServerVersion(context).as("baseServerVersion"),
    enqueuedAtUs: sql<string>`${journal.enqueuedAtUs}::text`.as("enqueuedAtUs"),
  };
}

async function readPendingBatchRows(db: MutationDb, contexts: TableContext[], nowUs: string, batchSize: number) {
  if (contexts.length === 0) {
    return [] as PendingBatchRow[];
  }

  const branches = contexts.map((context) => {
    const journal = context.tables.journal;
    const earlier = alias(journal, "earlier");
    return queryBuilder
      .select(buildPendingRowsProjection(context))
      .from(journal)
      .where(
        and(
          inArray(journal.status, ["pending", "failed"]),
          // ADR-0022: pessimistic rows are flushed by the authoritative unit path (flushUnit), never the
          // optimistic batch — exclude them here so a tagged write is never optimistically sent. The
          // `NOT LIKE 'pessimistic%'` also excludes a `pessimistic-blind` row (ADR-0022 addendum), which
          // belongs to its unit's foreground flush too.
          sql`COALESCE(${journal.writeMode}, '') NOT LIKE 'pessimistic%'`,
          sql`COALESCE(${journal.nextRetryAtUs}, 0) <= ${nowUs}::bigint`,
          notExists(
            queryBuilder
              .select({ one: sql`1` })
              .from(earlier)
              .where(
                and(
                  eq(earlier.entityKeyJson, journal.entityKeyJson),
                  lt(earlier.mutationSeq, journal.mutationSeq),
                  // A still-unresolved earlier mutation blocks later same-entity ones so the
                  // server applies them in author order. The quarantined status is included: a
                  // later mutation must not flush past a prerequisite the server permanently
                  // rejected (it would itself fail); resolving the quarantine unblocks the queue.
                  inArray(earlier.status, ["pending", "failed", "sending", "quarantined"]),
                ),
              ),
          ),
        ),
      );
  });

  // The union rides inside a derived table because the outer ORDER BY casts the (text) output
  // columns — a set operation's own ORDER BY may only name plain output columns. The `pending`
  // alias and its two quoted output-column names are fixed by the projection above, not data.
  const query = queryDialect.sqlToQuery(
    sql`SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS pending ORDER BY pending."enqueuedAtUs"::bigint ASC, pending."mutationSeq" ASC LIMIT ${batchSize}`,
  );
  const result = await db.query<PendingBatchRow>(query.sql, query.params as unknown[]);

  return result.rows;
}

/**
 * Read one pessimistic write-unit's send-eligible rows (ADR-0022) across every table, ordered by author
 * sequence. Unlike {@link readPendingBatchRows} it has no per-entity ordering gate: a unit is enqueued and
 * sent atomically, so its members go together.
 */
async function readUnitPendingRows(
  db: MutationDb,
  contexts: TableContext[],
  unitId: string,
): Promise<PendingBatchRow[]> {
  if (contexts.length === 0) {
    return [];
  }

  const branches = contexts.map((context) => {
    const journal = context.tables.journal;
    return queryBuilder
      .select(buildPendingRowsProjection(context))
      .from(journal)
      .where(and(eq(journal.writeUnit, unitId), inArray(journal.status, ["pending", "failed"])));
  });

  const query = queryDialect.sqlToQuery(
    sql`SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS unit ORDER BY unit."mutationSeq" ASC`,
  );
  const result = await db.query<PendingBatchRow>(query.sql, query.params as unknown[]);

  return result.rows;
}

// Race a promise against an AbortSignal so a disposed runtime's teardown never parks on it (mirrors
// createMutationRuntime's untilAborted; used by the module-level flushBatch). A missing signal is a passthrough.
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new DOMException("Mutation runtime disposed", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Mutation runtime disposed", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function flushBatch(
  db: MutationDb,
  tableContexts: Record<string, TableContext>,
  batchMutationUrl: string,
  maxAttempts: number,
  batchSize: number,
  tableFilter?: string,
  getAuthToken?: () => Promise<string | undefined>,
  requestHeaders?: Record<string, string>,
  ensureRecoveryMarker?: () => Promise<void>,
  markSendingScope?: MarkSendingScope,
  signal?: AbortSignal,
): Promise<FlushBatchResult> {
  const contexts = filterContexts(tableContexts, tableFilter);
  const nowUs = nowMicroseconds();
  const quarantinedMutationIds: string[] = [];
  const conflictedMutationIds: string[] = [];

  // Collect send-eligible mutations across all target tables.
  const pendingRows = await readPendingBatchRows(db, contexts, nowUs, batchSize);
  const pending: PreparedBatchRow[] = [];
  const pendingByTable = new Map<string, PreparedBatchRow[]>();

  for (const row of pendingRows) {
    const context = tableContexts[row.tableKey];

    if (!context) {
      continue;
    }

    const entityKey = JSON.parse(row.entityKeyJson) as Record<string, string>;
    const rawPayload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    const preparedRow: PreparedBatchRow = {
      ...row,
      context,
      entityKey,
      envelopePayload:
        row.mutationKind === "delete"
          ? entityKey
          : toSqlColumnPayload(
              context,
              stripManagedFields(
                context,
                (rawPayload["value"] ?? rawPayload["patch"] ?? rawPayload) as Record<string, unknown>,
                row.mutationKind as "create" | "update",
              ),
            ),
      sqlTableName: context.entry.shape?.tableName ?? context.key,
    };

    pending.push(preparedRow);

    const existingTableRows = pendingByTable.get(context.key);

    if (existingTableRows) {
      existingTableRows.push(preparedRow);
    } else {
      pendingByTable.set(context.key, [preparedRow]);
    }
  }

  if (pending.length === 0) {
    // If a write just enqueued and requested a pass, but this flush sees nothing, the pass raced the
    // journal commit (or everything is already in-flight/backed-off) — the write then waits for a
    // later pass. Worth seeing explicitly when chasing flush latency.
    syncDebug("flushBatch: no send-eligible mutations this pass");
    return {
      processedCount: 0,
      affectedContexts: [],
      quarantinedMutationIds,
      conflictedMutationIds,
    };
  }

  syncDebug("flushBatch sending to board-write", { count: pending.length });

  // Mark all as sending.
  const sentAtUs = nowMicroseconds();

  for (const rows of pendingByTable.values()) {
    await applyMutationStatusUpdates(
      db,
      rows[0]!.context,
      rows.map((row) => ({
        mutationId: row.mutationId,
        status: "sending",
        attemptCount: row.attemptCount + 1,
        updatedAtUs: sentAtUs,
        sentAtUs,
        replaceSentAtUs: true,
        // Persist the resolved Base server version (ADR-0015) so a chained write's flush-resolved
        // base is durable and matches exactly what the envelope carries to the server.
        baseServerVersion: row.baseServerVersion,
        replaceBaseServerVersion: true,
        lastError: null,
        nextRetryAtUs: null,
        lastHttpStatus: null,
        conflictReason: null,
      })),
      ensureRecoveryMarker,
      markSendingScope,
    );
  }

  const mutations = pending.map((row) => {
    return {
      tableName: row.sqlTableName,
      entityKey: row.entityKey,
      mutationId: row.mutationId,
      mutationSeq: row.mutationSeq,
      kind: row.mutationKind as "create" | "update" | "delete",
      payload: row.envelopePayload,
      clientTimestampUs: sentAtUs,
      // ADR-0015: carry the resolved Base server version so the applier can detect a stale write.
      // Omitted for a create or blind write (null) — then no stale check runs.
      ...(row.baseServerVersion != null ? { baseServerVersion: row.baseServerVersion } : {}),
    };
  });

  let responseOk = false;
  let acksByMutationId: Map<string, BatchMutationAck["acks"][number]> = new Map();
  try {
    // Resolve the auth token and the network round-trip separately: in the board, `getAuthToken` calls
    // `supabase.auth.getSession()` per send, which can itself stall (token refresh) and would otherwise
    // be invisibly folded into "the write was slow".
    const authStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    const authToken = await raceAbort(getAuthToken?.() ?? Promise.resolve(undefined), signal);
    const fetchStart = typeof performance !== "undefined" ? performance.now() : Date.now();
    syncDebug("board-write auth token resolved", { ms: Math.round(fetchStart - authStart) });

    let response = await fetch(batchMutationUrl, {
      method: "POST",
      headers: buildRequestHeaders(authToken, requestHeaders),
      body: jsonStringifyPayload({ mutations }),
      signal: signal ?? null,
    });

    if ([401, 403].includes(response.status) && getAuthToken) {
      response = await fetch(batchMutationUrl, {
        method: "POST",
        headers: buildRequestHeaders(await raceAbort(getAuthToken(), signal), requestHeaders),
        body: jsonStringifyPayload({ mutations }),
        signal: signal ?? null,
      });
    }

    const fetchEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
    syncDebug("board-write responded", { status: response.status, ms: Math.round(fetchEnd - fetchStart) });

    if (response.ok) {
      const responseJson = (await response.json()) as BatchMutationAck;
      responseOk = true;
      acksByMutationId = new Map(responseJson.acks.map((ack) => [ack.mutationId, ack]));
      syncDebug("board-write acks", {
        acks: responseJson.acks.map((ack) => `${ack.mutationId.slice(0, 8)}:${ack.status}`),
      });
    } else {
      const text = await response.text();
      throw new MutationRequestError(
        text.length > 0 ? text : `Bulk write responded with ${response.status}`,
        response.status,
        parseBatchRejections(text),
      );
    }
  } catch (error) {
    const failedAtUs = nowMicroseconds();
    const httpStatus = error instanceof MutationRequestError ? error.status : null;
    const errorMessage = error instanceof Error ? error.message : "Unknown batch write failure";
    // The server attributed the failure to specific mutations (a structural validation
    // rejection of an atomic batch). When present, we quarantine exactly those and leave the
    // innocent siblings immediately retryable; absent (transport / 5xx / auth / malformed
    // envelope), the whole batch stays retryable under the shared attempt cap.
    const rejectionById =
      error instanceof MutationRequestError && error.rejections
        ? new Map(error.rejections.map((rejection) => [rejection.mutationId, rejection]))
        : null;

    for (const rows of pendingByTable.values()) {
      await applyMutationStatusUpdates(
        db,
        rows[0]!.context,
        rows.map((row) => {
          const attemptCount = row.attemptCount + 1;

          if (rejectionById) {
            const rejection = rejectionById.get(row.mutationId);

            if (rejection) {
              // Named as the cause: terminal quarantine (it will never succeed unchanged).
              quarantinedMutationIds.push(row.mutationId);
              return {
                mutationId: row.mutationId,
                status: "quarantined" as const,
                attemptCount,
                updatedAtUs: failedAtUs,
                lastError: rejection.reason,
                nextRetryAtUs: null,
                lastHttpStatus: httpStatus,
                conflictReason: rejection.reason,
              };
            }

            // Innocent sibling: nothing was applied (atomic batch), so make it immediately
            // retryable — no backoff (the fault was the now-quarantined mutation, not
            // congestion) — and the next flush proceeds without the poison.
            return {
              mutationId: row.mutationId,
              status: "failed" as const,
              attemptCount,
              updatedAtUs: failedAtUs,
              lastError: "Batch rejected due to a sibling mutation; retrying without it",
              nextRetryAtUs: null,
              lastHttpStatus: httpStatus,
              conflictReason: null,
            };
          }

          // Unattributed batch-level failure: stays retryable with jittered backoff; only the
          // hard attempt cap escalates to terminal quarantined. A structural 4xx is NOT
          // quarantined here (a stray 404/413/malformed envelope would otherwise permanently
          // kill unrelated valid writes).
          const outcome = resolveBatchFailureOutcome(attemptCount, maxAttempts, failedAtUs);

          if (outcome.status === "quarantined") {
            quarantinedMutationIds.push(row.mutationId);
          }

          return {
            mutationId: row.mutationId,
            status: outcome.status,
            attemptCount,
            updatedAtUs: failedAtUs,
            lastError: errorMessage,
            nextRetryAtUs: outcome.nextRetryAtUs,
            lastHttpStatus: httpStatus,
            conflictReason: null,
          };
        }),
      );
    }

    return {
      processedCount: pending.length,
      affectedContexts: [...new Set(pending.map((row) => row.context))],
      quarantinedMutationIds,
      conflictedMutationIds,
    };
  }

  if (!responseOk) {
    return {
      processedCount: pending.length,
      affectedContexts: [...new Set(pending.map((row) => row.context))],
      quarantinedMutationIds,
      conflictedMutationIds,
    };
  }

  // Apply per-mutation ack results.
  const ackedAtUs = nowMicroseconds();
  const failedAtUs = nowMicroseconds();

  for (const rows of pendingByTable.values()) {
    await applyMutationStatusUpdates(
      db,
      rows[0]!.context,
      rows.map((row) => {
        const ack = acksByMutationId.get(row.mutationId);

        if (ack && ack.status === "conflicted") {
          // ADR-0015: a stale write the reject-if-stale policy declined. Move to the terminal
          // `conflicted` status — NOT a failure (never retried as-is, the base is still stale) — and
          // KEEP the optimistic Overlay (reconcile only clears acked rows, so the user's edit stays
          // visible). The server's current Server version rides on the journal row for the diff UI.
          conflictedMutationIds.push(row.mutationId);
          return {
            mutationId: row.mutationId,
            status: "conflicted" as const,
            attemptCount: row.attemptCount + 1,
            updatedAtUs: failedAtUs,
            serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
            replaceServerUpdatedAtUs: true,
            lastError: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
            nextRetryAtUs: null,
            lastHttpStatus: ack.httpStatus ?? 409,
            conflictReason: ack.conflictReason ?? "Stale write rejected (reject-if-stale)",
          };
        }

        if (!ack || ack.status !== "acked") {
          const attemptCount = row.attemptCount + 1;
          const httpStatus = ack?.httpStatus ?? null;
          const outcome = resolveFailureOutcome(httpStatus, attemptCount, maxAttempts, failedAtUs);

          if (outcome.status === "quarantined") {
            quarantinedMutationIds.push(row.mutationId);
          }

          return {
            mutationId: row.mutationId,
            status: outcome.status,
            attemptCount,
            updatedAtUs: failedAtUs,
            lastError: ack?.conflictReason ?? "Batch mutation not acknowledged",
            nextRetryAtUs: outcome.nextRetryAtUs,
            lastHttpStatus: httpStatus,
            conflictReason: ack?.conflictReason ?? null,
          };
        }

        if (row.mutationKind === "delete") {
          return {
            mutationId: row.mutationId,
            status: "acked",
            attemptCount: row.attemptCount + 1,
            updatedAtUs: ackedAtUs,
            ackedAtUs,
            replaceAckedAtUs: true,
            lastError: null,
            nextRetryAtUs: null,
            lastHttpStatus: 204,
            conflictReason: null,
          };
        }

        return {
          mutationId: row.mutationId,
          status: "acked",
          attemptCount: row.attemptCount + 1,
          updatedAtUs: ackedAtUs,
          ackedAtUs,
          replaceAckedAtUs: true,
          serverUpdatedAtUs: ack.serverUpdatedAtUs ?? null,
          replaceServerUpdatedAtUs: true,
          lastError: null,
          nextRetryAtUs: null,
          lastHttpStatus: 200,
          conflictReason: null,
        };
      }),
    );
  }

  return {
    processedCount: pending.length,
    affectedContexts: [...new Set(pending.map((row) => row.context))],
    quarantinedMutationIds,
    conflictedMutationIds,
  };
}

/**
 * Resolve a flush failure into the durable journal outcome (ADR-0006). A structural
 * rejection ({@link classifyFailureStatus}) or hitting the hard attempt cap ends the
 * retry loop with a terminal `quarantined` (no `next_retry_at_us`); otherwise the
 * mutation stays `failed` with a jittered backoff (ADR-0005 congestion policy).
 */
function resolveFailureOutcome(
  httpStatus: number | null,
  attemptCount: number,
  maxAttempts: number,
  failedAtUs: string,
): { status: "failed" | "quarantined"; nextRetryAtUs: string | null } {
  if (classifyFailureStatus(httpStatus) === "quarantined" || attemptCount >= maxAttempts) {
    return { status: "quarantined", nextRetryAtUs: null };
  }

  return { status: "failed", nextRetryAtUs: computeNextRetryAtUs(failedAtUs, attemptCount) };
}

/**
 * Resolve a *batch-level* failure — the whole POST failed (transport error, 5xx, auth, or a
 * non-2xx the server did not attribute to a specific mutation). Unlike a per-mutation ack
 * rejection, the fault cannot be pinned on any one mutation, so a structural 4xx must NOT
 * quarantine the batch (a stray 404/413/malformed envelope would permanently kill unrelated
 * valid offline writes). These failures stay retryable `failed` with jittered backoff; only
 * the hard attempt cap escalates to terminal `quarantined`.
 */
function resolveBatchFailureOutcome(
  attemptCount: number,
  maxAttempts: number,
  failedAtUs: string,
): { status: "failed" | "quarantined"; nextRetryAtUs: string | null } {
  if (attemptCount >= maxAttempts) {
    return { status: "quarantined", nextRetryAtUs: null };
  }

  return { status: "failed", nextRetryAtUs: computeNextRetryAtUs(failedAtUs, attemptCount) };
}

function invalidBatchWriteUrl(): Error {
  return new Error(
    '[pgxsinkit] batchWriteUrl must be "/api/mutations" or an absolute deployment URL ending in "/api/mutations"',
  );
}

function resolveMutationUrls(batchWriteUrl: string): { batch: string; authoritative: string } {
  if (batchWriteUrl.trim() !== batchWriteUrl || batchWriteUrl.length === 0) {
    throw invalidBatchWriteUrl();
  }

  const isRelative = batchWriteUrl.startsWith("/") && !batchWriteUrl.startsWith("//");
  let parsed: URL;
  try {
    parsed = isRelative ? new URL(batchWriteUrl, "https://pgxsinkit.invalid") : new URL(batchWriteUrl);
  } catch {
    throw invalidBatchWriteUrl();
  }

  const hasCanonicalPath = isRelative
    ? parsed.pathname === "/api/mutations"
    : ["http:", "https:"].includes(parsed.protocol) && parsed.pathname.endsWith("/api/mutations");
  if (!hasCanonicalPath || parsed.search !== "" || parsed.hash !== "") {
    throw invalidBatchWriteUrl();
  }

  return { batch: batchWriteUrl, authoritative: `${batchWriteUrl}/unit` };
}

function stripManagedFields(
  context: TableContext,
  payload: Record<string, unknown>,
  operation: "create" | "update",
): Record<string, unknown> {
  const managedColumns = new Set<string>();

  for (const mf of context.entry.governance?.managedFields ?? []) {
    if (mf.applyOn.includes(operation)) {
      managedColumns.add(mf.column);
    }
  }

  if (managedColumns.size === 0) return payload;

  return Object.fromEntries(Object.entries(payload).filter(([key]) => !managedColumns.has(key)));
}

function toSqlColumnPayload(context: TableContext, payload: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const { propertyKey, column } of context.columns) {
    const columnName = column.name;

    if (Object.prototype.hasOwnProperty.call(payload, columnName)) {
      normalized[columnName] = payload[columnName];
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(payload, propertyKey)) {
      normalized[columnName] = payload[propertyKey];
    }
  }

  return normalized;
}

/**
 * Discard a terminal-state entity: clear its journal rows in the given terminal status
 * (`conflicted` — ADR-0015; or `quarantined` — ADR-0006) and its kept optimistic Overlay row, so the
 * Read model falls back to the synced (server) value. The overlay is removed only when no OTHER journal
 * row still owes the entity (a pending/sending/failed/acked write), mirroring reconcileTable's
 * overlay-clear guard — so a discard never strips an overlay another un-resolved write still depends
 * on. Both public discards (`discardConflict`, `discardQuarantined`) are this one body parameterized by
 * the terminal status they retire; owning its own transaction (like reconcileTable), it is not wrapped.
 */
async function discardTerminalEntity(
  db: MutationDb,
  context: TableContext,
  entityKey: Record<string, string>,
  entityKeyJson: string,
  terminalStatus: "conflicted" | "quarantined",
) {
  await db.exec("BEGIN");

  try {
    const journal = context.tables.journal;
    const clearQuery = queryBuilder
      .delete(journal)
      .where(and(eq(journal.status, terminalStatus), eq(journal.entityKeyJson, entityKeyJson)))
      .toSQL();
    await db.query(clearQuery.sql, clearQuery.params as unknown[]);

    // Clear the kept overlay only when no journal row still owes this entity — so a discard never
    // strips an overlay another un-resolved write (e.g. a resolution already enqueued) depends on.
    const overlayQuery = buildOverlayDiscardQuery(context, entityKey, entityKeyJson);
    await db.query(overlayQuery.sql, overlayQuery.params as unknown[]);

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The shared overlay-discard statement: delete the entity's overlay row unless a journal row still
 * owes the entity — `owedStatuses` narrows which journal rows count as "owed" (all of them for a
 * conflict discard; only the un-sent pending/sending/failed set for a settled-unit discard).
 */
function buildOverlayDiscardQuery(
  context: TableContext,
  entityKey: Record<string, string>,
  entityKeyJson: string,
  owedStatuses?: MutationStatus[],
) {
  const overlay = context.tables.overlay;
  const journal = context.tables.journal;
  const owed = queryBuilder
    .select({ one: sql`1` })
    .from(journal)
    .where(
      owedStatuses
        ? and(eq(journal.entityKeyJson, entityKeyJson), inArray(journal.status, owedStatuses))
        : eq(journal.entityKeyJson, entityKeyJson),
    );

  return queryBuilder
    .delete(overlay)
    .where(
      and(
        ...context.pkColumnNames.map((columnName, index) =>
          eq(context.overlayPkColumns[index]!, entityKey[columnName]),
        ),
        notExists(owed),
      ),
    )
    .toSQL();
}

/**
 * Auto-discard the optimistic overlay for an entity whose pessimistic write-unit the authoritative endpoint
 * `rejected` (ADR-0022 §4). Unlike {@link discardTerminalEntity} this KEEPS the terminal `rejected` journal
 * row (for diagnostics + `onReject`); it only clears the overlay, and only when no still-owed
 * (`pending`/`sending`/`failed`) journal row depends on it — so a later un-sent write never loses its overlay.
 */
async function discardOverlayForSettledEntity(
  db: MutationDb,
  context: TableContext,
  entityKey: Record<string, string>,
  entityKeyJson: string,
) {
  const query = buildOverlayDiscardQuery(context, entityKey, entityKeyJson, ["pending", "sending", "failed"]);
  await db.query(query.sql, query.params as unknown[]);
}

async function reconcileTable(db: MutationDb, context: TableContext) {
  // Idle fast-path. Reconcile only retires/clears journal rows in a terminal-clearable state — 'acked'
  // (clear the overlay once the echo lands) or 'conflicted' (retire once a later write resolved it). When
  // none exist — the steady state of an idle entity set — all three statements below are no-ops, so skip
  // the whole transaction. This matters because the convergence driver runs reconcile for EVERY writable
  // table on its interval (default 1.5s), and each CTE pays full PGlite plan+execute cost even against an
  // empty journal: left unguarded it is the dominant idle-CPU cost. The real-time cleanup path is the
  // <table>_reconcile_on_sync trigger; this bulk pass is a fallback, so skipping it when there is nothing
  // to clear changes no outcome. The guard is a single existence probe over the (small, usually empty)
  // journal.
  const journal = context.tables.journal;
  const overlay = context.tables.overlay;
  const synced = context.tables.synced;
  // This is the idle-CPU hot statement (it runs for every writable table on every convergence
  // tick), so the rendered text+params are memoized per context — each tick pays only a plain
  // `db.query` of a cached string, and it stays OUTSIDE any transaction (no BEGIN on the idle path).
  let idleProbe = context.reconcileIdleProbe;
  if (!idleProbe) {
    const probeQuery = queryDialect.sqlToQuery(
      sql`SELECT ${exists(
        queryBuilder
          .select({ one: sql`1` })
          .from(journal)
          .where(inArray(journal.status, ["acked", "conflicted"])),
      )} AS "hasWork"`,
    );
    idleProbe = { sql: probeQuery.sql, params: probeQuery.params as unknown[] };
    context.reconcileIdleProbe = idleProbe;
  }
  const work = await db.query<{ hasWork: boolean }>(idleProbe.sql, idleProbe.params);
  if (work.rows[0]?.hasWork !== true) {
    return;
  }

  // The Convergence barrier (ADR-0010) gates the acked-row clearing below; the synced-table trigger
  // handles real-time cleanup, and this is the bulk recovery/fallback path that runs after every flush.
  await db.exec("BEGIN");

  try {
    // ADR-0015: retire a terminal `conflicted` row once the user has RESOLVED it — i.e. a LATER write
    // on the same entity has been acked (resolution is an ordinary new mutation). Without this, the old
    // conflicted row lingers forever: `<table>_sync_state.conflict_state` keeps surfacing the resolved
    // conflict and `diagnostics().conflictedCount` never drops. Run before the acked-clear below so the
    // resolving row is still present to supersede it. (`discardConflict` is the explicit throw-away path.)
    // Drizzle DELETE has no USING; the resolver leg is the equivalent EXISTS semi-join.
    const resolver = alias(journal, "resolver");
    const retireQuery = queryBuilder
      .delete(journal)
      .where(
        and(
          eq(journal.status, "conflicted"),
          exists(
            queryBuilder
              .select({ one: sql`1` })
              .from(resolver)
              .where(
                and(
                  eq(resolver.entityKeyJson, journal.entityKeyJson),
                  gt(resolver.mutationSeq, journal.mutationSeq),
                  eq(resolver.status, "acked"),
                ),
              ),
          ),
        ),
      )
      .toSQL();
    await db.query(retireQuery.sql, retireQuery.params as unknown[]);

    // ADR-0022 addendum — retire an acked `pessimistic-blind` row with NO echo barrier. A blind update's
    // write target is excluded from this actor's read shape, so no synced echo will ever land for it and no
    // overlay was ever planned: the standard acked-clear below (gated on a synced row reaching the acked
    // version) would keep it forever. Nothing local converges for these rows, so once the authoritative unit
    // acked them there is nothing left to do but drop the journal row. Crash-safe: any later reconcile tick
    // clears a blind row the foreground flushUnit didn't survive to reconcile.
    const blindRetireQuery = queryBuilder
      .delete(journal)
      .where(and(eq(journal.status, "acked"), eq(journal.writeMode, "pessimistic-blind")))
      .toSQL();
    await db.query(blindRetireQuery.sql, blindRetireQuery.params as unknown[]);

    // Clear acknowledged non-delete mutations + matching overlays. ADR-0010: gated by the
    // Convergence barrier (same predicate as the trigger) — the acked write clears only once the
    // synced echo's Server version has reached its acked version. Joining the synced table makes
    // the comparison possible (and means an un-synced acked write is held until its echo lands).
    // Drizzle authoring: DELETE..USING becomes the equivalent EXISTS semi-join, chained through a
    // data-modifying CTE (both sub-statements see the same statement-start snapshot, exactly like
    // the USING form). The barrier predicate stays the shared contracts helper (single authority
    // with the trigger); it renders against the tables' own names, which is how drizzle references
    // their columns here (no aliases on a DELETE target).
    const barrier = sql.raw(
      buildOverlayResolutionBarrier(context.entry, {
        journalAlias: quoteIdentifier(getTableConfig(journal).name),
        syncedAlias: quoteIdentifier(getTableConfig(synced).name),
      }),
    );
    const clearedJournal = queryBuilder.$with("cleared_journal").as(
      queryBuilder
        .delete(journal)
        .where(
          and(
            eq(journal.status, "acked"),
            isNotNull(journal.serverUpdatedAtUs),
            ne(journal.mutationKind, "delete"),
            exists(
              queryBuilder
                .select({ one: sql`1` })
                .from(synced)
                .where(
                  and(
                    ...context.pkColumnNames.map((columnName, index) =>
                      eq(context.syncedPkColumns[index]!, journal[columnName]!),
                    ),
                    barrier,
                  ),
                ),
            ),
          ),
        )
        .returning(
          Object.fromEntries([
            ["entity_key_json", journal.entityKeyJson],
            ...context.pkColumnNames.map((columnName) => [columnName, journal[columnName]!]),
          ]),
        ),
    );
    const clearedJournalColumns = clearedJournal as unknown as Record<string, PgColumn>;
    const ackedClearQuery = queryBuilder
      .with(clearedJournal)
      .delete(overlay)
      .where(
        exists(
          queryBuilder
            .select({ one: sql`1` })
            .from(clearedJournal)
            .where(
              and(
                ...context.pkColumnNames.map((columnName, index) =>
                  eq(context.overlayPkColumns[index]!, clearedJournalColumns[columnName]!),
                ),
                notExists(
                  queryBuilder
                    .select({ one: sql`1` })
                    .from(journal)
                    .where(
                      and(
                        eq(journal.entityKeyJson, clearedJournalColumns["entity_key_json"]!),
                        inArray(journal.status, ["pending", "sending", "failed"]),
                      ),
                    ),
                ),
              ),
            ),
        ),
      )
      .toSQL();
    await db.query(ackedClearQuery.sql, ackedClearQuery.params as unknown[]);

    // Clear acknowledged delete mutations where synced row is absent
    // Single compound CTE — PGlite does not support multi-statement query().
    const clearableEntities = queryBuilder.$with("clearable_entities").as(
      queryBuilder
        .selectDistinct(
          Object.fromEntries([
            ["entity_key_json", journal.entityKeyJson],
            ...context.pkColumnNames.map((columnName) => [columnName, journal[columnName]!]),
          ]),
        )
        .from(journal)
        .leftJoin(
          synced,
          and(
            ...context.pkColumnNames.map((columnName, index) =>
              eq(context.syncedPkColumns[index]!, journal[columnName]!),
            ),
          ),
        )
        .where(
          and(eq(journal.status, "acked"), eq(journal.mutationKind, "delete"), isNull(context.syncedPkColumns[0]!)),
        ),
    );
    const clearableEntityColumns = clearableEntities as unknown as Record<string, PgColumn>;
    const deletedOverlay = queryBuilder.$with("deleted_overlay").as(
      queryBuilder.delete(overlay).where(
        exists(
          queryBuilder
            .select({ one: sql`1` })
            .from(clearableEntities)
            .where(
              and(
                ...context.pkColumnNames.map((columnName, index) =>
                  eq(context.overlayPkColumns[index]!, clearableEntityColumns[columnName]!),
                ),
              ),
            ),
        ),
      ),
    );
    const deleteClearQuery = queryBuilder
      .with(clearableEntities, deletedOverlay)
      .delete(journal)
      .where(
        and(
          eq(journal.status, "acked"),
          eq(journal.mutationKind, "delete"),
          exists(
            queryBuilder
              .select({ one: sql`1` })
              .from(clearableEntities)
              .where(
                and(
                  ...context.pkColumnNames.map((columnName) =>
                    eq(journal[columnName]!, clearableEntityColumns[columnName]!),
                  ),
                ),
              ),
          ),
        ),
      )
      .toSQL();
    await db.query(deleteClearQuery.sql, deleteClearQuery.params as unknown[]);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

function buildRequestHeaders(bearerToken?: string, requestHeaders?: Record<string, string>): Record<string, string> {
  // Static headers first so the toolkit-owned Content-Type/Authorization always win.
  return {
    ...(requestHeaders ?? {}),
    "Content-Type": "application/json",
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
  };
}

async function applyMutationStatusUpdates(
  db: MutationDb,
  context: TableContext,
  updates: MutationStatusUpdate[],
  onBeforeMarkSending?: () => Promise<void>,
  markSendingScope?: MarkSendingScope,
) {
  if (updates.length === 0) {
    return;
  }

  // Marker-first choke point (slice 2): this is the ONE code path every pending→sending transition flows
  // through (optimistic `flushBatch` + pessimistic `flushUnit`). When any update targets `sending`, commit
  // the durable recovery-required marker BEFORE the transition's UPDATE executes, so a committed `sending`
  // row can never coexist with a `false` marker. Non-`sending` transitions (ack/fail/quarantine) never fire it.
  const marksSending = updates.some((update) => update.status === "sending");
  // FIX 1: open the in-flight mark-sending span SYNCHRONOUSLY (before the marker await below), so a concurrent
  // `settleRecoveryMarker` cannot clear the marker between this call's marker decision and its committed
  // `sending` UPDATE. Closed in the `finally` once the UPDATE has committed.
  if (marksSending) markSendingScope?.enter();
  try {
    if (onBeforeMarkSending && marksSending) {
      await onBeforeMarkSending();
    }
    await execMutationStatusUpdates(db, context, updates);
  } finally {
    if (marksSending) markSendingScope?.exit();
  }
}

/** The bare status-update UPDATE (no marker/counter concerns) — split so `applyMutationStatusUpdates` can
 * bracket it with the mark-sending span in a `finally` (FIX 1). */
async function execMutationStatusUpdates(db: MutationDb, context: TableContext, updates: MutationStatusUpdate[]) {
  // Tier ②: `update().from(<VALUES>)`. Every value is a bound param with the same cast as before;
  // the `updates` alias and its column list are fixed by this function (not derived from data), so
  // the alias-qualified references in SET/WHERE are fixed template text, while the journal side of
  // each CASE interpolates the column objects.
  const journal = context.tables.journal;
  const tuples = updates.map(
    (update) =>
      sql`(${update.mutationId}, ${update.status}, ${update.attemptCount}::int, ${update.updatedAtUs}::bigint, ${
        update.sentAtUs ?? null
      }::bigint, ${update.replaceSentAtUs ?? false}::boolean, ${update.ackedAtUs ?? null}::bigint, ${
        update.replaceAckedAtUs ?? false
      }::boolean, ${update.serverUpdatedAtUs ?? null}::bigint, ${update.replaceServerUpdatedAtUs ?? false}::boolean, ${
        update.baseServerVersion ?? null
      }::bigint, ${update.replaceBaseServerVersion ?? false}::boolean, ${update.lastError ?? null}, ${
        update.nextRetryAtUs ?? null
      }::bigint, ${update.lastHttpStatus ?? null}::int, ${update.conflictReason ?? null})`,
  );
  const updatesTable = sql`(VALUES ${sql.join(
    tuples,
    sql`, `,
  )}) AS updates (mutation_id, status, attempt_count, updated_at_us, sent_at_us, replace_sent_at_us, acked_at_us, replace_acked_at_us, server_updated_at_us, replace_server_updated_at_us, base_server_version, replace_base_server_version, last_error, next_retry_at_us, last_http_status, conflict_reason)`;

  const query = queryBuilder
    .update(journal)
    .set({
      status: sql`updates.status`,
      attemptCount: sql`updates.attempt_count`,
      updatedAtUs: sql`updates.updated_at_us::bigint`,
      sentAtUs: sql`CASE WHEN updates.replace_sent_at_us THEN updates.sent_at_us::bigint ELSE ${journal.sentAtUs} END`,
      ackedAtUs: sql`CASE WHEN updates.replace_acked_at_us THEN updates.acked_at_us::bigint ELSE ${journal.ackedAtUs} END`,
      serverUpdatedAtUs: sql`CASE WHEN updates.replace_server_updated_at_us THEN updates.server_updated_at_us::bigint ELSE ${journal.serverUpdatedAtUs} END`,
      baseServerVersion: sql`CASE WHEN updates.replace_base_server_version THEN updates.base_server_version::bigint ELSE ${journal.baseServerVersion} END`,
      lastError: sql`updates.last_error`,
      nextRetryAtUs: sql`updates.next_retry_at_us::bigint`,
      lastHttpStatus: sql`updates.last_http_status`,
      conflictReason: sql`updates.conflict_reason`,
    })
    .from(updatesTable)
    .where(eq(journal.mutationId, sql`updates.mutation_id::uuid`))
    .toSQL();
  await db.query(query.sql, query.params as unknown[]);
}

function qualifyLocalIdentifier(schemaName: string, tableName: string) {
  if (schemaName === "public") {
    // Quote-when-needed: a reserved-word or mixed-case table name (e.g. `group`)
    // MUST be quoted or the generated SQL fails to parse (ADR-0004). Normal names
    // stay bare, so existing generated SQL is unchanged.
    return maybeQuoteIdentifier(tableName);
  }

  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
}

function buildJournalSequenceName(journalTable: string) {
  return `${journalTable}_mutation_seq`;
}

function hasProperty(context: TableContext, propertyKey: string) {
  return context.columns.some((column) => column.propertyKey === propertyKey);
}

function ensureRecord(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("Mutation runtime expected a record payload");
  }

  return value;
}

function extractRecordFromState(context: TableContext, state: CurrentRecordStateRow | BatchCurrentRecordStateRow) {
  return Object.fromEntries(context.columns.map(({ propertyKey }) => [propertyKey, state[propertyKey] ?? null]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class MutationRequestError extends Error {
  readonly status: number;
  /** Per-mutation attribution the server returned for a structural rejection, or null. */
  readonly rejections: MutationRejection[] | null;

  constructor(message: string, status: number, rejections: MutationRejection[] | null = null) {
    super(message);
    this.name = "MutationRequestError";
    this.status = status;
    this.rejections = rejections;
  }
}

/**
 * Extract per-mutation attribution from a non-2xx batch-write body. The server names the
 * offending mutations on a structural (validation) rejection; an absent, non-JSON, or
 * empty-`rejections` body yields null, so the failure is treated as non-attributable
 * (whole batch stays retryable).
 */
function parseBatchRejections(body: string): MutationRejection[] | null {
  if (body.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const result = batchMutationErrorSchema.safeParse(parsed);
  const rejections = result.success ? result.data.rejections : undefined;
  return rejections && rejections.length > 0 ? rejections : null;
}
