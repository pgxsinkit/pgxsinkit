import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { pgTable, QueryBuilder, uuid, varchar } from "drizzle-orm/pg-core";

import { remapLiveRow, type SelectedFields } from "../../packages/react/src/remap-live-row";

// The footgun this guards: `useLiveDrizzleRows` runs a Drizzle select's `.toSQL()` through PGlite's
// live query, which returns rows keyed by the underlying (snake_case) column names. `remapLiveRow`
// uses the select's `_.selectedFields` metadata to map them back to the builder's field keys, so
// `assignee_id` becomes `assigneeId` and typed access stops silently reading `undefined`.

const issue = pgTable("issue", {
  id: uuid("id"),
  teamId: uuid("team_id"),
  assigneeId: uuid("assignee_id"),
  title: varchar("title"),
});

function selectedFieldsOf(query: unknown): SelectedFields {
  return (query as { _: { selectedFields: SelectedFields } })._.selectedFields;
}

describe("remapLiveRow", () => {
  it("maps an explicit select({...}) snake_case row to the camelCase field keys", () => {
    const query = new QueryBuilder()
      .select({ assigneeId: issue.assigneeId, teamId: issue.teamId, title: issue.title })
      .from(issue);
    expect(remapLiveRow(selectedFieldsOf(query), { assignee_id: "a", team_id: "t", title: "hi" })).toEqual({
      assigneeId: "a",
      teamId: "t",
      title: "hi",
    });
  });

  it("maps select() (all columns) by the underlying column names", () => {
    const query = new QueryBuilder().select().from(issue);
    expect(remapLiveRow(selectedFieldsOf(query), { id: "i", team_id: "t", assignee_id: "a", title: "hi" })).toEqual({
      id: "i",
      teamId: "t",
      assigneeId: "a",
      title: "hi",
    });
  });

  it("reads an aliased SQL field by its select key", () => {
    const query = new QueryBuilder().select({ openCount: sql<number>`count(*)`.as("open_count") }).from(issue);
    expect(remapLiveRow(selectedFieldsOf(query), { openCount: 7 })).toEqual({ openCount: 7 });
  });

  it("returns the row unchanged when there is no field map (raw query)", () => {
    expect(remapLiveRow(undefined, { foo_bar: 1 })).toEqual({ foo_bar: 1 });
  });
});
