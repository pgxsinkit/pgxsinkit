import { Badge, Button, Drawer, Group, ScrollArea, Stack, Switch, Table, Text } from "@mantine/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { LiveQueryDiagnostics, MutationDetail } from "@pgxsinkit/client";

import { useSyncClient } from "../board-client";
import { useBoardOffline } from "./board-client-provider";
import type { OfflineControl } from "./offline";

// In-flight mutation statuses, grouped for the counters. `acked` rows are cleared by reconcile, so they
// only flash through the journal briefly on their way out.
const PENDING_STATUSES = new Set(["pending", "sending", "failed"]);

const STATUS_COLOR: Record<string, string> = {
  pending: "yellow",
  sending: "blue",
  failed: "orange",
  acked: "teal",
  conflicted: "orange",
  quarantined: "red",
};

/** Subscribe to the Offline toggle's online flag (board Phase 8). */
function useOnline(offline: OfflineControl | null): boolean {
  const subscribe = useCallback((onChange: () => void) => offline?.subscribe(onChange) ?? (() => {}), [offline]);
  return useSyncExternalStore(
    subscribe,
    () => offline?.isOnline() ?? true,
    () => true,
  );
}

/**
 * Subscribe to the registry-wide mutation journal while the inspector is open (pgxsinkit slice 4). This
 * replaced an 800 ms `readMutationDetails` poll: `client.mutations.subscribe` is a LIVE query over the
 * cross-journal `pgxsinkit_all_mutations` view, so a diff surfaces every pending → sending → acked → cleared
 * transition the instant it lands — catching the brief acked-flash on its way out that a poll could miss
 * between frames. One subscription across every writable table; idle (unsubscribed) when the drawer is closed.
 */
function useJournal(enabled: boolean): MutationDetail[] {
  const client = useSyncClient();
  const [rows, setRows] = useState<MutationDetail[]>([]);
  useEffect(() => {
    if (!enabled) {
      setRows([]);
      return;
    }
    let active = true;
    let subscription: { unsubscribe: () => void } | undefined;
    void client.mutations
      .subscribe({}, (next) => {
        if (active) setRows(next);
      })
      .then((registered) => {
        if (!active) {
          registered.unsubscribe();
          return;
        }
        subscription = registered;
        setRows(registered.initial);
      })
      .catch(() => {
        // A transient subscribe error (e.g. mid-teardown) just leaves the last rows in place.
      });
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [enabled, client]);
  return rows;
}

/**
 * Poll the live-query manager's diagnostics snapshot while the inspector is open (pgxsinkit ADR-0040
 * decision 5). `liveQueryDiagnostics` is a point-in-time snapshot (not itself a live query), so a short
 * poll surfaces subscribe/dedup/retain/teardown transitions as they happen — this is the human-visible
 * dogfood of the same per-entry counts the two-tab e2e asserts. Digests + counts only; NEVER SQL text,
 * bound params, or result rows. Idle when the drawer is closed (no polling, no snapshot cost).
 */
function useLiveQueries(enabled: boolean): LiveQueryDiagnostics[] {
  const client = useSyncClient();
  const [entries, setEntries] = useState<LiveQueryDiagnostics[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const poll = async () => {
      try {
        const snapshot = await client.liveQueryDiagnostics();
        if (active) setEntries(snapshot);
      } catch {
        // A transient read error (e.g. mid-teardown) just skips a frame.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, client]);
  return entries;
}

// Active entries first (busiest by subscriber count), then retained zero-subscriber ones — so the
// switch-back grace windows sink to the bottom of the panel.
function sortLiveQueries(entries: readonly LiveQueryDiagnostics[]): LiveQueryDiagnostics[] {
  return [...entries].sort((a, b) => {
    if (a.retained !== b.retained) return a.retained ? 1 : -1;
    return b.subscriberCount - a.subscriberCount;
  });
}

function shortKey(entityKey: Record<string, string>): string {
  const value = Object.values(entityKey)[0] ?? "";
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/**
 * The Sync Inspector (board Phase 8): an always-visible Offline toggle plus a collapsible drawer over
 * the local mutation journal and convergence counters. The default board stays clean — the guts are
 * one click away. Toggling Offline pauses the outbound convergence driver, so writes pile up here as
 * `pending`; toggling back Online flushes and they drain to converged.
 */
export function SyncInspector() {
  const offline = useBoardOffline();
  const client = useSyncClient();
  const [open, setOpen] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const online = useOnline(offline);
  const journal = useJournal(open);
  const liveQueries = sortLiveQueries(useLiveQueries(open));

  const pending = journal.filter((row) => PENDING_STATUSES.has(row.status)).length;
  const conflicted = journal.filter((row) => row.status === "conflicted").length;
  const quarantined = journal.filter((row) => row.status === "quarantined").length;
  const owed = pending + conflicted + quarantined;

  const flushNow = async () => {
    setFlushing(true);
    try {
      await client.flush();
      await client.reconcile();
    } finally {
      setFlushing(false);
    }
  };

  return (
    <>
      <Group gap="sm" wrap="nowrap">
        <Switch
          size="sm"
          checked={online}
          onChange={(event) => offline?.setOnline(event.currentTarget.checked)}
          onLabel="ON"
          offLabel="OFF"
          color="teal"
          label={online ? "Online" : "Offline"}
          aria-label="Toggle simulated network"
        />
        <Button size="xs" variant="default" onClick={() => setOpen(true)}>
          Inspector{owed > 0 ? ` (${owed})` : ""}
        </Button>
      </Group>

      <Drawer
        opened={open}
        onClose={() => setOpen(false)}
        position="right"
        size="md"
        title="Sync inspector"
        padding="md"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            The local mutation journal — every write that has not yet converged. {online ? "Online" : "Offline"}:{" "}
            {online ? "changes flush as you make them." : "changes queue here until you reconnect."}
          </Text>

          <Group gap="xs">
            <Badge color="yellow" variant="light">
              {pending} pending
            </Badge>
            <Badge color="orange" variant="light">
              {conflicted} conflicted
            </Badge>
            <Badge color="red" variant="light">
              {quarantined} quarantined
            </Badge>
          </Group>

          <Group gap="sm">
            <Switch
              size="sm"
              checked={online}
              onChange={(event) => offline?.setOnline(event.currentTarget.checked)}
              onLabel="ON"
              offLabel="OFF"
              color="teal"
              label={online ? "Online" : "Offline"}
            />
            <Button size="xs" variant="light" onClick={() => void flushNow()} loading={flushing} disabled={!online}>
              Flush now
            </Button>
          </Group>

          {journal.length === 0 ? (
            <Text size="sm" c="dimmed">
              All changes synced — nothing in the journal.
            </Text>
          ) : (
            <ScrollArea.Autosize mah="60vh">
              <Table stickyHeader striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Table</Table.Th>
                    <Table.Th>Op</Table.Th>
                    <Table.Th>Entity</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {journal.map((row) => (
                    <Table.Tr key={row.mutationId}>
                      <Table.Td>{row.tableName}</Table.Td>
                      <Table.Td>{row.mutationKind}</Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {shortKey(row.entityKey)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={STATUS_COLOR[row.status] ?? "gray"}>
                          {row.status}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}

          {/*
            Live queries (ADR-0040 decision 5): the human-visible dogfood of the live-query manager's
            diagnostics — the same per-entry counts the two-tab e2e asserts. Digests only, NEVER SQL,
            params, or rows. Dedup hits climb as tabs/components share a registration; a `retained` badge
            marks a zero-subscriber query still in its keep-alive grace window (data.ts hot reads).
          */}
          <Text size="sm" fw={600}>
            Live queries
          </Text>
          {liveQueries.length === 0 ? (
            <Text size="sm" c="dimmed">
              No live queries registered.
            </Text>
          ) : (
            <ScrollArea.Autosize mah="40vh">
              <Table stickyHeader striped withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Digest</Table.Th>
                    <Table.Th>Subs</Table.Th>
                    <Table.Th>Tabs</Table.Th>
                    <Table.Th>Rows</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Dedup</Table.Th>
                    <Table.Th>Setup</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {liveQueries.map((q) => (
                    <Table.Tr key={q.digest}>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {q.digest}
                        </Text>
                      </Table.Td>
                      <Table.Td>{q.subscriberCount}</Table.Td>
                      <Table.Td>{q.scopeCount}</Table.Td>
                      <Table.Td>{q.rowCount}</Table.Td>
                      <Table.Td>
                        {q.retained ? (
                          <Badge size="sm" variant="light" color="grape">
                            retained {Math.round((q.retainedSinceMs ?? 0) / 1000)}s
                          </Badge>
                        ) : (
                          <Badge size="sm" variant="light" color="teal">
                            active
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>{q.dedupHits}</Table.Td>
                      <Table.Td>{q.setupMs == null ? "—" : `${Math.round(q.setupMs)}ms`}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
