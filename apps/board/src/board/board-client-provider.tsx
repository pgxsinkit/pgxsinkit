import { Center, Group, Image, Loader, Stack, Text } from "@mantine/core";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { syncDebug } from "@pgxsinkit/client";
import type { SyncRuntimeStatus } from "@pgxsinkit/contracts";

import bannerAvif from "../../../../brand/banner/banner.avif";
import bannerPng from "../../../../brand/banner/banner.png";
import bannerWebp from "../../../../brand/banner/banner.webp";
// Brand assets (same images as the README and the docs-site hero), imported from the repo-level
// `brand/` source so there is a single copy — Vite fingerprints and bundles them. The lockup sits on
// a single ink plate: the symbol is transparent (dark-surface colours) and the dark wordmark's baked
// ink background matches the plate exactly, so mark and name read as one connected piece — in both
// colour schemes, no seams.
import { pgxsinkitBrand } from "../../../../brand/brand-tokens";
import syncMarkDark from "../../../../brand/svg/pgxsinkit-symbol-dark.svg";
import wordmarkDark from "../../../../brand/svg/pgxsinkit-wordmark-dark.svg";
import { createBoardSyncClient, resetBoardBootReport, SyncClientProvider } from "../board-client";
import type { OfflineControl } from "./offline";
import { createPgliteProfiler } from "./pglite-profiler";

type BoardSyncClient = Awaited<ReturnType<typeof createBoardSyncClient>>["client"];

// The live sync status (booting/syncing/ready/degraded/auth-needed) for the header badge. Defaults to
// `null` so a component may read it outside the provider (e.g. the header on the login screen) without
// throwing — it simply renders nothing.
const BoardSyncStatusContext = createContext<SyncRuntimeStatus | null>(null);
// The Offline toggle control (board Phase 8). `null` outside the provider (login screen).
const BoardOfflineContext = createContext<OfflineControl | null>(null);

export function useBoardSyncStatus(): SyncRuntimeStatus | null {
  return useContext(BoardSyncStatusContext);
}

export function useBoardOffline(): OfflineControl | null {
  return useContext(BoardOfflineContext);
}

/**
 * Boots the board's sync client for the signed-in identity: opens the local PGlite store, applies the
 * registry schema, and starts streaming the `board-sync` shapes the identity is allowed to see. Mount
 * it keyed by `userId` so each identity gets its own local store. Children render once the client is
 * ready; rows then arrive reactively (`useLiveRows`) as the initial sync streams in.
 */
export function BoardClientProvider({
  userId,
  isAdmin,
  children,
}: {
  userId: string;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const [client, setClient] = useState<BoardSyncClient | null>(null);
  const [offline, setOffline] = useState<OfflineControl | null>(null);
  const [status, setStatus] = useState<SyncRuntimeStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    let created: BoardSyncClient | undefined;
    setClient(null);
    setOffline(null);
    setStatus(null);
    setError(null);

    void (async () => {
      try {
        // Boot rail: mark the app-side moment between auth settling and client creation, so the delay
        // before the library's own `boot pglite.create` stamp is attributable to app code, not sync.
        syncDebug("boot board client create start");
        const {
          client: next,
          offline: nextOffline,
          mode,
        } = await createBoardSyncClient(userId, isAdmin, (value) => {
          if (active) setStatus(value);
        });
        // ADR-0041 (Option B): paint the shell at LOCAL-READ readiness, not full boot. `createBoardSyncClient`
        // already resolves at `localReadReady` (attach / the in-process constructor now resolve there), so the
        // cached rows in the warm store are queryable immediately — offline too. Per-view loading is driven by
        // `hydrating`/`groupReady` (the live-rows hooks); whole-sync catch-up rides `ready`/the status badge, not
        // this gate. We no longer `await next.ready` here — that re-coupled first paint to sync start + network.
        await next.localReadReady;
        if (!active) {
          void next.stop();
          return;
        }
        created = next;
        setOffline(nextOffline);
        // Dev-only console handles. `__boardClient` pokes the live client (stage a conflict, inspect
        // convergence, flush on demand); `__boardProfiler` is the aggregated PGlite query profiler
        // (start()/stop() → which statements cost what — the managed alternative to PGlite's
        // all-or-nothing logging). Never shipped — gated on the Vite dev build, plus the e2e lane's
        // PRODUCTION build (`VITE_E2E=1`, set only by the `e2e:board:serve` script: the Playwright
        // scenarios introspect through these handles, and the lane deliberately tests the built
        // artifact). In WORKER mode the PGlite lives in the SharedWorker (ADR-0032), so the tab has no
        // direct `pglite` to profile — expose the attach client but skip the profiler (the queries run
        // off-thread; profile them via the worker).
        if (import.meta.env.DEV || import.meta.env["VITE_E2E"] === "1") {
          const dev = globalThis as typeof globalThis & {
            __boardClient?: BoardSyncClient;
            __boardProfiler?: ReturnType<typeof createPgliteProfiler>;
            __pgxsinkitE2eClient?: BoardSyncClient;
          };
          dev.__boardClient = next;
          // The full live client for the worker e2e lane's one-shot-read probes (board-worker.e2e.test.ts) —
          // `query` / a bare `drizzle` read / `isSynced`. A dedicated handle beside `__boardClient` (which the
          // scenarios type down to just `mutate`) following the boot-report stash precedent in board-client.ts.
          dev.__pgxsinkitE2eClient = next;
          if (mode === "in-process") dev.__boardProfiler = createPgliteProfiler(next.pglite);
        }
        setStatus(next.status);
        setClient(next);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    })();

    return () => {
      active = false;
      if (created) void created.stop();
      // An identity switch boots a new store — never let the previous boot's report replay into the next
      // identity's subscribers.
      resetBoardBootReport();
      if (import.meta.env.DEV || import.meta.env["VITE_E2E"] === "1") {
        const dev = globalThis as typeof globalThis & {
          __boardClient?: BoardSyncClient;
          __boardProfiler?: ReturnType<typeof createPgliteProfiler>;
          __boardBootReport?: unknown;
          __pgxsinkitE2eClient?: BoardSyncClient;
        };
        delete dev.__boardClient;
        delete dev.__boardProfiler;
        delete dev.__pgxsinkitE2eClient;
        // The boot report is stashed in board-client's reportBoot (ADR-0034 dogfood); clear it on unmount
        // so a stale boot doesn't outlive an identity switch.
        delete dev.__boardBootReport;
      }
    };
  }, [userId, isAdmin]);

  if (error) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="xs" maw={420}>
          <Text c="red" fw={600}>
            Could not start the local sync engine
          </Text>
          <Text c="dimmed" size="sm" ta="center">
            {error.message}
          </Text>
        </Stack>
      </Center>
    );
  }

  if (!client) {
    return (
      <Center h="60vh">
        <Stack align="center" gap="md" w="100%" maw={640} px="md">
          <Group
            w="100%"
            p="md"
            gap="3%"
            wrap="nowrap"
            justify="center"
            align="center"
            bg={pgxsinkitBrand.ink}
            style={{ borderRadius: "var(--mantine-radius-md)" }}
          >
            <Image src={syncMarkDark} alt="" w="12%" h="auto" />
            <Image src={wordmarkDark} alt="pgxsinkit" w="80%" h="auto" />
          </Group>
          <picture style={{ width: "100%" }}>
            <source srcSet={bannerAvif} type="image/avif" />
            <source srcSet={bannerWebp} type="image/webp" />
            <img src={bannerPng} alt="" style={{ width: "100%", height: "auto", display: "block" }} />
          </picture>
          <Loader />
          <Text c="dimmed" size="sm">
            Starting local database…
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <BoardSyncStatusContext.Provider value={status}>
      <BoardOfflineContext.Provider value={offline}>
        <SyncClientProvider client={client}>{children}</SyncClientProvider>
      </BoardOfflineContext.Provider>
    </BoardSyncStatusContext.Provider>
  );
}
