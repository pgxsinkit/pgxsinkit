import { StoreOwnedError } from "./core/errors";
import type { OwnedFileName, RepackedFileHandle, RepackedPort, RepackedPortEntry } from "./core/port";

interface OpfsDirectoryEntry {
  readonly kind: "file" | "directory";
  readonly name: string;
}

interface OpfsSyncAccessHandle {
  getSize(): number;
  read(target: Uint8Array, options: { at: number }): number;
  write(source: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface OpfsFileHandle {
  createSyncAccessHandle(): Promise<OpfsSyncAccessHandle>;
}

export interface OpfsDirectoryHandle {
  values(): AsyncIterable<OpfsDirectoryEntry>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
}

export class OpfsRepackedPort implements RepackedPort {
  readonly #directory: OpfsDirectoryHandle;

  constructor(directory: OpfsDirectoryHandle) {
    this.#directory = directory;
  }

  async enumerate(_label: string): Promise<readonly RepackedPortEntry[]> {
    const entries: RepackedPortEntry[] = [];
    for await (const entry of this.#directory.values()) {
      entries.push({ name: entry.name, kind: entry.kind });
    }
    return entries;
  }

  async acquire(name: OwnedFileName, _label: string): Promise<RepackedFileHandle> {
    const file = await this.#directory.getFileHandle(name, { create: true });
    try {
      return new OpfsRepackedFileHandle(name, await file.createSyncAccessHandle());
    } catch (cause) {
      if (isOwnershipFailure(cause)) throw new StoreOwnedError({ cause });
      throw cause;
    }
  }
}

class OpfsRepackedFileHandle implements RepackedFileHandle {
  readonly name: OwnedFileName;
  readonly #handle: OpfsSyncAccessHandle;

  constructor(name: OwnedFileName, handle: OpfsSyncAccessHandle) {
    this.name = name;
    this.#handle = handle;
  }

  getSize(_label: string): number {
    return this.#handle.getSize();
  }

  read(target: Uint8Array, at: number, _label: string): number {
    return this.#handle.read(target, { at });
  }

  write(source: Uint8Array, at: number, _label: string): number {
    return this.#handle.write(source, { at });
  }

  truncate(size: number, _label: string): void {
    this.#handle.truncate(size);
  }

  flush(_label: string): void {
    this.#handle.flush();
  }

  close(): void {
    this.#handle.close();
  }
}

function isOwnershipFailure(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("name" in cause)) return false;
  return cause.name === "NoModificationAllowedError" || cause.name === "InvalidStateError";
}
