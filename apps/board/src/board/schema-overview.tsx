import { Badge, Button, Group, Paper, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import { count, eq, like, or, sql } from "drizzle-orm";
import { pgSchema, text, union, type AnyPgTable } from "drizzle-orm/pg-core";
import { useEffect, useMemo, useState } from "react";

import { boardMemberRegistry, boardSyncRegistry } from "@pgxsinkit/board-schema";
import { getSyncedLocalTable } from "@pgxsinkit/client";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { useAuth } from "../auth/auth";
import { useSyncClient } from "../board-client";

// Tiny Drizzle stubs over the information_schema relations the presence probe reads (tier ①:
// rename-safe column objects, typed params). They are query-authoring objects only — this catalog is
// Postgres-owned, so they are never DDL/migration inputs.
const informationSchema = pgSchema("information_schema");
const catalogTables = informationSchema.table("tables", {
  tableName: text("table_name").notNull(),
  tableSchema: text("table_schema").notNull(),
});
const catalogSequences = informationSchema.table("sequences", {
  sequenceName: text("sequence_name").notNull(),
  sequenceSchema: text("sequence_schema").notNull(),
});
const catalogTriggers = informationSchema.table("triggers", {
  triggerName: text("trigger_name").notNull(),
  triggerSchema: text("trigger_schema").notNull(),
});

// The runtime shape we read off each registry entry. The registry resolves `clientProjection` to the
// concrete local object names (ADR-0009), so the per-table cluster is fully derivable here.
interface RegistryEntryShape {
  mode: "readonly" | "readwrite" | "writeonly";
  retention?: "persistent" | "ephemeral";
  clientProjection?: { syncedTable?: string; overlayTable?: string; journalTable?: string };
}

interface Entity {
  key: string;
  table: string;
  mode: RegistryEntryShape["mode"];
  /** `retention: "ephemeral"` — the whole local cluster is TEMP in `pg_temp` (ADR-0021 §3). */
  ephemeral: boolean;
  /** The synced local table as a Drizzle object (rename-safe), for the row-count probe below. */
  syncedLocalTable: AnyPgTable;
  overlay?: string;
  journal?: string;
  readModel?: string;
  syncState?: string;
}

// One row per "main" synced table, derived from the SIGNED-IN ROLE's registry — the roles project the
// same tables differently (a Member's `message` is `asEphemeral`, an Admin's is persistent), and this
// panel describes the store the active client actually provisioned. A readwrite table also carries the
// optimistic overlay + mutation journal and the two derived views; a readonly table is just the synced
// base table. Names follow the generator's conventions (overlay/journal from `clientProjection`,
// `_read_model` / `_sync_state` views), and every name is verified against the live catalog before it is
// shown, so nothing here can claim an object the store doesn't actually have.
function buildEntities(registry: SyncTableRegistry): Entity[] {
  return (Object.entries(registry) as unknown as [string, RegistryEntryShape][]).map(([key, entry]) => {
    const table = entry.clientProjection?.syncedTable ?? key;
    const ephemeral = entry.retention === "ephemeral";
    // The synced local table as a runtime Drizzle object — resolves the projection rename + the
    // registry's local schema, so the count query below tracks the same relation `table` names.
    const syncedLocalTable = getSyncedLocalTable(registry, key);
    if (entry.mode !== "readwrite") {
      return { key, table, mode: entry.mode, ephemeral, syncedLocalTable };
    }
    return {
      key,
      table,
      mode: entry.mode,
      ephemeral,
      syncedLocalTable,
      overlay: entry.clientProjection?.overlayTable ?? `${table}_overlay`,
      journal: entry.clientProjection?.journalTable ?? `${table}_mutations`,
      readModel: `${table}_read_model`,
      syncState: `${table}_sync_state`,
    };
  });
}

type ObjectKind = "table" | "view" | "sequence" | "trigger";

interface AssocObject {
  name: string;
  kind: ObjectKind;
  purpose: string;
}

const KIND_COLOR: Record<ObjectKind, string> = {
  table: "teal",
  view: "cyan",
  sequence: "grape",
  trigger: "orange",
};

function associatedObjects(entity: Entity): AssocObject[] {
  const base: AssocObject = {
    name: entity.table,
    kind: "table",
    purpose: "Synced rows from the server — Electric writes the read path into here.",
  };
  if (entity.mode !== "readwrite" || !entity.overlay || !entity.journal || !entity.readModel || !entity.syncState) {
    return [base];
  }
  return [
    base,
    { name: entity.overlay, kind: "table", purpose: "Optimistic local writes, awaiting the server echo." },
    { name: entity.journal, kind: "table", purpose: "The mutation journal (outbox): pending → sending → acked." },
    {
      name: `${entity.journal}_mutation_seq`,
      kind: "sequence",
      purpose: "Issues the monotonic mutation_seq that orders the journal.",
    },
    { name: entity.readModel, kind: "view", purpose: "What the app reads: synced rows ⊕ the overlay." },
    { name: entity.syncState, kind: "view", purpose: "Per-row convergence state (synced / pending / conflicted)." },
    {
      name: `${entity.table}_reconcile_on_sync`,
      kind: "trigger",
      purpose: "On the synced echo, clears the overlay + journal rows that have now converged.",
    },
  ];
}

function defaultKey(entities: Entity[]): string {
  return entities.find((entity) => entity.key === "issue")?.key ?? entities[0]?.key ?? "";
}

/**
 * A schema map of the local store, shown under the REPL on the Database tab. It lists the "main" synced
 * tables and, for whichever one is selected, the utility objects pgxsinkit keeps alongside it — the
 * optimistic overlay, the mutation journal + its sequence, the read-model / sync-state views, and the
 * reconcile trigger. Names and row counts come from the live PGlite catalog so it reflects what is
 * actually provisioned for this identity, not a hard-coded list.
 */
export function SchemaOverview() {
  const client = useSyncClient();
  const { isAdmin } = useAuth();
  // The signed-in role's registry — the panel must describe the store THIS client provisioned
  // (a Member's `message` is ephemeral; an Admin's is persistent).
  const entities = useMemo(
    () => buildEntities((isAdmin ? boardSyncRegistry : boardMemberRegistry) as SyncTableRegistry),
    [isAdmin],
  );
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [selectedKey, setSelectedKey] = useState<string>(() => defaultKey(entities));

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Introspection over the live catalog — tables + views (`information_schema.tables`), the journal
        // sequences (`…sequences`) and the reconcile triggers (`…triggers`, one row per event → DISTINCT) —
        // so every object the panel lists is verified to actually exist. Authored as tier-① Drizzle over
        // the catalog stubs above (`union` dedupes exactly like the SQL `UNION` it replaces), then
        // COMPILED (`.toSQL()`) and run through the client's inspection surface (`rawQuery`) rather than
        // executed on `client.drizzle` — which is build-only on a worker-attached client (ADR-0032 S2), so a
        // direct `await client.drizzle…` can never run there. Because Drizzle maps selection keys
        // CLIENT-side (a plain `select({ name: col })` emits no `AS "name"`), every selected field here
        // carries an explicit `.as(...)` so the raw rows keep the keys this code reads. The counts below
        // follow the same pattern.
        //
        // Tables also match `pg_temp%`: an ephemeral relation's cluster is TEMP in the session's pg_temp
        // schema (ADR-0021 §3) — invisible under `public`, which used to make a Member's `message` render
        // as absent (`—`) forever. The `\_` escapes LIKE's single-char wildcard (match a literal underscore).
        const catalogQuery = union(
          client.drizzle
            .select({ name: sql<string>`${catalogTables.tableName}`.as("name") })
            .from(catalogTables)
            .where(or(eq(catalogTables.tableSchema, "public"), like(catalogTables.tableSchema, "pg\\_temp%"))),
          client.drizzle
            .select({ name: sql<string>`${catalogSequences.sequenceName}`.as("name") })
            .from(catalogSequences)
            .where(eq(catalogSequences.sequenceSchema, "public")),
          client.drizzle
            .selectDistinct({ name: sql<string>`${catalogTriggers.triggerName}`.as("name") })
            .from(catalogTriggers)
            .where(eq(catalogTriggers.triggerSchema, "public")),
        ).toSQL();
        const catalog = await client.rawQuery(catalogQuery.sql, catalogQuery.params);
        const names = new Set((catalog.rows as { name?: unknown }[]).map((row) => String(row.name)));
        const countPairs = await Promise.all(
          entities.map(async (entity): Promise<[string, number | null]> => {
            if (!names.has(entity.table)) return [entity.table, null];
            try {
              const compiled = client.drizzle
                .select({ n: count().as("n") })
                .from(entity.syncedLocalTable)
                .toSQL();
              const result = await client.rawQuery(compiled.sql, compiled.params);
              // Postgres `count()` returns int8 — comes back as a string/bigint, never assume number.
              const n = Number((result.rows[0] as { n?: unknown })?.n ?? 0);
              return [entity.table, n];
            } catch {
              return [entity.table, null];
            }
          }),
        );
        if (!active) return;
        setPresent(names);
        setCounts(Object.fromEntries(countPairs));
      } catch {
        // A transient read error (e.g. mid-teardown) just leaves the panel on its previous snapshot.
      }
    })();
    return () => {
      active = false;
    };
  }, [client, entities]);

  const selected = entities.find((entity) => entity.key === selectedKey) ?? entities[0];
  const objects = selected
    ? associatedObjects(selected).filter((object) => present.size === 0 || present.has(object.name))
    : [];

  const countLabel = (table: string): string => {
    const value = counts[table];
    if (value === undefined) return "…";
    return value === null ? "—" : String(value);
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="md">
        <div>
          <Title order={3}>Tables in your local store</Title>
          <Text size="sm" c="dimmed">
            The main synced tables (counts are the rows synced to you). Pick one to see every object pgxsinkit maintains
            alongside it — tables, views, the journal sequence, and the reconcile trigger.
          </Text>
        </div>

        <Group gap="xs">
          {entities.map((entity) => {
            const button = (
              <Button
                key={entity.key}
                size="xs"
                variant={entity.key === selectedKey ? "filled" : "default"}
                onClick={() => setSelectedKey(entity.key)}
              >
                {entity.table} · {countLabel(entity.table)}
                {entity.ephemeral ? " · temp" : ""}
              </Button>
            );
            // Ephemeral (ADR-0021 §3): teach the retention mode instead of looking broken — the cluster
            // is TEMP in pg_temp, so the rows exist for this session only and leave no durable trace.
            return entity.ephemeral ? (
              <Tooltip
                key={entity.key}
                label="Ephemeral: this table lives in pg_temp for the current session only — its rows are never written to durable storage."
                maw={320}
                multiline
              >
                {button}
              </Tooltip>
            ) : (
              button
            );
          })}
        </Group>

        {selected && (
          <Stack gap="xs">
            <Group gap="xs">
              <Text size="sm" fw={600}>
                Objects for{" "}
                <Text span ff="monospace" size="sm">
                  {selected.table}
                </Text>
              </Text>
              <Badge size="sm" variant="light" color={selected.mode === "readwrite" ? "indigo" : "gray"}>
                {selected.mode}
              </Badge>
              {selected.ephemeral && (
                <Badge size="sm" variant="light" color="yellow">
                  ephemeral · pg_temp
                </Badge>
              )}
            </Group>

            <Table withTableBorder striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Object</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Purpose</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {objects.map((object) => (
                  <Table.Tr key={object.name}>
                    <Table.Td>
                      <Text ff="monospace" size="sm">
                        {object.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={KIND_COLOR[object.kind]}>
                        {object.kind}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {object.purpose}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            {selected.mode !== "readwrite" && (
              <Text size="xs" c="dimmed">
                Read-only — synced straight from the server, so it has no overlay, journal, sequence, views, or trigger.
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
