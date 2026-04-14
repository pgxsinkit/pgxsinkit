import type { ChangeMessage, FetchError, Row, ShapeStreamInterface, ShapeStreamOptions } from "@electric-sql/client";
import type { Transaction } from "@electric-sql/pglite";

export type Lsn = bigint;

export type MapColumnsMap = Record<string, string>;
export type MapColumnsFn = (message: ChangeMessage<Row<unknown>>) => Record<string, any>;
export type MapColumns = MapColumnsMap | MapColumnsFn;
export type SubscriptionKey = string;
export type InitialInsertMethod = "insert" | "csv" | "json" | "useCopy";

export interface ShapeToTableOptions {
  shape: ShapeStreamOptions<Row<unknown>>;
  table: string;
  schema?: string | undefined;
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
  onMustRefetch?: ((tx: Transaction) => Promise<void>) | undefined;
}

export interface SyncShapesToTablesOptions {
  key: string | null;
  shapes: Record<string, ShapeToTableOptions>;
  useCopy?: boolean | undefined;
  initialInsertMethod?: InitialInsertMethod | undefined;
  onInitialSync?: (() => void) | undefined;
  onError?: ((error: FetchError | Error) => void) | undefined;
}

export interface SyncShapesToTablesResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
  streams: Record<string, ShapeStreamInterface<Row<unknown>>>;
}

export interface SyncShapeToTableOptions {
  shape: ShapeStreamOptions<Row<unknown>>;
  table: string;
  schema?: string | undefined;
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
  shapeKey: string | null;
  useCopy?: boolean | undefined;
  initialInsertMethod?: InitialInsertMethod | undefined;
  onInitialSync?: (() => void) | undefined;
  onError?: ((error: FetchError | Error) => void) | undefined;
  onMustRefetch?: ((tx: Transaction) => Promise<void>) | undefined;
}

export interface SyncShapeToTableResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
  stream: ShapeStreamInterface<Row<unknown>>;
}

export interface ElectricSyncOptions {
  debug?: boolean;
  metadataSchema?: string;
}

export type InsertChangeMessage = ChangeMessage<any> & {
  headers: { operation: "insert" };
};
