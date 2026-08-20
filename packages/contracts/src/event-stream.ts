import type { z } from "zod";

/**
 * Event-stream registration (ADR-0053 decision 1) — the contract half of the **Event lane**, the toolkit's
 * second lane beside the sync rail.
 *
 * An **Event stream** is a named, registered category of append-only client events sharing one payload
 * schema and one consumer-side handling. It is registered on the sync registry
 * (`SyncRegistryDefinition.streams`), where the record KEY is the Event-stream name, so there is one
 * contract artifact rather than a second one to lock, diff and thread through the server and the worker.
 *
 * The registration stays **declarative data only** — no functions. The gating hook (consent/entitlement
 * refusal before enqueue) is a function on `CreateSyncServerOptions`, keyed by Event-stream name, never a
 * field here.
 */

/**
 * One claim-derived identity field of an Event stream: the JSON path into the **verified** request claims
 * the value is stamped from at ingest.
 *
 * The same addressing as a managed field's `authClaim` strategy (`ManagedFieldSpec.claimPath`) — `["sub"]`
 * for the auth subject, `["app_metadata", "person_id"]` for an app-minted identity — so the two
 * claim-stamping surfaces of the toolkit read identically. Identity is **server-stamped**, never
 * client-trusted: the client's envelope carries no identity at all (see `eventEnvelopeSchema`), and the
 * stamped value reaches the consumer callback on the queue envelope (`stampedEventSchema`).
 */
export interface EventStreamIdentityField {
  /** JSON path into the verified claims; each segment a plain identifier. Must be non-empty. */
  claimPath: readonly string[];
}

/**
 * A registered Event stream: its payload contract and its claim→identity stamping rule.
 *
 * `payload` is a **strict** zod schema, and strictness is ENFORCED, not merely advertised: an object-rooted
 * payload (including every object inside a union or discriminated union) must carry a `never` catchall —
 * `.strict()` or `z.strictObject()` — or `defineSyncRegistry` rejects the registration. A stripping object
 * would let a misspelled or newly-added key vanish between the caller and the consumer with no verdict
 * anywhere, which is exactly the silence the Event lane's "everything in the Outbox is well-formed"
 * invariant exists to prevent. A NON-object root (a string, array, record, a transform pipeline, …) is
 * accepted unchanged and follows ordinary parse-contract semantics: what the schema ACCEPTS is what
 * `appendEvent` validates, and the JSON-NORMALIZED form of what the schema PRODUCES is what the consumer
 * receives.
 *
 * **The schema EXECUTES at both boundaries; only ONE execution's output is taken.** `appendEvent` runs it as
 * pure validation — the result is discarded and the Outbox stores the value the caller supplied — and the
 * ingestion endpoint runs it again as the one AUTHORITATIVE parse, whose output is what is enqueued and what
 * the consumer callback receives. A transform callback therefore runs twice, so **transforms must be pure
 * and deterministic**: an effectful or environment-dependent one is unsupported, because the server's run is
 * the one that counts and nothing reconciles it against the client's. Parse output the JSON value domain
 * cannot carry (a `BigInt`, `undefined`) is a terminal per-event `rejected` at ingest, never a batch fault.
 *
 * **What is enqueued is the JSON-NORMALIZED parse output, not the parse output itself.** Ingest serializes
 * the authoritative parse's result and enqueues the round-trip, so every queue backend — the in-memory fake
 * and real pgmq's `jsonb` alike — delivers the identical value. The consequence is worth designing against:
 * a transform producing a `Date` reaches the consumer as that date's ISO STRING, and a nested `undefined`
 * property is dropped (an `undefined` array member becomes `null`). A transform that must round-trip as a
 * rich type has to encode it itself.
 *
 * **Schema evolution is compatibility-bound** (ADR-0053 decision 1): a payload schema may evolve only
 * backward-compatibly — it must keep accepting every previously-valid payload, because events written
 * offline under the old schema are still in flight. An incompatible change requires a NEW Event-stream
 * name. The registry lock records a hash of this entry so a change is a reviewable `risky` diff; the hash
 * DETECTS change, it cannot judge compatibility (see `registryEventStreams`).
 */
export interface EventStreamEntry<TPayload extends z.ZodType = z.ZodType> {
  payload: TPayload;
  /**
   * The identity fields stamped server-side from verified claims, keyed by field name. The stamped record
   * (field name → value) is what the consumer callback receives on every event.
   */
  identity: Record<string, EventStreamIdentityField>;
  /**
   * An opaque version counter for the part of this payload contract the lock's hash cannot see — the same
   * role `RowFilterSpec.revision` plays for a `customPredicate` closure. The lock hashes the payload schema as
   * a **JSON Schema**, and refinements/transforms are simply not representable there: a reviewer
   * demonstrated that `z.string().refine(v => v.length >= 3)` and the INCOMPATIBLE `>= 10` version produce
   * the identical stream hash, so the `risky` diff the ADR relies on never fires.
   *
   * So: whenever you change acceptance logic a JSON Schema cannot express (any `.refine`/`.superRefine`
   * threshold, a cross-field check, a transform), you MUST bump `revision` (positive integer). That is
   * what surfaces the change in the lock diff, where the compatibility rule can actually be reviewed.
   * Leaving it unchanged after a refinement change silently bypasses the gate.
   */
  revision?: number;
}

/** A registry's Event streams, keyed by Event-stream name (the key IS the name). */
export type EventStreamRegistry = Record<string, EventStreamEntry>;

/** The payload TYPE of a registered Event stream — what `appendEvent` accepts for it. */
export type EventStreamPayload<TEntry extends EventStreamEntry> =
  TEntry extends EventStreamEntry<infer TPayload> ? z.infer<TPayload> : never;

/**
 * The queue-name prefix each Event stream's pgmq queue is provisioned under (`pgxsinkit_events_<stream>`,
 * ADR-0053 decision 5). Its length is what bounds {@link EVENT_STREAM_NAME_MAX_LENGTH}.
 */
export const EVENT_STREAM_QUEUE_PREFIX = "pgxsinkit_events_";

/**
 * The maximum length of an Event-stream name: **30**. pgmq's queue-name limit is 47 characters and
 * {@link EVENT_STREAM_QUEUE_PREFIX} consumes 17 of them, so a longer name could not be provisioned. The
 * bound is enforced at `defineSyncRegistry` (module eval) rather than at deployment DDL, because a name
 * that fails only when the queue is created fails far too late.
 */
export const EVENT_STREAM_NAME_MAX_LENGTH = 47 - EVENT_STREAM_QUEUE_PREFIX.length;

/**
 * Event-stream names are lowercase `[a-z][a-z0-9_]*` — the intersection of what pgmq accepts unquoted and
 * what stays legible as a queue/table suffix.
 */
export const EVENT_STREAM_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Declare one Event stream for a registry's `streams` map.
 *
 * The Event-stream NAME is the record key it is registered under, so it is not named here — the name (and
 * this entry's payload/identity shape) is validated fail-closed at `defineSyncRegistry`, which sees the
 * whole map and reports EVERY offender in one error rather than one per build.
 *
 * ```ts
 * import { z } from "zod";
 *
 * export const registry = defineSyncRegistry({
 *   tables: { issue },
 *   streams: {
 *     board_issue_viewed: defineEventStream({
 *       payload: z.object({ issueId: z.uuid() }).strict(),
 *       identity: { viewerId: { claimPath: ["sub"] } },
 *     }),
 *   },
 * });
 * ```
 */
export function defineEventStream<const TPayload extends z.ZodType>(input: {
  payload: TPayload;
  identity: Record<string, EventStreamIdentityField>;
  /** Bump on every change the JSON-Schema hash cannot see. See {@link EventStreamEntry.revision}. */
  revision?: number;
}): EventStreamEntry<TPayload> {
  return {
    payload: input.payload,
    identity: input.identity,
    ...(input.revision != null ? { revision: input.revision } : {}),
  };
}

/**
 * Whether a value walks and quacks like a zod schema.
 *
 * Duck-typed on `safeParse` (the capability `appendEvent` and the ingest endpoint actually use) rather
 * than `instanceof z.ZodType`: zod is a PEER dependency, so a consumer with a duplicated zod install would
 * fail an `instanceof` against a schema that is perfectly usable.
 */
export function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function" &&
    typeof (value as { parse?: unknown }).parse === "function"
  );
}

/** The bits of zod v4's internal `_zod.def` this module reads. Kept structural — zod is a PEER dependency. */
interface ZodDefLike {
  type?: unknown;
  catchall?: unknown;
  options?: unknown;
}

function zodDefOf(schema: unknown): ZodDefLike | undefined {
  const def = (schema as { _zod?: { def?: unknown } } | null | undefined)?._zod?.def;
  return def != null && typeof def === "object" ? (def as ZodDefLike) : undefined;
}

/**
 * Whether an Event stream's payload schema has a NON-strict object at its root — the one shape
 * `validateEventStreams` refuses (ADR-0053 decision 1: the payload contract is strict, and the promise is
 * enforced rather than advertised).
 *
 * zod v4 models strictness as the object's **catchall**: `.strict()` / `z.strictObject()` set it to
 * `ZodNever`, a bare `z.object()` leaves it unset (unknown keys are silently STRIPPED), and
 * `z.looseObject()` / `.catchall(…)` set something else. So the rule is exactly "an object root's catchall
 * must be `never`", read off `_zod.def` — the same duck-typed posture as {@link isZodSchema}, never an
 * `instanceof` a peer-installed class.
 *
 * A union (or discriminated union) is walked recursively, because each member is equally a root the client
 * may append against. Every other root — string, array, record, a `.transform()` pipeline — is NOT an
 * object and is accepted unchanged. A schema whose internals cannot be read at all (a duplicated zod
 * install, a hand-rolled duck-typed schema) is likewise accepted: this check can only refuse what it can
 * actually see.
 */
export function hasNonStrictObjectRoot(schema: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (candidate: unknown): boolean => {
    if (candidate == null || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    const def = zodDefOf(candidate);
    if (!def) {
      return false;
    }
    if (def.type === "object") {
      return zodDefOf(def.catchall)?.type !== "never";
    }
    if (def.type === "union" && Array.isArray(def.options)) {
      return def.options.some(walk);
    }
    return false;
  };
  return walk(schema);
}
