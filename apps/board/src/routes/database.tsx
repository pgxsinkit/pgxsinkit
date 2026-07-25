import type { PGlite } from "@electric-sql/pglite";
import { Center, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { lazy, Suspense } from "react";

import { replAdapter } from "@pgxsinkit/client";

import { useSyncClient } from "../board-client";
import { SchemaOverview } from "../board/schema-overview";
import { useIsTouch } from "../lib/use-touch";

// `@electric-sql/pglite-repl` pulls in CodeMirror + psql-describe, so load it only when this tab is
// opened — the board's initial bundle stays lean and the REPL's heavy editor deps are deferred.
const Repl = lazy(() => import("@electric-sql/pglite-repl").then((module) => ({ default: module.Repl })));

/**
 * A SQL REPL over the signed-in identity's LOCAL PGlite store. What you can query here is exactly what the
 * read path synced to you (RLS-scoped via `board-sync`), so it doubles as a window onto the read-path
 * scoping the rest of the demo asserts. The REPL is fed the client's `rawQuery`/`rawExec` inspection
 * surface via `replAdapter` (not `client.pglite`, which is unavailable in worker mode) — in worker mode
 * that routes each statement through the sync bridge. The REPL follows the OS colour scheme to match the
 * board's `defaultColorScheme="auto"`.
 *
 * Note: statements run raw against PGlite — a write here bypasses the mutation journal / optimistic
 * overlay, so it stays local and will not converge. It's an inspection tool, not a write path.
 */
export function DatabaseRoute() {
  const client = useSyncClient();
  const isTouch = useIsTouch();
  return (
    <Stack gap="md">
      <div>
        <Title order={2}>Local database</Title>
        <Text c="dimmed" size="sm">
          A SQL REPL over your local PGlite store — the rows the read path has synced to you. Try{" "}
          <Text span ff="monospace" size="sm">
            select * from issue;
          </Text>
          . Writes run raw and bypass the sync journal, so use this to inspect, not to mutate shared state.
        </Text>
      </div>
      {isTouch ? (
        // Touch (docs/mobile.md): the REPL's problem is typing SQL on a soft keyboard, not pixels — hence
        // the capability gate, not a width one. Not rendering `<Repl>` also means the lazy CodeMirror +
        // psql-describe chunk is never fetched on a phone. The schema map below stays on every device.
        <Paper withBorder p="md" radius="md">
          <Text size="sm" c="dimmed">
            The interactive SQL REPL needs a desktop browser — open the demo there to poke at your local store.
          </Text>
        </Paper>
      ) : (
        <Suspense
          fallback={
            <Center h={200}>
              <Loader />
            </Center>
          }
        >
          {/* The REPL prop wants a full `PGlite`, but drives only `.query`/`.exec`; the adapter satisfies both
              and routes through the bridge in worker mode. Minimal structural cast at the seam. */}
          <Repl pg={replAdapter(client) as unknown as PGlite} theme="auto" border showTime />
        </Suspense>
      )}
      <SchemaOverview />
    </Stack>
  );
}
