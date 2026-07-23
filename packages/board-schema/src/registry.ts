import { asEphemeral, asReadonly, assertReadContractPreserved, defineSyncRegistry } from "@pgxsinkit/contracts";

import {
  channelSyncEntry,
  issueSyncEntry,
  messageSyncEntry,
  profileSyncEntry,
  teamMemberSyncEntry,
  teamSyncEntry,
} from "./schema";

/**
 * The board sync registry — the single contract the client, the `board-sync` proxy, and the
 * `board-write` API all consume. Each entry carries its read-path `customWhere` (applied by the
 * proxy); the write-path RLS lives on the tables (schema.ts / policies.ts). The two are deliberate
 * mirrors: read filters and write policies derive from the same member-of-team / channel-visibility /
 * admin predicates so a row can never be visible-but-unwritable or vice versa by accident.
 */
export const boardSyncRegistry = defineSyncRegistry({
  profile: profileSyncEntry,
  team: teamSyncEntry,
  team_member: teamMemberSyncEntry,
  channel: channelSyncEntry,
  issue: issueSyncEntry,
  message: messageSyncEntry,
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

export const boardMemberRegistry = defineSyncRegistry({
  ...boardSyncRegistry,
  team: asReadonly(boardSyncRegistry.team),
  team_member: asReadonly(boardSyncRegistry.team_member),
  message: asEphemeral(boardSyncRegistry.message),
});

// Fail closed if a projection ever diverges the data it syncs (columns / pk / row-filter shape) — a
// member and an admin must see the same rows through the same tables, differing only in write rights and
// lifecycle (here, chat retention).
assertReadContractPreserved(boardSyncRegistry, boardMemberRegistry, { label: "board member" });
