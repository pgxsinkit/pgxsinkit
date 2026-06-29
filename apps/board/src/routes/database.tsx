import { Center, Loader, Stack, Text, Title } from "@mantine/core";
import { lazy, Suspense } from "react";

import { useSyncClient } from "../board-client";

// `@electric-sql/pglite-repl` pulls in CodeMirror + psql-describe, so load it only when this tab is
// opened — the board's initial bundle stays lean and the REPL's heavy editor deps are deferred.
const Repl = lazy(() => import("@electric-sql/pglite-repl").then((module) => ({ default: module.Repl })));

/**
 * A SQL REPL over the signed-in identity's LOCAL PGlite store. What you can query here is exactly what the
 * read path synced to you (RLS-scoped via `board-sync`), so it doubles as a window onto the read-path
 * scoping the rest of the demo asserts. `pg` is the live client store; the REPL follows the OS colour
 * scheme to match the board's `defaultColorScheme="auto"`.
 *
 * Note: statements run raw against PGlite — a write here bypasses the mutation journal / optimistic
 * overlay, so it stays local and will not converge. It's an inspection tool, not a write path.
 */
export function DatabaseRoute() {
  const client = useSyncClient();
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
      <Suspense
        fallback={
          <Center h={200}>
            <Loader />
          </Center>
        }
      >
        <Repl pg={client.pglite} theme="auto" border showTime />
      </Suspense>
    </Stack>
  );
}
