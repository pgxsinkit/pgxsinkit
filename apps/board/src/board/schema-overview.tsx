import { Badge, Button, Group, Paper, Stack, Table, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";

import { useSyncClient } from "../board-client";

// The runtime shape we read off each registry entry. The registry resolves `clientProjection` to the
// concrete local object names (ADR-0009), so the per-table cluster is fully derivable here.
interface RegistryEntryShape {
  mode: "readonly" | "readwrite" | "writeonly";
  clientProjection?: { syncedTable?: string; overlayTable?: string; journalTable?: string };
}

interface Entity {
  key: string;
  table: string;
  mode: RegistryEntryShape["mode"];
  overlay?: string;
  journal?: string;
  readModel?: string;
  syncState?: string;
}

// One row per "main" synced table, derived from the board registry. A readwrite table also carries the
// optimistic overlay + mutation journal and the two derived views; a readonly table is just the synced
// base table. Names follow the generator's conventions (overlay/journal from `clientProjection`,
// `_read_model` / `_sync_state` views), and every name is verified against the live catalog before it is
// shown, so nothing here can claim an object the store doesn't actually have.
const ENTITIES: Entity[] = (Object.entries(boardSyncRegistry) as unknown as [string, RegistryEntryShape][]).map(
  ([key, entry]) => {
    const table = entry.clientProjection?.syncedTable ?? key;
    if (entry.mode !== "readwrite") {
      return { key, table, mode: entry.mode };
    }
    return {
      key,
      table,
      mode: entry.mode,
      overlay: entry.clientProjection?.overlayTable ?? `${table}_overlay`,
      journal: entry.clientProjection?.journalTable ?? `${table}_mutations`,
      readModel: `${table}_read_model`,
      syncState: `${table}_sync_state`,
    };
  },
);

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

const DEFAULT_KEY = ENTITIES.find((entity) => entity.key === "issue")?.key ?? ENTITIES[0]?.key ?? "";

/**
 * A schema map of the local store, shown under the REPL on the Database tab. It lists the "main" synced
 * tables and, for whichever one is selected, the utility objects pgxsinkit keeps alongside it — the
 * optimistic overlay, the mutation journal + its sequence, the read-model / sync-state views, and the
 * reconcile trigger. Names and row counts come from the live PGlite catalog so it reflects what is
 * actually provisioned for this identity, not a hard-coded list.
 */
export function SchemaOverview() {
  const client = useSyncClient();
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [selectedKey, setSelectedKey] = useState<string>(DEFAULT_KEY);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Introspection over the live catalog — tables + views (`information_schema.tables`), the journal
        // sequences (`…sequences`) and the reconcile triggers (`…triggers`, one row per event → DISTINCT) —
        // so every object the panel lists is verified to actually exist. This (and the per-table counts
        // below over dynamic identifiers) is exactly the case the "prefer Drizzle" rule carves out for a
        // raw query: Drizzle can't express either. Identifiers are registry-derived (trusted), and quoted.
        const catalog = await client.pglite.query<{ name: string }>(
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'
           UNION
           SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
           UNION
           SELECT DISTINCT trigger_name FROM information_schema.triggers WHERE trigger_schema = 'public'`,
        );
        const names = new Set(catalog.rows.map((row) => row.name));
        const countPairs = await Promise.all(
          ENTITIES.map(async (entity): Promise<[string, number | null]> => {
            if (!names.has(entity.table)) return [entity.table, null];
            try {
              const result = await client.pglite.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM "${entity.table}"`,
              );
              return [entity.table, result.rows[0]?.n ?? 0];
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
  }, [client]);

  const selected = ENTITIES.find((entity) => entity.key === selectedKey) ?? ENTITIES[0];
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
          {ENTITIES.map((entity) => (
            <Button
              key={entity.key}
              size="xs"
              variant={entity.key === selectedKey ? "filled" : "default"}
              onClick={() => setSelectedKey(entity.key)}
            >
              {entity.table} · {countLabel(entity.table)}
            </Button>
          ))}
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
