import { createOpfsRepackedPGlite } from "../../../packages/pglite-opfs-repacked/src/pglite-factory";
import type { CreateOpfsRepackedPGliteOptions } from "../../../packages/pglite-opfs-repacked/src/pglite-factory";

type RepackedPGlite = Awaited<ReturnType<typeof createOpfsRepackedPGlite>>;
type RepackedDirectory = CreateOpfsRepackedPGliteOptions["directory"];

interface RequestMessage {
  readonly id: number;
  readonly command: string;
  readonly value?: unknown;
}

interface ErrorShape {
  readonly name: string;
  readonly message: string;
  readonly storeCode?: string;
}

interface FlushController {
  failNext: boolean;
}

interface BrowserSyncAccessHandle {
  getSize(): number;
  read(target: Uint8Array, options: { at: number }): number;
  write(source: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

let pg: RepackedPGlite | undefined;
let flushController: FlushController | undefined;

globalThis.addEventListener("message", (event: MessageEvent<RequestMessage>) => {
  void respond(event.data);
});

async function respond(request: RequestMessage): Promise<void> {
  try {
    const value = await execute(request.command, request.value);
    globalThis.postMessage({ id: request.id, ok: true, value });
  } catch (cause) {
    globalThis.postMessage({ id: request.id, ok: false, error: errorShape(cause) });
  }
}

async function execute(command: string, value: unknown): Promise<unknown> {
  if (command === "open") {
    const options = value as { storeName: string; durability: "relaxed" | "strict"; faultable?: boolean };
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(options.storeName, { create: true });
    flushController = options.faultable ? { failNext: false } : undefined;
    pg = await openWithOwnershipRetry(
      flushController === undefined ? asRepackedDirectory(directory) : faultableDirectory(directory, flushController),
      options.durability,
    );
    return "opened";
  }
  if (pg === undefined) throw new Error("PGlite is not open");
  if (command === "exec") {
    await pg.exec(String(value));
    return "executed";
  }
  if (command === "count") {
    const result = await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM browser_values");
    return result.rows[0]?.count;
  }
  if (command === "fail-next-flush") {
    if (flushController === undefined) throw new Error("flush faulting was not enabled");
    flushController.failNext = true;
    return "armed";
  }
  if (command === "close") {
    await pg.close();
    pg = undefined;
    return "closed";
  }
  throw new Error(`unknown worker command: ${command}`);
}

async function openWithOwnershipRetry(
  directory: RepackedDirectory,
  durability: "relaxed" | "strict",
): Promise<RepackedPGlite> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    try {
      return await createOpfsRepackedPGlite({ directory, durability, extentSize: 8192 });
    } catch (cause) {
      if (errorShape(cause).name !== "StoreOwnedError" || performance.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function asRepackedDirectory(directory: FileSystemDirectoryHandle): RepackedDirectory {
  return directory as unknown as RepackedDirectory;
}

function faultableDirectory(directory: FileSystemDirectoryHandle, controller: FlushController): RepackedDirectory {
  return {
    async *values() {
      for await (const entry of directory.values()) yield entry;
    },
    async getFileHandle(name, options) {
      const file = await directory.getFileHandle(name, options);
      return {
        async createSyncAccessHandle() {
          const handle = await (
            file as FileSystemFileHandle & {
              createSyncAccessHandle(): Promise<BrowserSyncAccessHandle>;
            }
          ).createSyncAccessHandle();
          return {
            getSize: () => handle.getSize(),
            read: (target, readOptions) => handle.read(target, readOptions),
            write: (source, writeOptions) => handle.write(source, writeOptions),
            truncate: (size) => handle.truncate(size),
            flush: () => {
              if (controller.failNext) {
                controller.failNext = false;
                throw new Error("forced browser OPFS flush failure");
              }
              handle.flush();
            },
            close: () => handle.close(),
          };
        },
      };
    },
  };
}

function errorShape(cause: unknown): ErrorShape {
  if (typeof cause !== "object" || cause === null) {
    return { name: "Error", message: String(cause) };
  }
  const candidate = cause as { name?: unknown; message?: unknown; storeCode?: unknown };
  return {
    name: typeof candidate.name === "string" ? candidate.name : "Error",
    message: typeof candidate.message === "string" ? candidate.message : "unknown object error",
    ...(typeof candidate.storeCode === "string" ? { storeCode: candidate.storeCode } : {}),
  };
}
