import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { createSyncClient } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable, type RegistryViews } from "@pgxsinkit/contracts";

// Compile-time probes for `RegistryViews` — the typed surface behind `client.views`, the reactive
// read model the published docs advertise (`c.views.todos`). They pin that a readwrite entry's
// read-model view IS exposed with its projected column types, and that view-less entries (readonly
// mode) stay filtered out. Regression guarded: `defineSyncTable` used to add `view` via a
// conditional spread, so the inferred entry type carried it as an OPTIONAL property and the
// `extends { view: AnyPgView }` filter rejected every key — `RegistryViews` was always `{}`;
// runtime worked, but no typed consumer could compile `client.views.<name>` (caught by the packed
// fixture's consumer typecheck, ADR-0037 §4).

const viewsRegistry = defineSyncRegistry({
  writable: defineSyncTable({
    tableName: "writable_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
  }),
  reference: defineSyncTable({
    tableName: "reference_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    }),
    mode: "readonly",
  }),
});

type Views = RegistryViews<typeof viewsRegistry>;

// The readwrite entry's view survives the filter…
const writableView: Views["writable"] = viewsRegistry.writable.view;
// …and the readonly entry does not.
// @ts-expect-error a readonly entry has no read-model view
const referenceView: Views["reference"] = undefined;

async function checkViews() {
  const client = await createSyncClient({
    registry: viewsRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    batchWriteUrl: "http://localhost:3001/api/mutations",
  });

  // The documented reactive-read pattern: select from the typed read-model view.
  const rows = await client.drizzle.select().from(client.views.writable);
  const first = rows[0];
  if (first) {
    // Projected columns keep their types through the view…
    const label: string = first.label;
    const updatedAtUs: bigint = first.updatedAtUs;
    // …and the overlay bookkeeping columns the read model adds are typed too.
    const overlayKind: string = first.overlay_kind;
    void [label, updatedAtUs, overlayKind];
  }

  // @ts-expect-error only entries with a read-model view appear on client.views
  void client.views.reference;
}

void writableView;
void referenceView;
void checkViews;
