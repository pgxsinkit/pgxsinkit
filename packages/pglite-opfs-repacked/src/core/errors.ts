export const FS_ERRNO = {
  EBADF: 8,
  EEXIST: 20,
  EINVAL: 28,
  EISDIR: 31,
  ENOENT: 44,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
} as const;

export type FsErrorName = keyof typeof FS_ERRNO;

/** A normal virtual-filesystem rejection. The live store remains usable. */
export class FsError extends Error {
  readonly code: number;
  readonly operation: string | undefined;
  readonly path: string | undefined;

  constructor(
    name: FsErrorName,
    message: string,
    options: { operation?: string; path?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "FsError";
    this.code = FS_ERRNO[name];
    this.operation = options.operation;
    this.path = options.path;
  }
}

/** A configured or format hard limit was reached. */
export class StoreLimitError extends Error {
  readonly storeCode = "STORE_LIMIT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreLimitError";
  }
}

/** Activated bytes violate format integrity or semantic invariants. */
export class CorruptStoreError extends Error {
  readonly storeCode = "CORRUPT_STORE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CorruptStoreError";
  }
}

/** The store identifies a different format and must be deleted in full. */
export class StoreRecreationRequiredError extends Error {
  readonly storeCode = "STORE_RECREATION_REQUIRED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreRecreationRequiredError";
  }
}

/** A supplied creation extent size disagrees with the existing store identity. */
export class ExtentSizeMismatchError extends Error {
  readonly storeCode = "EXTENT_SIZE_MISMATCH";

  constructor(expected: number, actual: number) {
    super(`configured extent size ${expected} does not match persisted extent size ${actual}`);
    this.name = "ExtentSizeMismatchError";
  }
}

/** Another live instance owns at least one required exclusive OPFS handle. */
export class StoreOwnedError extends Error {
  readonly storeCode = "STORE_OWNED";

  constructor(options?: ErrorOptions) {
    super("the OPFS repacked store is already exclusively owned by another live instance", options);
    this.name = "StoreOwnedError";
  }
}

/** The dedicated store directory contains an entry outside the exact owned set. */
export class UnexpectedStoreEntryError extends Error {
  readonly storeCode = "UNEXPECTED_STORE_ENTRY";

  constructor(entryName: string) {
    super(`the OPFS repacked store contains an unexpected entry: ${entryName}`);
    this.name = "UnexpectedStoreEntryError";
  }
}

/** The host attempted a non-awaited sync, proving the factory wiring was bypassed. */
export class DurabilityModeMismatchError extends Error {
  readonly storeCode = "DURABILITY_MODE_MISMATCH";

  constructor() {
    super("the PGlite host attempted a non-awaited OPFS repacked sync");
    this.name = "DurabilityModeMismatchError";
  }
}

/** The adapter was used after all owned handles were closed. */
export class StoreClosedError extends Error {
  readonly storeCode = "STORE_CLOSED";

  constructor() {
    super("the OPFS repacked store is closed");
    this.name = "StoreClosedError";
  }
}

/** The live instance is poisoned and retains its first terminal cause. */
export class StoreFailedError extends Error {
  readonly storeCode = "STORE_FAILED";
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(`the OPFS repacked store is poisoned and must be reopened: ${String(cause)}`, { cause });
    this.name = "StoreFailedError";
    this.cause = cause;
  }
}
