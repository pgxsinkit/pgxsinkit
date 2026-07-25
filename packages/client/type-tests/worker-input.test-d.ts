// Type-level contract test (ADR-0049 D5). The DOM-`postMessage` `transfer`-variance fix in
// `protocol.ts` / `attach-sync-client.ts` must keep a real DOM `SharedWorker` factory, a bare instance,
// its `.port`, and a dedicated `Worker` factory ALL assignable to the public attach/provision
// `worker`/`port` inputs WITH NO CAST — so a consumer wires the factory form (which arms
// SharedWorker-death recovery, D5) and hands `SharedWorker.port` without `as unknown` laundering.
//
// If a positive line below regresses to a type error, the variance wall is back. If a negative line
// stops erroring, the widening over-accepts. Either way this file fails the typecheck gate. Checked
// under DOM lib via `tsconfig.type-tests.json`; never bundled (outside `src`, so the dts build ignores it).
import type { AttachSyncClientOptions, BridgePort, provisionSyncWorker } from "@pgxsinkit/client";
import type { SyncTableRegistry } from "@pgxsinkit/contracts";

type WorkerInput = NonNullable<AttachSyncClientOptions<SyncTableRegistry>["worker"]>;
type PortInput = NonNullable<AttachSyncClientOptions<SyncTableRegistry>["port"]>;
// `provisionSyncWorker` Picks the same `worker`/`port` fields (ProvisionSyncWorkerOptions), so lock it too.
type ProvisionWorkerInput = NonNullable<Parameters<typeof provisionSyncWorker>[0]["worker"]>;

declare const url: URL;

// ── positive: the exact forms consumers use, no cast ──
export const swFactory: WorkerInput = () => new SharedWorker(url, { name: "s" });
export const swInstance: WorkerInput = new SharedWorker(url, { name: "s" });
export const swPortField: PortInput = new SharedWorker(url, { name: "s" }).port;
export const swPortAsBridge: BridgePort = new SharedWorker(url, { name: "s" }).port;
export const dedicatedWorkerFactory: WorkerInput = () => new Worker(url, { type: "module" });
export const provisionFactory: ProvisionWorkerInput = () => new SharedWorker(url, { name: "s" });

// ── negative: the widening must NOT accept garbage — each MUST still error ──
type Assignable<A, B> = A extends B ? true : false;
type ExpectFalse<T extends false> = T;
// A primitive is not a worker input.
export type _numberIsNotWorker = ExpectFalse<Assignable<42, WorkerInput>>;
// An empty object lacks the required BridgePort members (postMessage/addEventListener/removeEventListener).
export type _emptyIsNotPort = ExpectFalse<Assignable<{ readonly x: 1 }, BridgePort>>;
