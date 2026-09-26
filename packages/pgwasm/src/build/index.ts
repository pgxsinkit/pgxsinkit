/**
 * The contract a Postgres build implements (ADR-0062 decision 3), and the helpers a build package
 * shares with pgwasm.
 */

export type {
  BlobDevice,
  BootRequest,
  BuildCapabilities,
  BuildIdentity,
  DataDirEntry,
  DebugLevel,
  FilesystemKind,
  MountedDataDirectory,
  PostgresBuild,
  RunningPostgres,
  ServerExtension,
  StartOptions,
  StorageRequest,
  WireSession,
} from "./seam";
export { readTar, writeTar, TarFormatError, type TarEntry } from "../tar/tar";
export { gunzip, gunzipIfCompressed, gzip, isGzip } from "../tar/gzip";
