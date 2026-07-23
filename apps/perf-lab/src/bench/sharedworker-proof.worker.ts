// SharedWorker-direct proof — the SharedWorker body (bench phase 0, ADR-0048 open item).
//
// The one open engine-capability question is EXISTENCE: can a full repacked PGlite boot, persist, and
// reopen INSIDE SharedWorker scope? WebKit reportedly grants `createSyncAccessHandle` here (real-device
// probes, 2026-07-18); Chromium/Firefox are known to refuse. This worker runs the staged proof and
// reports each stage verbatim so the JSON envelope says exactly which stage an engine objects to —
// the failed Playwright-WebKit nightly could not attribute its failure; this can.
//
// Stages (protocol.SHARED_WORKER_PROOF_STAGES): probe → boot → write → close → reopen → verify, with
// cleanup ALWAYS attempted last. The probe opens a real sync-access handle on a SIBLING file at the
// OPFS root and removes it again — never inside the store directory, whose whole-directory ownership
// would fail closed on the unowned entry at boot. The reopen is a SECOND engine instance on the same
// store in this same worker: activation from persisted bytes after a clean strict close, which is the
// persistence claim under test (a second SharedWorker would only add Safari worker-lifecycle variables
// that say nothing about the VFS).

import { createOpfsRepackedPGlite } from "../../../../packages/pglite-opfs-repacked/src/pglite-factory";
import type { CreateOpfsRepackedPGliteOptions } from "../../../../packages/pglite-opfs-repacked/src/pglite-factory";
import type { SharedWorkerProofStage, SharedWorkerProofStageId, SwProofInbound, SwProofOutbound } from "./protocol";

type RepackedDirectory = CreateOpfsRepackedPGliteOptions["directory"];

/** The messaging surface of a SharedWorker connection port (this app's tsconfig has no webworker lib). */
interface ProofPort {
  postMessage(message: SwProofOutbound): void;
  addEventListener(type: "message", listener: (event: MessageEvent<SwProofInbound>) => void): void;
  start(): void;
}

interface SharedWorkerScope {
  addEventListener(type: "connect", listener: (event: { ports: readonly ProofPort[] }) => void): void;
  /** WorkerGlobalScope.close() — self-termination; a SharedWorker is never reclaimed by the page. */
  close(): void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function methodPresent(): boolean {
  return (
    typeof FileSystemFileHandle !== "undefined" &&
    typeof (FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown }).createSyncAccessHandle ===
      "function"
  );
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

const PROOF_ROW = "sharedworker-direct";

async function runProof(port: ProofPort, storeName: string): Promise<void> {
  port.postMessage({ type: "begin", methodPresent: methodPresent() });

  const run = async (stage: SharedWorkerProofStageId, body: () => Promise<void>): Promise<boolean> => {
    const start = performance.now();
    const report = (result: Omit<SharedWorkerProofStage, "stage" | "ms">): void => {
      port.postMessage({ type: "stage", stage: { stage, ms: Math.round(performance.now() - start), ...result } });
    };
    try {
      await body();
      report({ ok: true });
      return true;
    } catch (error) {
      report({ ok: false, error: describeError(error) });
      return false;
    }
  };

  const probeFileName = `${storeName}.probe`;
  // Engine handles bridged across stages; closed best-effort by cleanup if their stage failed midway.
  let pg: Awaited<ReturnType<typeof createOpfsRepackedPGlite>> | undefined;

  const proof =
    (await run("probe", async () => {
      const root = await opfsRoot();
      const fileHandle = await root.getFileHandle(probeFileName, { create: true });
      const handle = await (
        fileHandle as unknown as { createSyncAccessHandle(): Promise<{ close(): void }> }
      ).createSyncAccessHandle();
      handle.close();
      await root.removeEntry(probeFileName);
    })) &&
    (await run("boot", async () => {
      const root = await opfsRoot();
      const directory = await root.getDirectoryHandle(storeName, { create: true });
      pg = await createOpfsRepackedPGlite({
        directory: directory as unknown as RepackedDirectory,
        durability: "strict",
        extentSize: 65_536,
      });
    })) &&
    (await run("write", async () => {
      await pg!.exec("CREATE TABLE sw_proof (id integer PRIMARY KEY, v text NOT NULL)");
      await pg!.exec(`INSERT INTO sw_proof VALUES (1, '${PROOF_ROW}')`);
      const rows = await pg!.query<{ v: string }>("SELECT v FROM sw_proof WHERE id = 1");
      if (rows.rows[0]?.v !== PROOF_ROW) throw new Error(`written row not readable: ${JSON.stringify(rows.rows)}`);
    })) &&
    (await run("close", async () => {
      await pg!.close();
      pg = undefined;
    })) &&
    (await run("reopen", async () => {
      const root = await opfsRoot();
      const directory = await root.getDirectoryHandle(storeName, { create: false });
      pg = await createOpfsRepackedPGlite({
        directory: directory as unknown as RepackedDirectory,
        durability: "strict",
        extentSize: 65_536,
      });
    })) &&
    (await run("verify", async () => {
      const rows = await pg!.query<{ v: string }>("SELECT v FROM sw_proof WHERE id = 1");
      if (rows.rows[0]?.v !== PROOF_ROW) throw new Error(`persisted row missing: ${JSON.stringify(rows.rows)}`);
      await pg!.close();
      pg = undefined;
    }));
  void proof; // `failed` already captured stage-by-stage; the chain exists to stop at the first failure.

  await run("cleanup", async () => {
    if (pg) {
      // A mid-proof failure left an open engine; release its handles before removing the store.
      await pg.close().catch(() => undefined);
      pg = undefined;
    }
    const root = await opfsRoot();
    await root.removeEntry(probeFileName).catch(() => undefined);
    await root.removeEntry(storeName, { recursive: true }).catch((error: unknown) => {
      // A store that was never created is not a cleanup failure; anything else is reported.
      if ((error as { name?: string }).name !== "NotFoundError") throw error;
    });
  });

  port.postMessage({ type: "done" });
}

const scope = globalThis as unknown as SharedWorkerScope;

scope.addEventListener("connect", (event) => {
  const port = event.ports[0];
  if (!port) return;
  let started = false;
  port.addEventListener("message", (message) => {
    if (message.data.type !== "start" || started) return;
    started = true;
    // Self-terminate once the proof settles: closing the page-side port does NOT reclaim a SharedWorker
    // (it lives until the owner document dies), and this proof boots two full engines per run on WebKit —
    // leaking that scope every run is what caused iOS out-of-memory reloads. The final "done" message is
    // queued on the page's loop before close() runs, so delivery is unaffected.
    void runProof(port, message.data.storeName).finally(() => scope.close());
  });
  port.start();
});
