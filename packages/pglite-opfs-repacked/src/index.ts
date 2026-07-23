export {
  CorruptStoreError,
  DurabilityModeMismatchError,
  ExtentSizeMismatchError,
  FsError,
  StoreClosedError,
  StoreFailedError,
  StoreLimitError,
  StoreOwnedError,
  StoreRecreationRequiredError,
  UnexpectedStoreEntryError,
} from "./core/errors";
export {
  createOpfsRepackedPGlite,
  type CreateOpfsRepackedPGliteOptions,
  type OpfsRepackedPGlite,
} from "./pglite-factory";
export { OpfsRepackedFS, type RepackedDurability } from "./opfs-repacked-fs";
