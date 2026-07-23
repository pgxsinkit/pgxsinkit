// The bridge protocol (ADR-0032 S2). Everything that crosses between a tab and the shared sync engine
// travels as a typed {@link BridgeEnvelope} over a minimal {@link BridgePort} (a MessagePort-shaped
// transport). The router only ever inspects the envelope's `type`/`id`; its `payload` is OPAQUE to the
// router and always passes through a {@link BridgeCodec}, so a later columnar/transferable codec can be
// swapped in WITHOUT any protocol change (see BridgeCodec's doc).
//
// Deliberately transport-agnostic: `defineSyncWorker` and `attachSyncClient` both talk to a `BridgePort`,
// never a real `Worker`/`SharedWorker` directly — which is exactly why the whole bridge is unit-testable
// over bun's `MessageChannel` with no worker at all.

import type { SyncRuntimeStatus } from "@pgxsinkit/contracts";

import type { BootReport } from "../boot-report";
import type { ExportReport } from "../export-store";

export const BRIDGE_CHANNEL = "pgxsinkit-bridge" as const;
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

/**
 * A structured-clone transferable (an `ArrayBuffer`, a `MessagePort`, …). The library carries no DOM lib
 * dependency (like the convergence triggers), so this is the toolkit's own name for the type a future
 * columnar codec would hand to `postMessage`'s transfer list. The wire-format-1 identity codec
 * ({@link BRIDGE_PROTOCOL_VERSION}) never produces one.
 */
export type BridgeTransferable = unknown;

/**
 * The minimal MessagePort-shaped transport the bridge needs — the intersection of a real `MessagePort`,
 * a `SharedWorker` port, and a dedicated `Worker`/`self`. Injected everywhere so the protocol layer is
 * exercised with a plain `MessageChannel` (no Worker) in tests. `start()` is optional (MessagePort needs
 * it, `Worker`/`self` do not); `close()` is optional (a dedicated `self` cannot be closed by the tab).
 */
export interface BridgePort {
  postMessage: (message: unknown, transfer?: BridgeTransferable[]) => void;
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  start?: () => void;
  close?: () => void;
}

/**
 * The wire envelope. `payload` is the codec-encoded body — opaque to the router, which only routes on
 * `type` and correlates on `id`. Keeping the body opaque is what lets a future codec return a columnar
 * buffer (a transferable) in `payload` without any change to routing.
 */
export interface BridgeEnvelope {
  ch: typeof BRIDGE_CHANNEL;
  v: typeof BRIDGE_PROTOCOL_VERSION;
  type: BridgeMessageType;
  /** Correlation id for request/response pairs (rpc, subscribe, token pull). Absent for fire-and-forget fanout. */
  id?: string;
  /** Codec-encoded body — opaque to the router; decode with the same {@link BridgeCodec}. */
  payload: unknown;
}

export type BridgeMessageType =
  // tab → worker
  | "provision"
  | "attach"
  | "detach"
  | "token-push"
  | "token-response"
  | "rpc"
  | "subscribe"
  | "unsubscribe"
  | "wake"
  | "set-online"
  // worker → tab
  | "provision-ack"
  | "attach-ack"
  | "token-request"
  | "rpc-result"
  | "live-initial"
  | "live-diff"
  | "live-hydrated"
  | "event";

// ─── Payload shapes ───────────────────────────────────────────────────────────

/** A single auth token snapshot the tab owns and pushes to the worker (ADR-0032 decision 3). */
export interface AuthTokenSnapshot {
  accessToken: string;
  /** Absolute expiry in epoch milliseconds (`Date.now()`-comparable), so the worker can apply an expiry margin. */
  expiresAt: number;
}

/**
 * tab → worker: pre-spawn the store WITHOUT booting the engine (ADR-0032 decision 5). Sent at the
 * login screen against the freshly-named spare worker: the worker only runs PGlite `create`/initdb
 * (off every thread that matters) and holds the raw store idle — no schema, no shape streams, no token
 * — until the real {@link AttachPayload} arrives (with config + token) and adopts the provisioned store.
 * Role-agnostic on purpose: the spare is minted before the user (and role) is known, so provisioning
 * carries no registry — the schema is applied at attach with the role-resolved registry.
 */
export interface ProvisionPayload {
  /** The bound store id (informational; naming is done tab-side via the SharedWorker name). */
  storeId?: string;
  /**
   * The plain store PATH (ADR-0036) to `create` ahead of attach — a name, not a storage URL; the worker
   * derives the backend (IndexedDB in a browser worker). When omitted, `storeId`/the worker default is used.
   */
  storePath?: string;
  /**
   * @internal INTERNAL WIRE FIELD (not consumer config, ADR-0036). Carries the testing memory-backend
   * override across the bridge, because a symbol-keyed marker does NOT survive `postMessage` structured
   * clone — so the worker's memory-store selection travels as this explicit field. Set only by the test
   * lane (via the attaching helper); a browser worker never sends it.
   */
  testStoreBackend?: "memory";
}

/** worker → tab: the provision completed (or failed). Lets the login screen confirm the spare is warm. */
export interface ProvisionAckPayload {
  ok: boolean;
  storeId?: string;
  /** Present when `!ok` — the initdb/create failed; the worker falls back to a fresh create at attach. */
  error?: { message: string };
}

/**
 * tab → worker: a store-backup tarball to restore from, carried on the boot {@link AttachPayload}
 * (ADR-0035 decision 6). The mirror image of {@link ExportArtefactWire}: a `File`/`Blob` cannot cross the
 * bridge as a transferable, so it is decomposed into its zero-copy `ArrayBuffer` (listed on `postMessage`'s
 * transfer list) plus the metadata to rebuild it, and the worker reassembles a `Blob` from
 * `buffer`/`mimeType` to hand `createSyncClient` as `restoreFrom`.
 */
export interface RestoreArtefactWire {
  /** The backup tarball bytes — transferred, not copied. */
  buffer: ArrayBuffer;
  /** The backup file name (informational; PGlite's `loadDataDir` reads the bytes, not the name). */
  fileName: string;
  /** The backup MIME type (`application/x-gzip` / `application/x-tar`), used to rebuild the `Blob`. */
  mimeType: string;
}

/** tab → worker: the attach handshake. The first attach boots the engine; later attaches join it. */
export interface AttachPayload {
  /** The bound store id (SharedWorker naming resolves it tab-side before attach — ADR-0032 decision 5). */
  storeId?: string;
  /**
   * Explicit plain store PATH (ADR-0036) if the worker should create its own store — a name, not a storage
   * URL; the worker derives the backend. When omitted, `storeId`/the worker default is used.
   */
  storePath?: string;
  /**
   * @internal INTERNAL WIRE FIELD (not consumer config, ADR-0036). Carries the testing memory-backend
   * override across the bridge — a symbol-keyed marker does not survive structured clone, so the worker's
   * memory-store selection travels as this explicit field. Set only by the test lane; never by a browser tab.
   */
  testStoreBackend?: "memory";
  /** ADR-0049 D5: the tab's engine-construction limit, checked by the host before it acknowledges attach. */
  executionLimit?: { maxDispatchMs?: number };
  /**
   * Restore the store from a backup on THIS attach (ADR-0035 decision 6) — the worker-mode carrier of
   * `createSyncClient`'s `restoreFrom`. Restore rides the FIRST attach (the boot attach): a `File`/`Blob`
   * cannot cross `postMessage` as a transferable, so the tab decomposes it into a transferred `ArrayBuffer`
   * plus its name/mime — the {@link ExportArtefactWire} pattern in reverse — and the worker recomposes it
   * into a `Blob` and hands it to `createSyncClient`. Absent on every ordinary attach. An attach that carries
   * this AFTER the engine has already booted is REFUSED (you cannot restore into a running store).
   */
  restore?: RestoreArtefactWire;
  /** The tab's current auth token at attach time, or null when unauthenticated. */
  token: AuthTokenSnapshot | null;
  /**
   * Serializable per-attach config overrides (kept minimal; the urls are baked into the worker). `role`
   * selects which baked registry the worker boots (ADR-0032 S3): the spare is minted role-agnostic, so
   * the role is only known at claim/attach — a single worker file bakes BOTH registries and picks here.
   * `freshStore` is the fresh-store prefetch-overlap hint (ADR-0032 S4): the tab's claim path knows a
   * claimed spare is schemaless (fresh) while a mapped/returning store never is, and forwards that here so
   * the worker's `createSyncClient` can overlap the shape catch-up with the local boot phases.
   */
  config?: { syncEnabled?: boolean; role?: string; freshStore?: boolean };
}

/**
 * tab → worker: gate the worker's outbound convergence (the board's Offline toggle, ADR-0032 S3). In
 * in-process mode the toggle gates the local `autoSync` trigger; the worker owns convergence instead, so
 * the tab forwards the flag and the worker suppresses/resumes its flush passes. Going back online fires
 * one immediate pass so queued writes flush without waiting for the next interval tick.
 */
export interface SetOnlinePayload {
  online: boolean;
}

/**
 * The two background boot stages the worker announces over the bridge as one-shot milestones (ADR-0041
 * stage 2). `localReadReady` is NOT in this set: under the Option B contract the `attach-ack` fires AT the
 * engine's `localReadReady`, so a tab resolves that stage from the ack itself (early OR late attach) — it
 * needs no separate milestone. `writeReady` and `bootSettled` cross in the background write/sync tail, after
 * the ack, so they DO ride milestone messages (and the late-attach ack fold).
 */
export type BootMilestone = "writeReady" | "bootSettled";

/** worker → tab: attach acknowledged. `alreadyBooted` is false for the attach that booted the engine. */
export interface AttachAckPayload {
  alreadyBooted: boolean;
  /**
   * True when the engine's initial sync had ALREADY fired by the time this attach was acked (a late
   * attach, ADR-0032 FIX 3). `ready` is monotonic in-process — once it resolves it stays resolved even if
   * the phase later degrades — so a tab attaching after that moment must resolve `ready` immediately from
   * the ack, rather than wait for a phase-"ready" status that may never come again.
   */
  engineReady?: boolean;
  /**
   * Late-attach milestone fold (ADR-0041 stage 2): true when the engine had ALREADY crossed `writeReady` /
   * `bootSettled` by the time this attach was acked, so a tab attaching after the stage fired resolves it
   * straight from the ack rather than waiting for a `milestone` broadcast it missed. The ack fires AT
   * `localReadReady`, so that stage is always implied by a non-error ack and carries no boolean.
   */
  writeReady?: boolean;
  bootSettled?: boolean;
  /**
   * Late-attach failure fold (ADR-0041 stage 2): present when the engine's background write/sync tail had
   * already REJECTED a downstream stage before this attach was acked. The tab rejects the matching stage
   * promise (so a gated write / `bootSettled` awaiter fails loudly rather than hangs) — but the attach
   * itself still RESOLVES (the engine reached `localReadReady`; only the tail failed). A live milestone
   * failure after attach rides the `milestone-error` broadcast instead.
   */
  writeReadyError?: { message: string; detail?: unknown };
  bootSettledError?: { message: string; detail?: unknown };
  /**
   * Present when the engine boot REJECTED for this attach: the tab rejects `attachSyncClient` with this
   * message instead of hanging forever on the ack (ADR-0032 FIX 1). A later attach retries the boot. This
   * is a LOCAL-READ-CORE failure (the engine never reached `localReadReady`); a tail failure after
   * `localReadReady` uses the stage-error fields above and does NOT reject the attach.
   */
  error?: { message: string; detail?: unknown };
}

/** worker → tab: a broadcast pull-request — any attached tab may answer, first response wins (ADR-0032 decision 3). */
export interface TokenRequestPayload {
  requestId: string;
}

/** tab → worker: the answer to a {@link TokenRequestPayload}. `token: null` = the tab has none. */
export interface TokenResponsePayload {
  requestId: string;
  token: AuthTokenSnapshot | null;
}

/**
 * The RPC ops the attach facade proxies to the worker's booted client — the write API (mirrors
 * `client.mutate`/flush), mutation-state reads, and the one-shot raw inspection reads (`rawQuery`/`rawExec`).
 */
export type RpcOp =
  | "create"
  | "update"
  | "delete"
  | "batch"
  | "transaction"
  | "flush"
  | "reconcile"
  | "retryFailed"
  | "recoverSending"
  | "discardConflict"
  | "discardQuarantined"
  | "desync"
  | "discardEphemeral"
  // Lazy activation (ADR-0021): start the consistency groups of the given relation keys on the shared engine.
  // Engine-WIDE but additive/idempotent (unlike `desync`), so it is a plain fire-and-await RPC — carries
  // `[keys]`, resolves once the streams are started (catch-up may still be in flight).
  | "ensureSynced"
  | "readMutationDetails"
  | "diagnostics"
  | "rawQuery"
  | "rawExec"
  // Guarded one-shot Drizzle read (ADR-0032 decision 4): the attach client's Drizzle-over-bridge compiles a
  // read to SQL on the tab and routes it here as the {@link GuardedQueryWireArgs} tuple
  // `[sql, params?, { rowMode? }, use?]`. Unlike `rawQuery` (raw inspection, no guard), the worker runs the
  // engine's `guardedRawQuery` — the ADR-0041 read gate + the ADR-0021 lazy-group guard (activating any lazy
  // relation the SQL/`use` reference) — then returns the full PGlite `Results` over `rpc-result`, so Drizzle's
  // own result mapping runs on the tab. Only `rowMode` crosses in the options: drizzle's `parsers` map is
  // FUNCTIONS (non-serializable) and is stripped tab-side, then re-applied worker-side so the identity-parsed
  // OIDs (drizzle's identity parsers — temporal OIDs + numeric[]) round-trip as raw strings exactly as in-process.
  | "guardedQuery"
  // Boot observability (ADR-0034): pull the worker engine's most recent completed boot report. Returns the
  // stored report (or null) regardless of when this tab attached, so a late tab reads a boot predating it.
  | "bootReport"
  // Live-query diagnostics (ADR-0040 decision 5): pull the worker manager's per-entry snapshot (digests +
  // counts/timings, NEVER SQL/params/rows). Returns [] before any subscription / when the manager is absent.
  | "liveQueryDiagnostics"
  // Store backup (ADR-0035): the worker runs the live `exportStore` on its owned client; the dump crosses
  // back as a transferred `ArrayBuffer` ({@link ExportArtefactWire}), rebuilt into a `File` tab-side.
  | "exportStore"
  // Diagnostic dump (ADR-0035): the worker runs `exportDiagnostics` on its owned client (live datadir dump
  // → memory throwaway clone → `pg_dump`); the SQL crosses back as the same transferred `ArrayBuffer` wire.
  | "exportDiagnostics"
  // Data export (ADR-0035): the worker runs `exportData` on its owned client (drain the journal → throwaway
  // clone → `pg_dump -t` per synced table); the portable SQL crosses back as the same transferred wire.
  | "exportData";

/**
 * The positional wire tuple the `guardedQuery` {@link RpcOp} carries: a guarded one-shot Drizzle read compiled
 * to SQL on the tab. Encoded identically by both tab-side senders (`attachSyncClient`'s bridge executor and
 * `guardedRawQuery`) and decoded against this same type worker-side (`defineSyncWorker`'s dispatch), so encoder
 * and decoder share ONE contract. `options` carries only `rowMode` — drizzle's `parsers` map is stripped
 * tab-side (see the `guardedQuery` op above) and re-applied worker-side. The optional trailing `use` lists the
 * raw-fragment lazy relations (ADR-0021) the SQL scan cannot see.
 */
export type GuardedQueryWireArgs = [
  sql: string,
  params: unknown[] | undefined,
  options: { rowMode?: "array" | "object" },
  use?: readonly string[],
];

/** tab → worker: a write/read-of-mutation-state RPC. `id` correlates the matching {@link RpcResultPayload}. */
export interface RpcPayload {
  op: RpcOp;
  args: unknown[];
}

/**
 * worker → tab: the wire form of ANY local-store export (ADR-0035) — the store backup's tarball OR the
 * diagnostic dump's SQL — carried as the `value` of an {@link RpcResultPayload}. The artefact crosses as a
 * transferred `ArrayBuffer` (zero-copy — the sender lists `buffer` in `postMessage`'s transfer list) plus
 * the metadata to rebuild it; the tab reconstructs a `File` from `buffer`/`fileName`/`mimeType`. A `File`
 * cannot itself be transferred, so it is decomposed here and reassembled tab-side, exactly the pattern the
 * codec's transferable seam anticipates for a zero-copy live-diff payload. `report` is the discriminated
 * {@link ExportReport} union, so the tab knows which export it round-tripped.
 */
export interface ExportArtefactWire {
  /** The artefact bytes (tarball or SQL) — transferred, not copied. */
  buffer: ArrayBuffer;
  /** The generated (or caller-supplied) artefact file name. */
  fileName: string;
  /** The artefact MIME type (`application/x-gzip` / `application/x-tar` for a backup, `application/sql` for a dump). */
  mimeType: string;
  /** The export report (ADR-0035), structured-cloned as a plain object — the `kind`-discriminated union. */
  report: ExportReport;
}

/** worker → tab: an RPC outcome, mirroring today's in-process resolve/reject semantics. */
export interface RpcResultPayload {
  ok: boolean;
  /** The resolved value (present when `ok`). */
  value?: unknown;
  /** The rejection message + optional structured detail (present when `!ok`). */
  error?: { message: string; detail?: unknown };
}

/** tab → worker: register a live query. `id` correlates the initial snapshot; `queryId` keys subsequent diffs. */
export interface SubscribePayload {
  queryId: string;
  sql: string;
  params: unknown[];
  /**
   * The unique output aliases the worker wraps the query's columns under so it is safe to MATERIALISE
   * (one per output column, in the compiled SQL's column order). When omitted, the worker leaves the SQL
   * untouched and returns name-keyed rows; supply it for a JOIN with same-named columns, which
   * `live.query`/`live.incrementalQuery` otherwise
   * refuse to materialise (`column "title" specified more than once`). When present, result columns are
   * the aliases, so {@link pkColumns} must name a PK by its alias.
   */
  fields?: string[];
  /**
   * The result's primary-key columns, driving diff keying (§4). One column → the incremental path
   * (`live.incrementalQuery`); many → worker-side diff by composite PK; empty/absent → value-identity
   * fallback for a keyless query. When {@link fields} is supplied these name the ALIASED result columns.
   */
  pkColumns?: string[];
  /** Lazy relations to activate before the query runs (ADR-0021), forwarded to the worker's `prepareQuery`. */
  use?: string[];
  /**
   * Per-subscription keep-alive hint (ms) for the worker's live-query manager (ADR-0040 decision 4): how long
   * the shared registration should be retained after this subscription's last consumer leaves, so a matching
   * resubscribe reuses it verbatim. When omitted, the worker falls back to
   * `liveQueries.defaultKeepAliveMs`; absent means "no hint".
   */
  keepAliveMs?: number;
}

/** worker → tab: the initial ordered snapshot for a subscription. `id` correlates the `subscribe` request. */
export interface LiveInitialPayload {
  queryId: string;
  rows: Record<string, unknown>[];
  /**
   * The `lazy` relations the worker's guard activated for this query (ADR-0021) — the relations held out
   * of the eager boot set. Observability only: {@link hydratingTables}, not this, drives the tab's
   * `hydrated` promise.
   */
  lazyTables?: string[];
  /**
   * The referenced consistency groups' member tables (eager OR lazy) that were NOT YET caught up when this
   * snapshot was taken (ADR-0021 / ADR-0032). Non-empty → the tab builds a `hydrated` promise the worker
   * settles via `live-hydrated` (posted after the catch-up rows on this same port). Absent → every
   * referenced group was already ready (steady state) or sync is disabled: nothing to hydrate.
   */
  hydratingTables?: string[];
}

/**
 * worker → tab: the subscription's lazy relations have completed their initial catch-up AND the live
 * query has been refreshed against the caught-up store (ADR-0021). Posted on the SAME port as the
 * live-diff stream, strictly after the refresh-triggered diff — so when the tab sees this, the rows
 * reflecting the catch-up have already been delivered. Resolves the tab subscription's `hydrated`
 * promise (the React hooks' `hydrating` gate); never sent for a query with no pending groups (steady
 * state / sync disabled), i.e. an empty `live-initial` {@link LiveInitialPayload.hydratingTables}.
 */
export interface LiveHydratedPayload {
  queryId: string;
}

/**
 * worker → tab: a DIFF update for a subscription (§4). Never a full result-set resend after the initial
 * snapshot. `order` is the full ordered list of row keys (cheap — keys only, no row bodies); `added`/
 * `changed` carry only the delta row bodies; `removed` carries only the dropped keys. The tab materializer
 * rebuilds the ordered array from `order`, reusing cached row objects for keys not in `added`/`changed` so
 * an unchanged row keeps its object identity (React memo bails on `===`).
 */
export interface LiveDiffPayload {
  queryId: string;
  /** Every result key in ORDER BY order (the query's delivered order). */
  order: string[];
  added: { key: string; row: Record<string, unknown> }[];
  changed: { key: string; row: Record<string, unknown> }[];
  removed: string[];
}

/** worker → tab: the single broadcast event stream (ADR-0032 decision 7), re-exposed as today's callbacks. */
export type BridgeEvent =
  | { kind: "status"; status: SyncRuntimeStatus }
  | { kind: "groupReady"; groupKey: string }
  // Staged boot readiness (ADR-0041 stage 2): a one-shot milestone as the engine crosses a background boot
  // stage (`writeReady` / `bootSettled`), broadcast to currently-attached ports. A tab attaching AFTER a
  // stage fired never sees the broadcast — it folds the current milestone set off its `attach-ack` instead.
  // One engine crosses each stage once; every port observes the same monotonic sequence (ack fold + event).
  | { kind: "milestone"; stage: BootMilestone }
  // The mirror failure edge: the background write/sync tail REJECTED a downstream stage (ADR-0041). Rejects
  // the tab's matching `writeReady` / `bootSettled` promise so an awaiter fails loudly rather than hanging;
  // `localReadReady` (and the resolved attach) are unaffected — the engine reached local-read readiness.
  | { kind: "milestone-error"; stage: BootMilestone; error: { message: string; detail?: unknown } }
  | { kind: "conflict"; details: unknown }
  | { kind: "quarantine"; details: unknown }
  | { kind: "reject"; details: unknown }
  | { kind: "schema-change"; event: unknown }
  | { kind: "sync-error"; message: string }
  | { kind: "timing"; label: string; ms: number; data?: Record<string, unknown> }
  // Boot observability (ADR-0034): the one-shot boot report, broadcast to currently-attached ports when the
  // engine's boot finalizes (the push counterpart of the `bootReport` pull). Later tabs read it via the pull.
  | { kind: "boot-report"; report: BootReport }
  // The debug rail (ADR-0032 decision 7): stamped with the WORKER's monotonic clock and origin-tagged so a
  // tab can re-print it as `[pgxsinkit·w <stamp>ms] <line>` — a SharedWorker's own console is invisible.
  | { kind: "debug"; stamp: number; line: string; data?: Record<string, unknown> };

/** tab → worker: an app-driven wake (online/visibilitychange), treated as a convergence pass request. */
export interface WakePayload {
  reason: "online" | "visibility" | "manual";
}

// ─── Codec seam ─────────────────────────────────────────────────────────────

/**
 * The codec every bridge payload crosses through (owner-mandated seam, ADR-0032 S2 §1). v1 ships exactly
 * ONE codec — {@link identityCodec}, which relies on the transport's own structured clone. The seam exists
 * so a columnar/transferable codec (e.g. one that packs live-diff rows into a shared `ArrayBuffer` and
 * returns it as a transferable) can be swapped in later WITHOUT any protocol change: the router already
 * treats `BridgeEnvelope.payload` as opaque, and `encode` may return `{ payload, transfer }` so the sender
 * hands transferables to `postMessage`. Keep encode/decode inverse and side-effect free.
 */
export interface BridgeCodec {
  /** Encode a raw payload into the envelope body. May declare transferables for a future zero-copy codec. */
  encode: (payload: unknown) => { payload: unknown; transfer?: BridgeTransferable[] };
  /** Decode an envelope body back into the raw payload. Inverse of {@link encode}. */
  decode: (payload: unknown) => unknown;
}

/**
 * The identity codec, wire-format version 1 ({@link BRIDGE_PROTOCOL_VERSION}): the body IS the payload,
 * and the transport's structured clone does the real copying. No transferables. The sole codec at this
 * wire version — swapping in a columnar codec later touches only this object, never the message types or
 * the router.
 */
export const identityCodec: BridgeCodec = {
  encode: (payload) => ({ payload }),
  decode: (payload) => payload,
};

// ─── Envelope helpers ─────────────────────────────────────────────────────────

/** Build a wire envelope, running the payload through the codec. Returns the envelope + any transferables. */
export function encodeEnvelope(
  codec: BridgeCodec,
  type: BridgeMessageType,
  payload: unknown,
  id?: string,
): { envelope: BridgeEnvelope; transfer?: BridgeTransferable[] } {
  const encoded = codec.encode(payload);
  const envelope: BridgeEnvelope = {
    ch: BRIDGE_CHANNEL,
    v: BRIDGE_PROTOCOL_VERSION,
    type,
    payload: encoded.payload,
    ...(id !== undefined ? { id } : {}),
  };
  return { envelope, ...(encoded.transfer ? { transfer: encoded.transfer } : {}) };
}

/** Type-guard a received message as a bridge envelope of the current protocol version (ignore foreign traffic). */
export function isBridgeEnvelope(data: unknown): data is BridgeEnvelope {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { ch?: unknown }).ch === BRIDGE_CHANNEL &&
    (data as { v?: unknown }).v === BRIDGE_PROTOCOL_VERSION
  );
}

/**
 * Send a typed message over a port: encode → post (with any transferables). The one write choke point.
 * `transfer` lets a caller declare payload-specific transferables (e.g. a store-backup's `ArrayBuffer`,
 * ADR-0035) WITHOUT teaching the shared codec about that op — they are merged after any the codec itself
 * produces, so both the codec's future zero-copy path and per-message transfers coexist.
 */
export function postBridgeMessage(
  port: BridgePort,
  codec: BridgeCodec,
  type: BridgeMessageType,
  payload: unknown,
  id?: string,
  transfer?: BridgeTransferable[],
): void {
  const { envelope, transfer: codecTransfer } = encodeEnvelope(codec, type, payload, id);
  const allTransfer = [...(codecTransfer ?? []), ...(transfer ?? [])];
  if (allTransfer.length > 0) {
    port.postMessage(envelope, allTransfer);
  } else {
    port.postMessage(envelope);
  }
}
