import { Alert, Button, Card, Center, Divider, List, Modal, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAuth } from "../auth/auth";
import {
  type DeleteLocalDataOutcome,
  type DeletionResult,
  readLocalDataWipeOutcome,
  requestLocalDataWipe,
} from "../board/local-data";
import {
  applyStoragePreferences,
  type BackendPreference,
  type DurabilityPreference,
  readBackendPreference,
  readDurabilityPreference,
} from "../board/storage-preference";
import { boardStoreRegistry, retireBoardWorkers } from "../board/store-registry-default";

// The seeded demo identities (scripts/seed-board.ts). Each signs in with a real GoTrue password; the
// note is the membership the read path will scope them to — handy for eyeballing the fan-out.
const IDENTITIES: ReadonlyArray<{ email: string; name: string; note: string; admin?: boolean }> = [
  { email: "alice@board.local", name: "Alice Okafor", note: "Platform · Growth" },
  { email: "bob@board.local", name: "Bob Nilsson", note: "Platform" },
  { email: "carol@board.local", name: "Carol Mensah", note: "Platform" },
  { email: "dave@board.local", name: "Dave Ibarra", note: "Growth" },
  { email: "erin@board.local", name: "Erin Flores", note: "Growth" },
  { email: "frank@board.local", name: "Frank Petrov", note: "Design" },
  { email: "grace@board.local", name: "Grace Lindqvist", note: "Design" },
  { email: "heidi@board.local", name: "Heidi Park", note: "Design" },
  { email: "admin@board.local", name: "Admin", note: "all teams (admin bypass)", admin: true },
];

export function LoginRoute() {
  const { session, loading, signingOut, signInAs } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The storage preferences (durability + backend). The PERSISTED values are read exactly once at mount (the
  // worker identity is keyed on the worker name, which embeds `?durability=<dur>&backend=<backend>`, so the spare
  // already ensured above was constructed with them — see ./board/storage-preference); the `selected*` values are
  // the pending UI choices. A choice differing from the persisted value is applied by retiring this tab's workers
  // before writing localStorage + reloading, so an extended-lifetime worker under the old name cannot retain the
  // store while the replacement opens it. One "Apply & reload" button covers BOTH axes.
  const [persistedDurability] = useState<DurabilityPreference>(() => readDurabilityPreference());
  const [selectedDurability, setSelectedDurability] = useState<DurabilityPreference>(persistedDurability);
  const [persistedBackend] = useState<BackendPreference>(() => readBackendPreference());
  const [selectedBackend, setSelectedBackend] = useState<BackendPreference>(persistedBackend);
  const [applyingPreferences, setApplyingPreferences] = useState(false);
  const preferencesChanged = selectedDurability !== persistedDurability || selectedBackend !== persistedBackend;

  const handleApplyPreferences = async () => {
    setApplyingPreferences(true);
    setError(null);
    try {
      await retireBoardWorkers();
      applyStoragePreferences(selectedDurability, selectedBackend);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setApplyingPreferences(false);
    }
  };

  // "Delete local data" confirm flow — WIPE-ON-BOOT (see local-data.ts): this page's own spare
  // SharedWorker holds the stores and a tab cannot terminate a SharedWorker, so an in-place wipe can only
  // hang. Confirming flags the wipe and reloads; the reload kills this page's workers, the wipe runs at
  // the next boot before any worker exists, and the outcome lands back here via sessionStorage — read
  // once at mount, and surfaced (success note or per-target failures) so nothing is silently swallowed.
  const [deleteModalOpen, deleteModal] = useDisclosure(false);
  const [deleting, setDeleting] = useState(false);
  const [wipeOutcome] = useState<DeleteLocalDataOutcome | null>(() => readLocalDataWipeOutcome());
  const wipeFailures: DeletionResult[] = wipeOutcome?.results.filter((result) => !result.ok) ?? [];

  const handleDeleteLocalData = () => {
    // The spinner only bridges the instant until the reload tears the page down.
    setDeleting(true);
    requestLocalDataWipe();
  };

  // Ensure a spare store while the user reads the identity list and decides who to sign in as (board
  // optimisations A + B). This GCs orphaned stores, then eagerly creates an anonymous PGlite store under a
  // generated id — which itself consumes the WASM warm (~2.5s cold) AND pays PGlite's ~1.9s initdb/IDBFS
  // open — so the post-sign-in boot only binds the (already-created) store and applies schema, instead of
  // paying either cost on the critical path. Fire-and-forget and idempotent; any failure is swallowed and
  // sign-in falls back to the deterministic per-user store.
  //
  // Gated on auth having RESOLVED to no session: the spare is only ever consumed by a login from this
  // screen, and PGlite runs its initdb WASM on the MAIN thread — a signed-in remount (the post-login
  // redirect passes through here) would otherwise mint the next spare's ~1.9s of initdb right while the
  // board is doing its first renders and live-query reads on that same thread. An anonymous revisit
  // (logout, user switch) still lands here with no session and mints the next spare then — exactly when
  // it can be needed.
  //
  // The `!loading` guard closes a reload race: on a SIGNED-IN reload that passes through this route,
  // `session` is momentarily null while the initial `getSession()` is in flight (it resolves async from
  // localStorage), so the bare `!session` test would mint a spare anyway — burning ~2.8s of main-thread
  // initdb that blocks React from mounting the board provider until it finished. Waiting for auth to
  // settle means a signed-in reload never mints; only a resolved anonymous visitor does.
  useEffect(() => {
    if (!loading && !session) void boardStoreRegistry.ensureSpare();
  }, [loading, session]);

  useEffect(() => {
    // During sign-out the authenticated provider deliberately remains mounted until this navigation has
    // committed. Do not bounce that transition back to `/`; AuthProvider clears the old session afterwards.
    if (session && !signingOut) void navigate({ to: "/" });
  }, [session, signingOut, navigate]);

  const handleSignIn = async (email: string) => {
    setPending(email);
    setError(null);
    try {
      await signInAs(email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(null);
    }
  };

  return (
    // `mih` (not `h`): the sign-in card is tall (nine identities + the durability + backend + local-data panels), so a fixed
    // 70vh would center it and OVERFLOW upward under the 56px AppShell header, covering the top identity button.
    // A min-height lets the container grow with the card (the page scrolls) instead, keeping every control clickable.
    <Center mih="70vh">
      <Card withBorder w={440} padding="lg" radius="md">
        <Stack>
          <div>
            <Title order={3}>Sign in to the board</Title>
            <Text size="sm" c="dimmed">
              One-click demo identities, seeded through the GoTrue admin API. Each signs in with a real password — the
              edge functions verify the access token, so the read path is scoped to the identity you pick.
            </Text>
          </div>

          {error != null && (
            <Alert color="red" title="Sign-in failed" variant="light">
              {error}
              <Text size="xs" mt={4}>
                Is the stack up (`bun run infra:up`) and seeded (`bun run seed:board`)?
              </Text>
            </Alert>
          )}

          <Stack gap="xs">
            {IDENTITIES.map((identity) => (
              <Button
                key={identity.email}
                variant={identity.admin ? "filled" : "default"}
                justify="space-between"
                fullWidth
                rightSection={
                  <Text span size="xs" {...(identity.admin ? {} : { c: "dimmed" })}>
                    {identity.note}
                  </Text>
                }
                loading={pending === identity.email}
                disabled={pending != null && pending !== identity.email}
                onClick={() => void handleSignIn(identity.email)}
              >
                {identity.name}
              </Button>
            ))}
          </Stack>

          <Divider label="Durability" labelPosition="center" />

          <Stack gap="xs" aria-label="Durability preference">
            <SegmentedControl
              fullWidth
              size="xs"
              value={selectedDurability}
              onChange={(value) => setSelectedDurability(value as DurabilityPreference)}
              data={[
                { value: "relaxed", label: "Relaxed" },
                { value: "strict", label: "Strict" },
              ]}
            />
            <Text size="xs" c="dimmed">
              <strong>Relaxed</strong> (the default) is plenty durable for a demo: writes go through to storage
              immediately — only the per-commit flush is deferred, so a crash risks at most the last write or two.
              <strong>Strict</strong> forces a flush on every commit; on IndexedDB that costs 100ms+ per write. Your
              choice — the toolkit names the slow combination rather than forbidding it.
            </Text>
          </Stack>

          <Divider label="Storage backend" labelPosition="center" />

          <Stack gap="xs" aria-label="Storage backend preference">
            <SegmentedControl
              fullWidth
              size="xs"
              value={selectedBackend}
              onChange={(value) => setSelectedBackend(value as BackendPreference)}
              data={[
                { value: "opfs", label: "OPFS (default)" },
                { value: "idbfs", label: "Force idbfs" },
              ]}
            />
            <Text size="xs" c="dimmed">
              <strong>OPFS</strong> (the default) lets the engine probe for an Origin Private File System home and run
              there, falling back to IndexedDB where the browser cannot. <strong>Force idbfs</strong> opts out of that
              probe entirely and pins the engine to IndexedDB — handy for comparing backends or reproducing the idb path
              on a browser that would otherwise pick OPFS.
            </Text>
          </Stack>

          {preferencesChanged && (
            <Button
              size="xs"
              variant="light"
              loading={applyingPreferences}
              onClick={() => void handleApplyPreferences()}
            >
              Apply &amp; reload
            </Button>
          )}

          <Divider label="Local data" labelPosition="center" />

          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              Wipe every local board store on this browser profile — the demo's IndexedDB stores — without digging into
              browser settings.
            </Text>
            <Button size="xs" color="red" variant="light" onClick={deleteModal.open}>
              Delete local data…
            </Button>

            {wipeOutcome != null && wipeFailures.length === 0 && (
              <Alert color="green" title="Local data deleted" variant="light">
                <Text size="xs">Every local board store and binding on this browser profile was removed.</Text>
              </Alert>
            )}
            {wipeFailures.length > 0 && (
              <Alert color="red" title="Some data could not be deleted" variant="light">
                <List size="xs" spacing={4}>
                  {wipeFailures.map((failure) => (
                    <List.Item key={failure.target}>
                      {failure.target}
                      {failure.detail != null ? ` — ${failure.detail}` : ""}
                    </List.Item>
                  ))}
                </List>
                <Text size="xs" mt={4}>
                  Close other board tabs and try again.
                </Text>
              </Alert>
            )}
          </Stack>
        </Stack>
      </Card>

      <Modal opened={deleteModalOpen} onClose={deleteModal.close} title="Delete all local board data?" centered>
        <Stack>
          <Text size="sm">
            This deletes <strong>all local board data on this browser profile</strong> — every PGlite IndexedDB store
            and the board's stored bindings. <strong>Unflushed writes are lost.</strong>
          </Text>
          <Text size="sm">
            The page reloads first — that releases the stores this page's own engine is holding — and the deletion runs
            as the app restarts. Close any other open board tabs: their engines still hold their stores, and anything
            that could not be deleted is reported here after the reload.
          </Text>

          <Stack gap="xs">
            <Button color="red" loading={deleting} onClick={handleDeleteLocalData}>
              Delete local data
            </Button>
            <Button variant="default" disabled={deleting} onClick={deleteModal.close}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Modal>
    </Center>
  );
}
