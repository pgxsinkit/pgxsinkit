// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { Mode } from "./types";

export type MessageName =
  | "parseComplete"
  | "bindComplete"
  | "closeComplete"
  | "noData"
  | "portalSuspended"
  | "replicationStart"
  | "emptyQuery"
  | "copyDone"
  | "copyData"
  | "rowDescription"
  | "parameterDescription"
  | "parameterStatus"
  | "backendKeyData"
  | "notification"
  | "readyForQuery"
  | "commandComplete"
  | "dataRow"
  | "copyInResponse"
  | "copyOutResponse"
  | "authenticationOk"
  | "authenticationMD5Password"
  | "authenticationCleartextPassword"
  | "authenticationSASL"
  | "authenticationSASLContinue"
  | "authenticationSASLFinal"
  | "error"
  | "notice";

/** Every backend message: its name and the length its header declared (excluding the type byte). */
export interface BackendMessage {
  readonly name: MessageName;
  readonly length: number;
}

export const parseComplete: BackendMessage = { name: "parseComplete", length: 5 };
export const bindComplete: BackendMessage = { name: "bindComplete", length: 5 };
export const closeComplete: BackendMessage = { name: "closeComplete", length: 5 };
export const noData: BackendMessage = { name: "noData", length: 5 };
export const portalSuspended: BackendMessage = { name: "portalSuspended", length: 5 };
export const replicationStart: BackendMessage = { name: "replicationStart", length: 4 };
export const emptyQuery: BackendMessage = { name: "emptyQuery", length: 4 };
export const copyDone: BackendMessage = { name: "copyDone", length: 4 };

export class AuthenticationOk implements BackendMessage {
  readonly name = "authenticationOk";
  readonly length: number;
  constructor(length: number) {
    this.length = length;
  }
}

export class AuthenticationCleartextPassword implements BackendMessage {
  readonly name = "authenticationCleartextPassword";
  readonly length: number;
  constructor(length: number) {
    this.length = length;
  }
}

export class AuthenticationMD5Password implements BackendMessage {
  readonly name = "authenticationMD5Password";
  readonly length: number;
  readonly salt: Uint8Array;
  constructor(length: number, salt: Uint8Array) {
    this.length = length;
    this.salt = salt;
  }
}

export class AuthenticationSASL implements BackendMessage {
  readonly name = "authenticationSASL";
  readonly length: number;
  readonly mechanisms: string[];
  constructor(length: number, mechanisms: string[]) {
    this.length = length;
    this.mechanisms = mechanisms;
  }
}

export class AuthenticationSASLContinue implements BackendMessage {
  readonly name = "authenticationSASLContinue";
  readonly length: number;
  readonly data: string;
  constructor(length: number, data: string) {
    this.length = length;
    this.data = data;
  }
}

export class AuthenticationSASLFinal implements BackendMessage {
  readonly name = "authenticationSASLFinal";
  readonly length: number;
  readonly data: string;
  constructor(length: number, data: string) {
    this.length = length;
    this.data = data;
  }
}

export type AuthenticationMessage =
  | AuthenticationOk
  | AuthenticationCleartextPassword
  | AuthenticationMD5Password
  | AuthenticationSASL
  | AuthenticationSASLContinue
  | AuthenticationSASLFinal;

/** The fields an ErrorResponse and a NoticeResponse share. */
export interface NoticeOrError {
  message: string | undefined;
  severity: string | undefined;
  code: string | undefined;
  detail: string | undefined;
  hint: string | undefined;
  position: string | undefined;
  internalPosition: string | undefined;
  internalQuery: string | undefined;
  where: string | undefined;
  schema: string | undefined;
  table: string | undefined;
  column: string | undefined;
  dataType: string | undefined;
  constraint: string | undefined;
  file: string | undefined;
  line: string | undefined;
  routine: string | undefined;
}

/** An ErrorResponse from Postgres: an SQL error. `code` is the SQLSTATE. */
export class DatabaseError extends Error implements NoticeOrError {
  severity: string | undefined;
  code: string | undefined;
  detail: string | undefined;
  hint: string | undefined;
  position: string | undefined;
  internalPosition: string | undefined;
  internalQuery: string | undefined;
  where: string | undefined;
  schema: string | undefined;
  table: string | undefined;
  column: string | undefined;
  dataType: string | undefined;
  constraint: string | undefined;
  file: string | undefined;
  line: string | undefined;
  routine: string | undefined;
  readonly length: number;
  override readonly name: MessageName;
  constructor(message: string, length: number, name: MessageName) {
    super(message);
    this.length = length;
    this.name = name;
  }
}

export class CopyDataMessage implements BackendMessage {
  readonly name = "copyData";
  readonly length: number;
  readonly chunk: Uint8Array;
  constructor(length: number, chunk: Uint8Array) {
    this.length = length;
    this.chunk = chunk;
  }
}

export class CopyResponse implements BackendMessage {
  readonly length: number;
  readonly name: MessageName;
  readonly binary: boolean;
  readonly columnTypes: number[];
  constructor(length: number, name: MessageName, binary: boolean, columnCount: number) {
    this.length = length;
    this.name = name;
    this.binary = binary;
    this.columnTypes = Array.from({ length: columnCount }, () => 0);
  }
}

export class Field {
  readonly name: string;
  readonly tableID: number;
  readonly columnID: number;
  readonly dataTypeID: number;
  readonly dataTypeSize: number;
  readonly dataTypeModifier: number;
  readonly format: Mode;
  constructor(
    name: string,
    tableID: number,
    columnID: number,
    dataTypeID: number,
    dataTypeSize: number,
    dataTypeModifier: number,
    format: Mode,
  ) {
    this.name = name;
    this.tableID = tableID;
    this.columnID = columnID;
    this.dataTypeID = dataTypeID;
    this.dataTypeSize = dataTypeSize;
    this.dataTypeModifier = dataTypeModifier;
    this.format = format;
  }
}

export class RowDescriptionMessage implements BackendMessage {
  readonly name: MessageName = "rowDescription";
  readonly length: number;
  readonly fieldCount: number;
  readonly fields: Field[];
  constructor(length: number, fields: Field[]) {
    this.length = length;
    this.fieldCount = fields.length;
    this.fields = fields;
  }
}

export class ParameterDescriptionMessage implements BackendMessage {
  readonly name: MessageName = "parameterDescription";
  readonly length: number;
  readonly parameterCount: number;
  readonly dataTypeIDs: number[];
  constructor(length: number, dataTypeIDs: number[]) {
    this.length = length;
    this.parameterCount = dataTypeIDs.length;
    this.dataTypeIDs = dataTypeIDs;
  }
}

export class ParameterStatusMessage implements BackendMessage {
  readonly name: MessageName = "parameterStatus";
  readonly length: number;
  readonly parameterName: string;
  readonly parameterValue: string;
  constructor(length: number, parameterName: string, parameterValue: string) {
    this.length = length;
    this.parameterName = parameterName;
    this.parameterValue = parameterValue;
  }
}

export class BackendKeyDataMessage implements BackendMessage {
  readonly name: MessageName = "backendKeyData";
  readonly length: number;
  readonly processID: number;
  readonly secretKey: number;
  constructor(length: number, processID: number, secretKey: number) {
    this.length = length;
    this.processID = processID;
    this.secretKey = secretKey;
  }
}

export class NotificationResponseMessage implements BackendMessage {
  readonly name: MessageName = "notification";
  readonly length: number;
  readonly processId: number;
  readonly channel: string;
  readonly payload: string;
  constructor(length: number, processId: number, channel: string, payload: string) {
    this.length = length;
    this.processId = processId;
    this.channel = channel;
    this.payload = payload;
  }
}

export class ReadyForQueryMessage implements BackendMessage {
  readonly name: MessageName = "readyForQuery";
  readonly length: number;
  /** `I` idle, `T` in a transaction block, `E` in a failed transaction block. */
  readonly status: string;
  constructor(length: number, status: string) {
    this.length = length;
    this.status = status;
  }
}

export class CommandCompleteMessage implements BackendMessage {
  readonly name: MessageName = "commandComplete";
  readonly length: number;
  readonly text: string;
  constructor(length: number, text: string) {
    this.length = length;
    this.text = text;
  }
}

export class DataRowMessage implements BackendMessage {
  readonly name: MessageName = "dataRow";
  readonly length: number;
  readonly fieldCount: number;
  readonly fields: (string | null)[];
  constructor(length: number, fields: (string | null)[]) {
    this.length = length;
    this.fields = fields;
    this.fieldCount = fields.length;
  }
}

export class NoticeMessage implements BackendMessage, NoticeOrError {
  readonly name = "notice";
  readonly length: number;
  readonly message: string | undefined;
  severity: string | undefined;
  code: string | undefined;
  detail: string | undefined;
  hint: string | undefined;
  position: string | undefined;
  internalPosition: string | undefined;
  internalQuery: string | undefined;
  where: string | undefined;
  schema: string | undefined;
  table: string | undefined;
  column: string | undefined;
  dataType: string | undefined;
  constraint: string | undefined;
  file: string | undefined;
  line: string | undefined;
  routine: string | undefined;
  constructor(length: number, message: string | undefined) {
    this.length = length;
    this.message = message;
  }
}
