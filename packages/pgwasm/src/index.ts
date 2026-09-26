export { createPgwasm } from "./create";
export type {
  DebugLevel,
  DumpCompression,
  Extension,
  ExtensionNamespaces,
  ExtensionSetupResult,
  Extensions,
  FilesystemKind,
  ParserOptions,
  Pgwasm,
  PgwasmOptions,
  PgwasmWithExtensions,
  QueryOptions,
  Results,
  Row,
  RowMode,
  SerializerOptions,
  StorageDescription,
  Transaction,
} from "./interface";
export type { BuildIdentity, PostgresBuild, ServerExtension } from "./build/seam";
export {
  BackupFormatError,
  BuildMarkerUnreadableError,
  BuildMismatchError,
  CrossOriginIsolationRequiredError,
  DataDirExistsError,
  DataFormatMismatchError,
  ExtensionBuildMismatchError,
  OpfsAhpRemovedError,
  PgwasmClosedError,
  PgwasmError,
  PgwasmFailedError,
  StorageInUseError,
  UnsupportedDataDirError,
  UnsupportedFeatureError,
  UnsupportedFilesystemError,
  type QueryError,
  type RecordedBuild,
} from "./errors";
export { DatabaseError } from "./protocol/wire/messages";
export { identifier, raw } from "./templating";
export * as types from "./types";
