/// <reference lib="webworker" />
import { boardMemberRegistry, boardSyncRegistry } from "@pgxsinkit/board-schema";
import { defineSyncWorker } from "@pgxsinkit/client";
import { attachSyncRegistryStorage } from "@pgxsinkit/contracts";

import { boardConfig } from "../config";
import {
  backendPreferenceFromWorkerName,
  boardStorageDeclaration,
  durabilityPreferenceFromWorkerName,
} from "./storage-preference";

// Both storage preferences threaded through the worker's NAME as `<storePath>?durability=<dur>&backend=<backend>`
// by store-registry-default (a SharedWorker has no localStorage, and the script URL cannot carry a dynamic query —
// Vite's worker bundling requires the `new URL(...)` literal inline in the constructor, see the identity caveat in
// ./storage-preference). Read them back off `globalThis.name` — a SharedWorkerGlobalScope exposes the constructing
// tab's `name` — and coerce to valid preferences (durability default `relaxed`, backend default `opfs`). Because
// the name is part of the worker's dedup identity, every tab on one store agrees on the values by construction.
const workerName = (globalThis as { name?: string }).name ?? "";
const durability = durabilityPreferenceFromWorkerName(workerName);
const backend = backendPreferenceFromWorkerName(workerName);

// Storage (durability + backend) is registry-declared (ADR-0047; ADR-0049 decision 1). The worker bakes BOTH role
// registries and picks between them at claim/attach, and both mint stores for the SAME store path, so stamp the
// identical boot-read declaration onto each — the toolkit's mint seam (createSyncClient boot + the default
// provision factory) reads it back off the registry. `boardStorageDeclaration` produces the SAME shape the tab
// stamps (board-client's in-process fallback): `durability` always, `backend: "idbfs"` only when forced (the
// `opfs` default omits it). `attachSyncRegistryStorage` is idempotent for an equal re-declaration and throws on a
// conflicting one, so both sides MUST agree — which the shared helper guarantees.
const storage = boardStorageDeclaration(durability, backend);
attachSyncRegistryStorage(boardSyncRegistry, storage);
attachSyncRegistryStorage(boardMemberRegistry, storage);

// Dev-only: turn the toolkit's opt-in instrumentation on INSIDE the worker scope too (main.tsx does the
// same on the tab). `timeAsync`/`instrumentShapeFetch` gate their rail lines on this WORKER-scope flag, so
// without it the boot phase + shape-request stamps never reach the sink `defineSyncWorker` installs — only
// the unconditional `syncDebug` calls would cross. With it, the FULL boot rail (schema/journal/reconcile,
// the shape-request start, and the S4 `boot shape prefetch start` / `boot commits opened` overlap stamps)
// is forwarded to every tab and printed there as `[pgxsinkit·w …ms]`. Never on in a production build —
// except the e2e lane's (`VITE_E2E=1`), whose scenarios assert these rail lines on the built artifact.
if (import.meta.env.DEV || import.meta.env["VITE_E2E"] === "1") {
  (globalThis as { __pgxsinkitDebug?: boolean }).__pgxsinkitDebug = true;
}

// The board's SharedWorker entry (ADR-0032 S3). ONE sync engine per (user, store) runs here — PGlite, the
// schema, the mutation journal, the Electric shape streams and the convergence loop — fanned out to every
// tab on the same store over the bridge. Vite bundles this as a worker chunk when the app does
// `new SharedWorker(new URL("./board-sync.worker.ts", import.meta.url), { name })` (see store-registry-default).
//
// Role nuance (ADR-0032 S3, task §2): the spare worker is provisioned BEFORE the user — and therefore the
// role — is known, so a single worker file bakes BOTH the admin and member registries and picks between
// them at claim/attach via `config.role`. The two registries share one TS shape (`boardMemberRegistry` is
// the authoritative registry with `team`/`team_member` projected `asReadonly`), so this only narrows the
// worker's runtime write capability, exactly as the in-process board-client does. `provision` (initdb only)
// never touches the registry, so the warmed store serves whichever role ends up claiming it.
//
// `x-region` stays WRITE-ONLY (writeRequestHeaders) exactly as in-process: the write function is DB-bound
// and wins from the regional pin, while the read proxy follows Electric Cloud's global CDN. The worker
// loads PGlite's own boot assets on `create`; those hit the same-origin HTTP cache the login screen's
// `warmPgliteBootAssets` already primed (the tab warm is pure HTTP-cache priming in worker mode).
defineSyncWorker({
  registry: boardSyncRegistry,
  resolveRegistry: (role) =>
    role === "member" ? (boardMemberRegistry as typeof boardSyncRegistry) : boardSyncRegistry,
  electricUrl: boardConfig.electricUrl,
  batchWriteUrl: boardConfig.batchWriteUrl,
  // Fallback sweep only — writes flush event-driven the moment they enqueue, so this matches the
  // 15s policy the in-process board trigger (offline.ts) already settled on.
  convergenceIntervalMs: 15_000,
  requestHeaders: { apikey: boardConfig.publishableKey },
  ...(boardConfig.functionsRegion ? { writeRequestHeaders: { "x-region": boardConfig.functionsRegion } } : {}),
});
