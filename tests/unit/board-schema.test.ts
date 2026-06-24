import { describe, expect, it } from "bun:test";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";

// Importing the registry runs `defineSyncRegistry` → `validateSyncTableEntry` for every table, so a
// missing Server version or conflictPolicy on a writable table would throw at import. These assertions
// pin the board's contract (ADR-0003 conflict policies, ADR-0004 consistency group, ADR-0002 modes).

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
  });

  it("groups the team-scope tables, leaving profile and message singletons (ADR-0004)", () => {
    expect(boardSyncRegistry.team.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.team_member.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.channel.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.issue.consistencyGroup).toBe("team-scope");
    expect(boardSyncRegistry.message.consistencyGroup).toBeUndefined();
    expect(boardSyncRegistry.profile.consistencyGroup).toBeUndefined();
  });

  it("marks readwrite vs readonly modes (ADR-0002)", () => {
    expect(boardSyncRegistry.issue.mode).toBe("readwrite");
    expect(boardSyncRegistry.message.mode).toBe("readwrite");
    expect(boardSyncRegistry.team_member.mode).toBe("readwrite");
    expect(boardSyncRegistry.profile.mode).toBe("readonly");
    expect(boardSyncRegistry.team.mode).toBe("readonly");
    expect(boardSyncRegistry.channel.mode).toBe("readonly");
  });

  it("attaches a read-path row filter to every entry", () => {
    for (const key of Object.keys(boardSyncRegistry)) {
      const entry = boardSyncRegistry[key as keyof typeof boardSyncRegistry];
      expect(entry.shape?.rowFilter?.customWhere).toBeTypeOf("function");
    }
  });
});
