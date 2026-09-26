// Began as a copy of `@electric-sql/pg-protocol`, itself adapted from node-postgres' `pg-protocol`
// (MIT, © Brian Carlson; ElectricSQL's changes taken under the PostgreSQL License — see NOTICE).
// Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import { BufferReader } from "./buffer-reader";
import {
  AuthenticationCleartextPassword,
  AuthenticationMD5Password,
  AuthenticationOk,
  AuthenticationSASL,
  AuthenticationSASLContinue,
  AuthenticationSASLFinal,
  BackendKeyDataMessage,
  bindComplete,
  closeComplete,
  CommandCompleteMessage,
  CopyDataMessage,
  copyDone,
  CopyResponse,
  DatabaseError,
  DataRowMessage,
  emptyQuery,
  Field,
  noData,
  NoticeMessage,
  NotificationResponseMessage,
  ParameterDescriptionMessage,
  ParameterStatusMessage,
  parseComplete,
  portalSuspended,
  ReadyForQueryMessage,
  replicationStart,
  RowDescriptionMessage,
  type AuthenticationMessage,
  type BackendMessage,
  type MessageName,
} from "./messages";
import { Modes, type BufferParameter } from "./types";

// Every message starts with one type byte and an int32 length that counts itself but not the type.
const CODE_LENGTH = 1;
const LEN_LENGTH = 4;
const HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;

const emptyBuffer = new ArrayBuffer(0);

const MessageCodes = {
  DataRow: 0x44, // D
  ParseComplete: 0x31, // 1
  BindComplete: 0x32, // 2
  CloseComplete: 0x33, // 3
  CommandComplete: 0x43, // C
  ReadyForQuery: 0x5a, // Z
  NoData: 0x6e, // n
  NotificationResponse: 0x41, // A
  AuthenticationResponse: 0x52, // R
  ParameterStatus: 0x53, // S
  BackendKeyData: 0x4b, // K
  ErrorMessage: 0x45, // E
  NoticeMessage: 0x4e, // N
  RowDescriptionMessage: 0x54, // T
  ParameterDescriptionMessage: 0x74, // t
  PortalSuspended: 0x73, // s
  ReplicationStart: 0x57, // W
  EmptyQuery: 0x49, // I
  CopyIn: 0x47, // G
  CopyOut: 0x48, // H
  CopyDone: 0x63, // c
  CopyData: 0x64, // d
} as const;

export type MessageCallback = (msg: BackendMessage) => void;

/**
 * Parses backend messages out of a byte stream that may arrive in arbitrary chunks: a message split
 * across calls is buffered until the rest arrives.
 */
export class Parser {
  #bufferView: DataView = new DataView(emptyBuffer);
  #bufferRemainingLength = 0;
  #bufferOffset = 0;
  readonly #reader = new BufferReader();

  parse(buffer: BufferParameter, callback: MessageCallback): void {
    this.#mergeBuffer(
      ArrayBuffer.isView(buffer)
        ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
        : buffer,
    );
    const bufferFullLength = this.#bufferOffset + this.#bufferRemainingLength;
    let offset = this.#bufferOffset;
    while (offset + HEADER_LENGTH <= bufferFullLength) {
      const code = this.#bufferView.getUint8(offset);
      const length = this.#bufferView.getUint32(offset + CODE_LENGTH, false);
      const fullMessageLength = CODE_LENGTH + length;
      if (fullMessageLength + offset <= bufferFullLength && length > 0) {
        let message: BackendMessage;
        try {
          message = this.#handlePacket(offset + HEADER_LENGTH, code, length, this.#bufferView.buffer);
        } catch (error) {
          this.#resetBuffer();
          throw error;
        }
        callback(message);
        offset += fullMessageLength;
      } else {
        break;
      }
    }
    if (offset === bufferFullLength) {
      this.#resetBuffer();
    } else {
      this.#bufferRemainingLength = bufferFullLength - offset;
      this.#bufferOffset = offset;
    }
  }

  #resetBuffer(): void {
    this.#bufferView = new DataView(emptyBuffer);
    this.#bufferRemainingLength = 0;
    this.#bufferOffset = 0;
  }

  #mergeBuffer(buffer: ArrayBufferLike): void {
    if (this.#bufferRemainingLength > 0) {
      const newLength = this.#bufferRemainingLength + buffer.byteLength;
      const newFullLength = newLength + this.#bufferOffset;
      if (newFullLength > this.#bufferView.byteLength) {
        let newBuffer: ArrayBufferLike;
        if (newLength <= this.#bufferView.byteLength && this.#bufferOffset >= this.#bufferRemainingLength) {
          // Move the pending bytes to the front instead of allocating.
          newBuffer = this.#bufferView.buffer;
        } else {
          let newBufferLength = this.#bufferView.byteLength * 2;
          while (newLength >= newBufferLength) {
            newBufferLength *= 2;
          }
          newBuffer = new ArrayBuffer(newBufferLength);
        }
        new Uint8Array(newBuffer).set(
          new Uint8Array(this.#bufferView.buffer, this.#bufferOffset, this.#bufferRemainingLength),
        );
        this.#bufferView = new DataView(newBuffer);
        this.#bufferOffset = 0;
      }
      new Uint8Array(this.#bufferView.buffer).set(
        new Uint8Array(buffer),
        this.#bufferOffset + this.#bufferRemainingLength,
      );
      this.#bufferRemainingLength = newLength;
    } else {
      this.#bufferView = new DataView(buffer);
      this.#bufferOffset = 0;
      this.#bufferRemainingLength = buffer.byteLength;
    }
  }

  #handlePacket(offset: number, code: number, length: number, bytes: ArrayBufferLike): BackendMessage {
    switch (code) {
      case MessageCodes.BindComplete:
        return bindComplete;
      case MessageCodes.ParseComplete:
        return parseComplete;
      case MessageCodes.CloseComplete:
        return closeComplete;
      case MessageCodes.NoData:
        return noData;
      case MessageCodes.PortalSuspended:
        return portalSuspended;
      case MessageCodes.CopyDone:
        return copyDone;
      case MessageCodes.ReplicationStart:
        return replicationStart;
      case MessageCodes.EmptyQuery:
        return emptyQuery;
      case MessageCodes.DataRow:
        return this.#parseDataRowMessage(offset, length, bytes);
      case MessageCodes.CommandComplete:
        return this.#parseCommandCompleteMessage(offset, length, bytes);
      case MessageCodes.ReadyForQuery:
        return this.#parseReadyForQueryMessage(offset, length, bytes);
      case MessageCodes.NotificationResponse:
        return this.#parseNotificationMessage(offset, length, bytes);
      case MessageCodes.AuthenticationResponse:
        return this.#parseAuthenticationResponse(offset, length, bytes);
      case MessageCodes.ParameterStatus:
        return this.#parseParameterStatusMessage(offset, length, bytes);
      case MessageCodes.BackendKeyData:
        return this.#parseBackendKeyData(offset, length, bytes);
      case MessageCodes.ErrorMessage:
        return this.#parseErrorMessage(offset, length, bytes, "error");
      case MessageCodes.NoticeMessage:
        return this.#parseErrorMessage(offset, length, bytes, "notice");
      case MessageCodes.RowDescriptionMessage:
        return this.#parseRowDescriptionMessage(offset, length, bytes);
      case MessageCodes.ParameterDescriptionMessage:
        return this.#parseParameterDescriptionMessage(offset, length, bytes);
      case MessageCodes.CopyIn:
        return this.#parseCopyMessage(offset, length, bytes, "copyInResponse");
      case MessageCodes.CopyOut:
        return this.#parseCopyMessage(offset, length, bytes, "copyOutResponse");
      case MessageCodes.CopyData:
        return this.#parseCopyData(offset, length, bytes);
      default:
        return new DatabaseError(`received invalid response: ${code.toString(16)}`, length, "error");
    }
  }

  #setBuffer(offset: number, bytes: ArrayBufferLike): void {
    this.#reader.setBuffer(offset, bytes);
  }

  #parseReadyForQueryMessage(offset: number, length: number, bytes: ArrayBufferLike): ReadyForQueryMessage {
    this.#setBuffer(offset, bytes);
    return new ReadyForQueryMessage(length, this.#reader.string(1));
  }

  #parseCommandCompleteMessage(offset: number, length: number, bytes: ArrayBufferLike): CommandCompleteMessage {
    this.#setBuffer(offset, bytes);
    return new CommandCompleteMessage(length, this.#reader.cstring());
  }

  #parseCopyData(offset: number, length: number, bytes: ArrayBufferLike): CopyDataMessage {
    const chunk = bytes.slice(offset, offset + (length - 4));
    return new CopyDataMessage(length, new Uint8Array(chunk));
  }

  #parseCopyMessage(offset: number, length: number, bytes: ArrayBufferLike, messageName: MessageName): CopyResponse {
    this.#setBuffer(offset, bytes);
    const isBinary = this.#reader.byte() !== 0;
    const columnCount = this.#reader.int16();
    const message = new CopyResponse(length, messageName, isBinary, columnCount);
    for (let i = 0; i < columnCount; i++) {
      message.columnTypes[i] = this.#reader.int16();
    }
    return message;
  }

  #parseNotificationMessage(offset: number, length: number, bytes: ArrayBufferLike): NotificationResponseMessage {
    this.#setBuffer(offset, bytes);
    const processId = this.#reader.int32();
    const channel = this.#reader.cstring();
    const payload = this.#reader.cstring();
    return new NotificationResponseMessage(length, processId, channel, payload);
  }

  #parseRowDescriptionMessage(offset: number, length: number, bytes: ArrayBufferLike): RowDescriptionMessage {
    this.#setBuffer(offset, bytes);
    const fieldCount = this.#reader.int16();
    const fields: Field[] = [];
    for (let i = 0; i < fieldCount; i++) {
      fields.push(this.#parseField());
    }
    return new RowDescriptionMessage(length, fields);
  }

  #parseField(): Field {
    const name = this.#reader.cstring();
    const tableID = this.#reader.int32();
    const columnID = this.#reader.int16();
    const dataTypeID = this.#reader.int32();
    const dataTypeSize = this.#reader.int16();
    const dataTypeModifier = this.#reader.int32();
    const mode = this.#reader.int16() === 0 ? Modes.text : Modes.binary;
    return new Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
  }

  #parseParameterDescriptionMessage(
    offset: number,
    length: number,
    bytes: ArrayBufferLike,
  ): ParameterDescriptionMessage {
    this.#setBuffer(offset, bytes);
    const parameterCount = this.#reader.int16();
    const dataTypeIDs: number[] = [];
    for (let i = 0; i < parameterCount; i++) {
      dataTypeIDs.push(this.#reader.int32());
    }
    return new ParameterDescriptionMessage(length, dataTypeIDs);
  }

  #parseDataRowMessage(offset: number, length: number, bytes: ArrayBufferLike): DataRowMessage {
    this.#setBuffer(offset, bytes);
    const fieldCount = this.#reader.int16();
    const fields: (string | null)[] = [];
    for (let i = 0; i < fieldCount; i++) {
      const len = this.#reader.int32();
      // A length of -1 is SQL NULL.
      fields.push(len === -1 ? null : this.#reader.string(len));
    }
    return new DataRowMessage(length, fields);
  }

  #parseParameterStatusMessage(offset: number, length: number, bytes: ArrayBufferLike): ParameterStatusMessage {
    this.#setBuffer(offset, bytes);
    const name = this.#reader.cstring();
    const value = this.#reader.cstring();
    return new ParameterStatusMessage(length, name, value);
  }

  #parseBackendKeyData(offset: number, length: number, bytes: ArrayBufferLike): BackendKeyDataMessage {
    this.#setBuffer(offset, bytes);
    const processID = this.#reader.int32();
    const secretKey = this.#reader.int32();
    return new BackendKeyDataMessage(length, processID, secretKey);
  }

  #parseAuthenticationResponse(offset: number, length: number, bytes: ArrayBufferLike): AuthenticationMessage {
    this.#setBuffer(offset, bytes);
    const code = this.#reader.int32();
    switch (code) {
      case 0:
        return new AuthenticationOk(length);
      case 3:
        return new AuthenticationCleartextPassword(length);
      case 5:
        return new AuthenticationMD5Password(length, this.#reader.bytes(4));
      case 10: {
        const mechanisms: string[] = [];
        for (;;) {
          const mechanism = this.#reader.cstring();
          if (mechanism.length === 0) {
            return new AuthenticationSASL(length, mechanisms);
          }
          mechanisms.push(mechanism);
        }
      }
      case 11:
        return new AuthenticationSASLContinue(length, this.#reader.string(length - 8));
      case 12:
        return new AuthenticationSASLFinal(length, this.#reader.string(length - 8));
      default:
        throw new Error(`Unknown authenticationOk message type ${code}`);
    }
  }

  #parseErrorMessage(
    offset: number,
    length: number,
    bytes: ArrayBufferLike,
    name: MessageName,
  ): DatabaseError | NoticeMessage {
    this.#setBuffer(offset, bytes);
    const fields: Record<string, string> = {};
    let fieldType = this.#reader.string(1);
    while (fieldType !== "\0") {
      fields[fieldType] = this.#reader.cstring();
      fieldType = this.#reader.string(1);
    }

    const messageValue = fields["M"];
    const message =
      name === "notice" ? new NoticeMessage(length, messageValue) : new DatabaseError(messageValue ?? "", length, name);

    message.severity = fields["S"];
    message.code = fields["C"];
    message.detail = fields["D"];
    message.hint = fields["H"];
    message.position = fields["P"];
    message.internalPosition = fields["p"];
    message.internalQuery = fields["q"];
    message.where = fields["W"];
    message.schema = fields["s"];
    message.table = fields["t"];
    message.column = fields["c"];
    message.dataType = fields["d"];
    message.constraint = fields["n"];
    message.file = fields["F"];
    message.line = fields["L"];
    message.routine = fields["R"];
    return message;
  }
}
