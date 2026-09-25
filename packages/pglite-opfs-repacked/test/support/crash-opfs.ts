/**
 * A deterministic, fault-injecting OPFS directory for crash-and-reopen tests: the platform the store's
 * production `OpfsRepackedPort` talks to, with a power switch.
 *
 * It sits BELOW the port on purpose. `createOpfsRepackedPGlite` takes a directory handle and builds its
 * own `OpfsRepackedPort`, so a double of the directory is the only seam that runs the package's own
 * factory unmodified; and because that port forwards every store call 1:1 to a sync access handle
 * (`getSize`/`read`/`write`/`truncate`/`flush`/`close`), the calls recorded here ARE the calls the store
 * core makes, in the order it makes them. A store opened directly (`RepackedVfs.open(new
 * OpfsRepackedPort(directory))`) sees the same platform.
 *
 * Every call gets the next index. Arming a kill at index `k` makes call `k` the one the power dies in:
 * the platform's persistent state FREEZES there. Call `k` and every later call are dropped from it —
 * except that a `write` at `k` may be TORN, its first `tornBytes` landing and the rest not. Kill points
 * are call indices, never timers, so the same workload always dies at the same store operation.
 *
 * The process that owned the platform is not stopped: it keeps running against the live files as if
 * nothing happened, and can be closed normally. That is deliberate. A terminated worker observes
 * nothing after its death, so nothing it would "see" is evidence; what a crash leaves is the frozen
 * image, and a process that stays healthy can release its engine instead of leaking it. (A platform
 * that THREW after the kill would keep that process running on errors it never gets in a real crash.)
 * `armTransientFailure` is the fault that is about what the process sees: one call throws a given
 * error, has no effect, and the platform carries on.
 *
 * Each owned file keeps two images, which together bound what a platform may still hold after the
 * process that wrote them died:
 *
 * - **applied** — every write and truncate that returned, plus the torn prefix of the call the power
 *   died in. This is worker, tab, or process termination on a platform that keeps what it accepted: the
 *   image a browser leaves behind when `worker.terminate()` kills the storage worker.
 * - **flushed** — each file exactly as of its last completed `flush()`. Nothing unflushed survived: the
 *   most pessimistic image the store's contract admits ("independently present unflushed writes" — here
 *   none of them), and the shape power loss would leave, which the contract does not promise to survive.
 *
 * `image(model)` materializes either — as of the kill once the power has died, live before — or one of
 * the two mixed images in which only the arena's or only the metadata files' unflushed effects
 * survived. `CrashOpfsDirectory.fromImage` boots a fresh platform on any of them, entirely durable,
 * which is the reopen.
 */
import { OWNED_FILE_NAMES } from "../../src/core/port";
import type { OwnedFileName } from "../../src/core/port";
import type { OpfsDirectoryHandle } from "../../src/opfs-port";

export type CrashCallKind = "enumerate" | "acquire" | "getSize" | "read" | "write" | "truncate" | "flush" | "close";

/**
 * One call the store made, in order. `offset`/`length` are the byte position and count of a `read` or
 * `write`; a `truncate` records the new file size as `offset` and 0 as `length`; every other kind records
 * 0 for both.
 */
export interface CrashCall {
  readonly index: number;
  readonly kind: CrashCallKind;
  readonly file: OwnedFileName | undefined;
  readonly offset: number;
  readonly length: number;
}

/**
 * Which unflushed effects a materialized image keeps. `applied` and `flushed` are the two bounds; the
 * mixed ones keep the arena's unflushed effects without the metadata files' (`arena-applied`) or the
 * other way round (`metadata-applied`). `activation.bin` travels with the metadata files.
 */
export type CrashImageModel = "applied" | "flushed" | "arena-applied" | "metadata-applied";

export type CrashImage = ReadonlyMap<OwnedFileName, CrashFileImage>;

const PAGE_BYTES = 64 * 1024;

/**
 * An immutable file image, stored as 64 KiB pages that images may SHARE. Materializing an image, and
 * booting a platform on one, copies page pointers rather than bytes, which is what keeps a campaign of
 * reopens over a 78 MB arena cheap. A missing page reads as zeros.
 */
export class CrashFileImage {
  readonly size: number;
  readonly #pages: readonly (Uint8Array | undefined)[];

  constructor(size: number, pages: readonly (Uint8Array | undefined)[]) {
    this.size = size;
    this.#pages = pages;
  }

  /** @internal The shared pages, for a `PagedBytes` to start from. */
  get pages(): readonly (Uint8Array | undefined)[] {
    return this.#pages;
  }

  equals(other: CrashFileImage): boolean {
    if (other.size !== this.size) return false;
    const count = Math.ceil(this.size / PAGE_BYTES);
    for (let index = 0; index < count; index += 1) {
      const left = this.#pages[index];
      const right = other.#pages[index];
      if (left === right) continue;
      const length = Math.min(PAGE_BYTES, this.size - index * PAGE_BYTES);
      for (let at = 0; at < length; at += 1) {
        if ((left?.[at] ?? 0) !== (right?.[at] ?? 0)) return false;
      }
    }
    return true;
  }
}

/**
 * A live, mutable file: copy-on-write over pages it may share with images. Every byte past `size` in a
 * page this file owns is zero, so an extension always exposes zeros, as a platform truncate does.
 */
class PagedBytes {
  #pages: (Uint8Array | undefined)[];
  readonly #owned: boolean[];
  #size: number;

  constructor(image?: CrashFileImage) {
    this.#pages = image === undefined ? [] : [...image.pages];
    this.#owned = this.#pages.map(() => false);
    this.#size = image?.size ?? 0;
  }

  get size(): number {
    return this.#size;
  }

  read(target: Uint8Array, at: number): number {
    const count = Math.max(0, Math.min(target.byteLength, this.#size - at));
    let done = 0;
    while (done < count) {
      const position = at + done;
      const index = Math.floor(position / PAGE_BYTES);
      const within = position % PAGE_BYTES;
      const length = Math.min(count - done, PAGE_BYTES - within);
      const page = this.#pages[index];
      if (page === undefined) target.fill(0, done, done + length);
      else target.set(page.subarray(within, within + length), done);
      done += length;
    }
    return count;
  }

  write(source: Uint8Array, at: number): void {
    let done = 0;
    while (done < source.byteLength) {
      const position = at + done;
      const index = Math.floor(position / PAGE_BYTES);
      const within = position % PAGE_BYTES;
      const length = Math.min(source.byteLength - done, PAGE_BYTES - within);
      this.#ownedPage(index).set(source.subarray(done, done + length), within);
      done += length;
    }
    this.#size = Math.max(this.#size, at + source.byteLength);
  }

  truncate(size: number): void {
    if (size < this.#size) {
      // Zero what the shrink cut off, page by page, so a later extension reads zeros there.
      const firstIndex = Math.floor(size / PAGE_BYTES);
      const within = size % PAGE_BYTES;
      if (within > 0 && this.#pages[firstIndex] !== undefined) this.#ownedPage(firstIndex).fill(0, within);
      const keep = Math.ceil(size / PAGE_BYTES);
      this.#pages.length = Math.min(this.#pages.length, keep);
      this.#owned.length = this.#pages.length;
    }
    this.#size = size;
  }

  image(): CrashFileImage {
    // From here on the pages are shared with the image, so the next write to any of them copies it.
    this.#owned.fill(false);
    return new CrashFileImage(this.#size, [...this.#pages]);
  }

  #ownedPage(index: number): Uint8Array {
    while (this.#pages.length <= index) {
      this.#pages.push(undefined);
      this.#owned.push(false);
    }
    const page = this.#pages[index];
    if (this.#owned[index] && page !== undefined) return page;
    const copy = page === undefined ? new Uint8Array(PAGE_BYTES) : page.slice();
    this.#pages[index] = copy;
    this.#owned[index] = true;
    return copy;
  }
}

type PendingEffect =
  | { readonly kind: "write"; readonly at: number; readonly data: Uint8Array }
  | { readonly kind: "truncate"; readonly size: number };

/** One owned file: what the platform accepted, what it last flushed, and the effects between the two. */
class CrashFile {
  readonly applied: PagedBytes;
  readonly flushed: PagedBytes;
  pending: PendingEffect[] = [];
  locked = false;

  constructor(initial?: CrashFileImage) {
    this.applied = new PagedBytes(initial);
    this.flushed = new PagedBytes(initial);
  }

  write(source: Uint8Array, at: number): void {
    const data = source.slice();
    this.applied.write(data, at);
    this.pending.push({ kind: "write", at, data });
  }

  truncate(size: number): void {
    this.applied.truncate(size);
    this.pending.push({ kind: "truncate", size });
  }

  flush(): void {
    // Replaying the effect log costs the bytes written since the last flush, not the size of the file.
    for (const effect of this.pending) {
      if (effect.kind === "write") this.flushed.write(effect.data, effect.at);
      else this.flushed.truncate(effect.size);
    }
    this.pending = [];
  }
}

function isOwnedFileName(name: string): name is OwnedFileName {
  return (OWNED_FILE_NAMES as readonly string[]).includes(name);
}

/** One file as the power left it: what the platform had accepted, and what it had flushed. */
interface FrozenFile {
  readonly applied: CrashFileImage;
  readonly flushed: CrashFileImage;
}

export class CrashOpfsDirectory implements OpfsDirectoryHandle {
  readonly #files = new Map<OwnedFileName, CrashFile>();
  readonly #calls: CrashCall[] = [];
  #kill: { readonly index: number; readonly tornBytes: number } | undefined;
  #killedCall: CrashCall | undefined;
  #frozen: ReadonlyMap<OwnedFileName, FrozenFile> | undefined;
  #transient: { readonly index: number; readonly error: unknown } | undefined;

  /** A platform holding `image` entirely durably: the state a reopen after a crash finds. */
  static fromImage(image: CrashImage): CrashOpfsDirectory {
    const directory = new CrashOpfsDirectory();
    for (const [name, bytes] of image) directory.#files.set(name, new CrashFile(bytes));
    return directory;
  }

  /**
   * Lose power at call `index` (see the module header). A `tornBytes` greater than zero lets that many
   * leading bytes of the call land if — and only if — it is a `write`.
   */
  armKill(index: number, tornBytes = 0): void {
    this.#assertFuture(index, "kill");
    if (!Number.isSafeInteger(tornBytes) || tornBytes < 0) throw new RangeError("torn byte count is invalid");
    this.#kill = { index, tornBytes };
  }

  /** Make call `index` throw `error` with no effect, once; the platform stays up. */
  armTransientFailure(index: number, error: unknown): void {
    this.#assertFuture(index, "failure");
    this.#transient = { index, error };
  }

  /** The index the next call will get. */
  get nextCallIndex(): number {
    return this.#calls.length;
  }

  get powerLost(): boolean {
    return this.#killedCall !== undefined;
  }

  /** The call the power died in, once it has. */
  get killedCall(): CrashCall | undefined {
    return this.#killedCall;
  }

  calls(): readonly CrashCall[] {
    return this.#calls.slice();
  }

  image(model: CrashImageModel): CrashImage {
    const image = new Map<OwnedFileName, CrashFileImage>();
    const names = this.#frozen === undefined ? [...this.#files.keys()] : [...this.#frozen.keys()];
    for (const name of names) {
      const keepsUnflushed =
        model === "applied" ||
        (model === "arena-applied" && name === "arena.bin") ||
        (model === "metadata-applied" && name !== "arena.bin");
      const frozen = this.#frozen?.get(name);
      const file = this.#files.get(name)!;
      image.set(
        name,
        frozen === undefined
          ? (keepsUnflushed ? file.applied : file.flushed).image()
          : keepsUnflushed
            ? frozen.applied
            : frozen.flushed,
      );
    }
    return image;
  }

  async *values(): AsyncIterable<{ readonly kind: "file" | "directory"; readonly name: string }> {
    this.#enter("enumerate", undefined);
    for (const name of [...this.#files.keys()].sort()) yield { kind: "file", name };
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!isOwnedFileName(name)) throw new DOMException(`${name} is not an owned store file`, "NotAllowedError");
    const existing = this.#files.get(name);
    if (existing === undefined && !options?.create) throw new DOMException(`${name} does not exist`, "NotFoundError");
    return {
      createSyncAccessHandle: async () => {
        this.#enter("acquire", name);
        let file = this.#files.get(name);
        if (file === undefined) {
          file = new CrashFile();
          this.#files.set(name, file);
        }
        if (file.locked) throw new DOMException(`${name} is already locked`, "NoModificationAllowedError");
        file.locked = true;
        return this.#handle(name, file);
      },
    };
  }

  #handle(name: OwnedFileName, file: CrashFile) {
    let closed = false;
    const assertOpen = () => {
      if (closed) throw new DOMException(`${name} access handle is closed`, "InvalidStateError");
    };
    return {
      getSize: (): number => {
        this.#enter("getSize", name);
        assertOpen();
        return file.applied.size;
      },
      read: (target: Uint8Array, options: { at: number }): number => {
        this.#enter("read", name, options.at, target.byteLength);
        assertOpen();
        return file.applied.read(target, options.at);
      },
      write: (source: Uint8Array, options: { at: number }): number => {
        this.#enter("write", name, options.at, source.byteLength, (frozen) => {
          // The call the power dies in may tear: its leading bytes reach the frozen accepted image.
          const torn = Math.min(this.#kill?.tornBytes ?? 0, source.byteLength);
          const current = frozen.get(name);
          if (torn === 0 || current === undefined) return;
          const withTear = new PagedBytes(current.applied);
          withTear.write(source.subarray(0, torn), options.at);
          frozen.set(name, { ...current, applied: withTear.image() });
        });
        assertOpen();
        file.write(source, options.at);
        return source.byteLength;
      },
      truncate: (size: number): void => {
        this.#enter("truncate", name, size, 0);
        assertOpen();
        file.truncate(size);
      },
      flush: (): void => {
        this.#enter("flush", name);
        assertOpen();
        file.flush();
      },
      close: (): void => {
        this.#enter("close", name);
        if (closed) return;
        closed = true;
        file.locked = false;
      },
    };
  }

  /**
   * Record a call, freeze the persistent state if the power dies in it (before its effect), and throw an
   * armed transient failure. `tear` lets a dying write add its torn prefix to what froze.
   */
  #enter(
    kind: CrashCallKind,
    file: OwnedFileName | undefined,
    offset = 0,
    length = 0,
    tear?: (frozen: Map<OwnedFileName, FrozenFile>) => void,
  ): void {
    const call: CrashCall = Object.freeze({ index: this.#calls.length, kind, file, offset, length });
    this.#calls.push(call);
    if (this.#kill?.index === call.index) {
      const frozen = new Map<OwnedFileName, FrozenFile>();
      for (const [name, state] of this.#files) {
        frozen.set(name, { applied: state.applied.image(), flushed: state.flushed.image() });
      }
      tear?.(frozen);
      this.#frozen = frozen;
      this.#killedCall = call;
    }
    if (this.#transient?.index === call.index) {
      const { error } = this.#transient;
      this.#transient = undefined;
      throw error;
    }
  }

  #assertFuture(index: number, what: string): void {
    if (!Number.isSafeInteger(index) || index < this.#calls.length) {
      throw new RangeError(`${what} index ${index} is not a future call (next call is ${this.#calls.length})`);
    }
  }
}
