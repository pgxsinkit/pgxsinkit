import { z } from "zod";

import {
  asEphemeral,
  asReadonly,
  assertReadContractPreserved,
  defineEventStream,
  defineSyncRegistry,
} from "@pgxsinkit/contracts";

import {
  channelSyncEntry,
  issueSyncEntry,
  messageSyncEntry,
  profileSyncEntry,
  teamMemberSyncEntry,
  teamSyncEntry,
} from "./schema";

/**
 * The board's **Event streams** (pgxsinkit ADR-0053 decision 9) — the Event lane's registration, declared
 * once here and given to BOTH role registries below. The lane is a second lane beside the sync rail: an
 * append lands in the client's Outbox, flushes to `board-write`'s `/api/events`, and is delivered through a
 * pgmq queue to the board's own consumer runner (apps/board-api/src/core/issue-view-consumer.ts), which
 * archives it. Nothing about it syncs back down.
 *
 * `board_issue_viewed` is the whole demo stream: the Board is the toolkit's exerciser, and a lane the demo
 * did not drive would be the first toolkit surface with none.
 *
 * - **payload** is strict and deliberately ONE field. `issueId` is the only thing the act of viewing an
 *   Issue honestly establishes; the Issue's Team, title and Status are all derivable by joining `issue` in
 *   the archive, so carrying them would be denormalising a fact that is already in the database.
 * - **identity is server-stamped**, never client-trusted: `viewerId` is read from the verified `sub` claim
 *   at ingest — the same `claimPath` addressing the tables' `authClaim` managed fields use — so a client
 *   cannot claim to be another viewer. The client's envelope carries no identity at all.
 *
 * Evolution is compatibility-bound (ADR-0053 decision 1): this payload schema may only ever grow in ways
 * that keep accepting today's `{ issueId }` — events written offline under the old schema are still in
 * flight. An incompatible change needs a NEW Event-stream name.
 */
export const BOARD_ISSUE_VIEWED_STREAM = "board_issue_viewed";

/**
 * The `board_issue_viewed` payload contract, exported so the UI that appends it and the consumer runner
 * that archives it both read the ONE declaration rather than restating its shape.
 */
export const boardIssueViewedPayloadSchema = z.object({ issueId: z.uuid() }).strict();

export type BoardIssueViewedPayload = z.infer<typeof boardIssueViewedPayloadSchema>;

const boardEventStreams = {
  [BOARD_ISSUE_VIEWED_STREAM]: defineEventStream({
    payload: boardIssueViewedPayloadSchema,
    identity: { viewerId: { claimPath: ["sub"] } },
  }),
};

/**
 * The board sync registry — the single contract the client, the `board-sync` proxy, and the
 * `board-write` API all consume. Each entry carries its read-path `customWhere` (applied by the
 * proxy); the write-path RLS lives on the tables (schema.ts / policies.ts). The two are deliberate
 * mirrors: read filters and write policies derive from the same member-of-team / channel-visibility /
 * admin predicates so a row can never be visible-but-unwritable or vice versa by accident.
 *
 * It declares its `rowClasses` vocabulary (pgxsinkit ADR-0052), which makes classification a fail-closed
 * obligation: every entry must carry a `rowClass` from that set, so a new board table cannot join the
 * registry without its author saying which kind of rows it holds. See schema.ts for what each class means.
 *
 * It also registers the board's Event streams (`boardEventStreams` above). Streams touch no synced table
 * and stay out of the canonical fingerprint, so registering one rebuilds nobody's read cache.
 */
export const boardSyncRegistry = defineSyncRegistry({
  rowClasses: ["directory", "team-scoped", "channel-scoped"],
  tables: {
    profile: profileSyncEntry,
    team: teamSyncEntry,
    team_member: teamMemberSyncEntry,
    channel: channelSyncEntry,
    issue: issueSyncEntry,
    message: messageSyncEntry,
  },
  streams: boardEventStreams,
});

/**
 * Per-role client projections (pgxsinkit ADR-0025). `boardSyncRegistry` above is the **authoritative**
 * registry — the `board-sync` proxy, the `board-write` apply function, and `pgxsinkit-generate` all
 * consume it, and `team` / `team_member` are `readwrite` there (their write contract + RLS live on the
 * tables). A client consumes a *projection* of it, chosen by role at bootstrap (board-client.ts):
 *
 * - **Admin** writes Teams (rename) and memberships (add/remove) — it uses the authoritative registry.
 * - **Member** only reads both — `asReadonly` strips the local write machinery (no overlay/journal, no
 *   `client.tables.team{,_member}` write handle, no `_read_model` view) while preserving the read
 *   contract, so a member can never optimistically apply a write that RLS would only quarantine.
 * - **Chat retention** also differs by role (ADR-0021 lifecycle projection): the authoritative `message`
 *   is `persistent` — the Admin's durable, promote-on-first-use `lazy` full history — and the Member
 *   projects it through `asEphemeral`, so a Member's chat lives in a `TEMP` cluster and leaves no durable
 *   trace. Retention is a lifecycle axis the read-contract invariant ignores, so this projection still
 *   passes `assertReadContractPreserved`.
 *
 * The read filters above already branch on `isAdmin`, so the one authoritative registry serves both
 * roles' shapes; the client's *write capability* (team/team_member) and *retention* (message) differ,
 * which is exactly what a per-client projection expresses.
 */
export const boardAdminRegistry = boardSyncRegistry;

// The same vocabulary is declared here too: the projections carry each entry's `rowClass` through
// (`asReadonly`/`asEphemeral` preserve it), so the member registry is held to the same fail-closed
// classification as the authoritative one — a projection can never quietly drop a row's class.
//
// `streams` is re-declared for the same reason: the spread above copies the registry's ENUMERABLE table
// keys, and the Event streams ride a non-enumerable symbol (so they stay out of the fingerprint), so a
// projection that did not restate them would leave a Member with no Event lane at all — `appendEvent`
// would throw for exactly the role that does most of the viewing. Same entry objects, so the two
// registries share one contract.
export const boardMemberRegistry = defineSyncRegistry({
  rowClasses: ["directory", "team-scoped", "channel-scoped"],
  tables: {
    ...boardSyncRegistry,
    team: asReadonly(boardSyncRegistry.team),
    team_member: asReadonly(boardSyncRegistry.team_member),
    message: asEphemeral(boardSyncRegistry.message),
  },
  streams: boardEventStreams,
});

// Fail closed if a projection ever diverges the data it syncs (columns / pk / row-filter shape) — a
// member and an admin must see the same rows through the same tables, differing only in write rights and
// lifecycle (here, chat retention).
assertReadContractPreserved(boardSyncRegistry, boardMemberRegistry, { label: "board member" });
