import { describe, expect, it } from "bun:test";

import { getColumns } from "drizzle-orm";

import { boardAdminRegistry, boardMemberRegistry, boardSyncRegistry } from "@pgxsinkit/board-schema";
import { getSyncedLocalTable } from "@pgxsinkit/client";
import { buildRowFilterShape, fingerprintReadContract } from "@pgxsinkit/contracts";

// Importing the registry runs `defineSyncRegistry` → `validateSyncTableEntry` for every table (and
// `assertReadContractPreserved` for the member projection), so a missing Server version or conflictPolicy
// on a writable table — or a projection that diverged the read contract — would throw at import. These
// assertions pin the board's contract (ADR-0003 conflict policies, ADR-0004 consistency group, ADR-0002
// modes, ADR-0021 lazy/ephemeral, and pgxsinkit ADR-0025 per-client mode projection).

describe("board sync registry", () => {
  it("declares the six board tables", () => {
    expect(Object.keys(boardSyncRegistry).sort()).toEqual([
      "channel",
      "issue",
      "message",
      "profile",
      "team",
      "team_member",
    ]);
  });

  it("sets the conflict policies (ADR-0003)", () => {
    expect(boardSyncRegistry.issue.conflictPolicy).toBe("reject-if-stale");
    expect(boardSyncRegistry.message.conflictPolicy).toBe("last-write-wins");
    expect(boardSyncRegistry.team_member.conflictPolicy).toBe("last-write-wins");
    expect(boardSyncRegistry.team.conflictPolicy).toBe("reject-if-stale");
  });

  it("makes chat lazy, persistent on the authoritative entry, leaving the other tables eager + persistent (ADR-0021)", () => {
    // The authoritative/Admin chat is `lazy + persistent` (default retention); the Member projects it to
    // `ephemeral` (asserted in the per-client describe below).
    expect(boardSyncRegistry.message.subscription).toBe("lazy");
    expect(boardSyncRegistry.message.retention).toBeUndefined(); // default persistent
    for (const key of ["profile", "team", "team_member", "channel", "issue"] as const) {
      expect(boardSyncRegistry[key].subscription).toBeUndefined();
      expect(boardSyncRegistry[key].retention).toBeUndefined();
    }
  });

  it("groups the team-scope tables, leaving profile and message singletons (ADR-0004)", () => {
    expect(boardSyncRegistry.team.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.team_member.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.channel.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.issue.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.message.consistencyGroup).toBeUndefined();
    expect(boardSyncRegistry.profile.consistencyGroup).toBeUndefined();
  });

  it("marks readwrite vs readonly modes in the authoritative registry (ADR-0002)", () => {
    expect(boardSyncRegistry.issue.mode).toBe("readwrite");
    expect(boardSyncRegistry.message.mode).toBe("readwrite");
    expect(boardSyncRegistry.team_member.mode).toBe("readwrite");
    expect(boardSyncRegistry.team.mode).toBe("readwrite");
    expect(boardSyncRegistry.profile.mode).toBe("readonly");
    expect(boardSyncRegistry.channel.mode).toBe("readonly");
  });

  it("attaches a read-path row filter to every entry", () => {
    for (const key of Object.keys(boardSyncRegistry)) {
      const entry = boardSyncRegistry[key as keyof typeof boardSyncRegistry];
      expect(entry.shape?.rowFilter?.customWhere).toBeTypeOf("function");
    }
  });

  describe("per-client mode projection (pgxsinkit ADR-0025)", () => {
    it("uses the authoritative registry for the Admin client", () => {
      expect(boardAdminRegistry).toBe(boardSyncRegistry);
    });

    it("projects team + team_member read-only for the Member client, leaving the rest writable", () => {
      // The Admin writes Teams (rename) and memberships; the Member only reads them.
      expect(boardMemberRegistry.team.mode).toBe("readonly");
      expect(boardMemberRegistry.team_member.mode).toBe("readonly");
      // Tables the Member also writes are untouched by the projection.
      expect(boardMemberRegistry.issue.mode).toBe("readwrite");
      expect(boardMemberRegistry.message.mode).toBe("readwrite");
    });

    it("strips the local write machinery from the Member's projected tables", () => {
      // No overlay-merged read-model view and no overlay/journal projection — a readonly client reads
      // the synced base table and has no write handle.
      expect(boardMemberRegistry.team.view).toBeUndefined();
      expect(boardMemberRegistry.team_member.view).toBeUndefined();
      expect(boardMemberRegistry.team.clientProjection?.overlayTable).toBeUndefined();
      expect(boardMemberRegistry.team_member.clientProjection?.journalTable).toBeUndefined();
      // The Admin (authoritative) registry keeps them.
      expect(boardSyncRegistry.team.view).toBeDefined();
      expect(boardSyncRegistry.team_member.view).toBeDefined();
    });

    it("preserves the read contract across the projection (the invariant the import asserts)", () => {
      for (const key of ["team", "team_member", "message"] as const) {
        expect(fingerprintReadContract(boardMemberRegistry[key])).toBe(fingerprintReadContract(boardSyncRegistry[key]));
      }
    });

    it("boots the Member client: derives the local synced table for the asReadonly team (ADR-0029 P1 regression)", () => {
      // This is the exact operation that killed member login: since ADR-0029 P1 the client derives every
      // synced-table object from the entry's makeColumns factory. `boardMemberRegistry.team` is the
      // authoritative writable `team` projected `asReadonly`; if that projection dropped the factory,
      // getSyncedLocalTable threw at boot. Assert it resolves the projected synced object for both
      // read-only Member tables.
      for (const key of ["team", "team_member"] as const) {
        const synced = getSyncedLocalTable(boardMemberRegistry, key);
        expect(Object.keys(getColumns(synced)).length).toBeGreaterThan(0);
      }
    });

    it("projects chat retention per role: persistent Admin, ephemeral Member (ADR-0021 lifecycle)", () => {
      // The authoritative/Admin entry is persistent (default); the Member projects it ephemeral. Both stay
      // lazy + readwrite, so only the local durability differs — a lifecycle axis the read-contract
      // invariant ignores (asserted above).
      expect(boardAdminRegistry.message.retention).toBeUndefined(); // persistent (default)
      expect(boardMemberRegistry.message.retention).toBe("ephemeral");
      expect(boardMemberRegistry.message.subscription).toBe("lazy");
      expect(boardMemberRegistry.message.mode).toBe("readwrite");
    });
  });

  describe("member chat read window (ADR-0025 read filter + ADR-0021 lifecycle)", () => {
    const messageFilter = boardSyncRegistry.message.shape!.rowFilter!;

    it("syncs the full chat history to an Admin (no read filter)", () => {
      expect(buildRowFilterShape(messageFilter, { sub: "u1", app_metadata: { roles: ["admin"] } })).toBeNull();
    });

    it("windows a Member to the recent cutoff (channel scope AND a created_at_us lower bound)", () => {
      const shape = buildRowFilterShape(messageFilter, { sub: "u1" });
      expect(shape).not.toBeNull();
      expect(shape!.where).toContain("channel_id");
      expect(shape!.where).toContain("created_at_us");
      expect(shape!.where).toContain(">=");
      // The channel subquery binds the subject ($1); the window binds the day-quantized cutoff ($2) —
      // a bound param, never an inlined literal.
      expect(shape!.params.length).toBe(2);
      expect(Number(shape!.params[1])).toBeGreaterThan(0);
    });
  });
});
