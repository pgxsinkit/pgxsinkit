import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { getReadModelView, getSyncedLocalTable } from "@pgxsinkit/client";
import { defineReadProjection, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

// Type-level coverage for `defineReadProjection` (ADR-0027): a projection entry's `getSyncedLocalTable` /
// `getReadModelView` must preserve the OWNER's per-column types restricted to the KEPT keys — no open
// index-signature collapse (which forced bracket-access + `!` in consumers). This file is typechecked by
// `tsc -p tsconfig.json`; the `@ts-expect-error` lines fail the build if the omission stops being typed.

// An owner that USES omitColumns (its `table` and `localTable` types differ) — the harder path.
const owner = defineSyncTable({
  tableName: "papers",
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    body: varchar("body", { length: 9000 }).notNull(),
    ownerId: uuid("owner_id"),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    lastOpId: uuid("last_op_id"),
  }),
  clientProjection: { omitColumns: ["lastOpId"] },
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

// A projection keeping only a light subset (PK deliberately NOT listed — kept at runtime, safe under-claim).
const summary = defineReadProjection(owner, {
  as: "papers_admin_summary",
  columns: ["title", "updatedAtUs"],
});

const projectionRegistry = defineSyncRegistry({ papers: owner, papersSummary: summary });

// --- The synced local table carries the owner's real per-column types for the KEPT keys. ---
const summarySynced = getSyncedLocalTable(projectionRegistry, "papersSummary");
type SummarySyncedRow = typeof summarySynced.$inferSelect;

// `title` is a kept varchar-NOT-NULL column → `string` (owner's type), reached by property key (no bracket + !).
const keptTitle: string = ({} as SummarySyncedRow).title;
// `updatedAtUs` is a kept `mode: "bigint"` column → `bigint` (owner's type), preserved through the subset.
const keptUpdatedAt: bigint = ({} as SummarySyncedRow).updatedAtUs;

// @ts-expect-error `body` is omitted from the projection subset — absent from the local table type
const omittedBody = ({} as SummarySyncedRow).body;
// @ts-expect-error `ownerId` is omitted from the projection subset — absent from the local table type
const omittedOwnerId = ({} as SummarySyncedRow).ownerId;

// --- The read-model view preserves the same typed subset (plus the fixed overlay columns). ---
const summaryReadModel = getReadModelView(projectionRegistry, "papersSummary");
type SummaryReadModelRow = typeof summaryReadModel.$inferSelect;

const viewTitle: string = ({} as SummaryReadModelRow).title;
// @ts-expect-error `body` is omitted from the projection subset — absent from the read-model view too
const viewOmittedBody = ({} as SummaryReadModelRow).body;

// A projection with NO `columns` keeps every owner (projected) column — `title` AND `body` present.
const full = defineReadProjection(owner, { as: "papers_full_mirror" });
const fullRegistry = defineSyncRegistry({ papers: owner, papersFull: full });
const fullSynced = getSyncedLocalTable(fullRegistry, "papersFull");
const fullTitle: string = ({} as typeof fullSynced.$inferSelect).title;
const fullBody: string = ({} as typeof fullSynced.$inferSelect).body;

// --- serverProjection + serverOnlyColumns (egress redaction) compile checks. ---
// A projection may declare a `serverProjection` alone (full-width egress redaction, no serverOnlyColumns).
const redactFull = defineReadProjection(owner, {
  as: "papers_redacted",
  serverProjection: { rowTransform: (row) => ({ ...row, body: null }) },
});

// `serverOnlyColumns` keys are constrained to OWNER keys; a good key (an owner column NOT in `columns`)
// compiles alongside a `serverProjection.rowTransform` that reads it.
const redactControlled = defineReadProjection(owner, {
  as: "papers_windowed",
  columns: ["title"],
  serverProjection: { rowTransform: (row) => (row["owner_id"] == null ? row : { ...row, body: null }) },
  serverOnlyColumns: ["ownerId"],
});

const redactBadKey = defineReadProjection(owner, {
  as: "papers_bad",
  columns: ["title"],
  serverProjection: { rowTransform: (row) => row },
  // @ts-expect-error `not_a_column` is not an owner key — serverOnlyColumns is constrained to owner keys
  serverOnlyColumns: ["not_a_column"],
});

// The `serverProjection` opt also accepts the literal `"unredacted"` — the explicit egress-raw opt-out
// the fail-closed guard requires over a redacting owner (type-level acceptance only; this file is not run).
const redactOptOut = defineReadProjection(owner, {
  as: "papers_unredacted",
  columns: ["title"],
  serverProjection: "unredacted",
});

const redactBadOptOut = defineReadProjection(owner, {
  as: "papers_bad_optout",
  columns: ["title"],
  // @ts-expect-error only the literal `"unredacted"` is accepted, not an arbitrary string
  serverProjection: "raw",
});

void keptTitle;
void keptUpdatedAt;
void omittedBody;
void omittedOwnerId;
void viewTitle;
void viewOmittedBody;
void fullTitle;
void fullBody;
void redactFull;
void redactControlled;
void redactBadKey;
void redactOptOut;
void redactBadOptOut;
