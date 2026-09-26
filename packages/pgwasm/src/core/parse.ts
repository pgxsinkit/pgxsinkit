// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { QueryOptions, Results, Row } from "../interface";
import {
  CommandCompleteMessage,
  DataRowMessage,
  ParameterDescriptionMessage,
  RowDescriptionMessage,
  type BackendMessage,
} from "../protocol/wire/messages";
import { parseType, type Parser } from "../types";

/**
 * Turn the backend messages of a simple or extended query into result sets, one per statement
 * (https://www.postgresql.org/docs/current/protocol-flow.html).
 */
export function parseResults(
  messages: readonly BackendMessage[],
  defaultParsers: Readonly<Record<number | string, Parser>>,
  options?: QueryOptions,
  blob?: Blob,
): Results<unknown>[] {
  const resultSets: Results<unknown>[] = [];
  let current: Results<unknown> = { rows: [], fields: [] };
  let affectedRows = 0;
  const parsers = { ...defaultParsers, ...options?.parsers };

  for (const message of messages) {
    if (message instanceof RowDescriptionMessage) {
      current.fields = message.fields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID }));
    } else if (message instanceof DataRowMessage) {
      const fields = current.fields;
      const typeOf = (index: number) => fields[index]?.dataTypeID ?? 0;
      if (options?.rowMode === "array") {
        current.rows.push(message.fields.map((value, index) => parseType(value, typeOf(index), parsers)));
      } else {
        const row: Row = {};
        message.fields.forEach((value, index) => {
          row[fields[index]?.name ?? String(index)] = parseType(value, typeOf(index), parsers);
        });
        current.rows.push(row);
      }
    } else if (message instanceof CommandCompleteMessage) {
      // A tag that carries a row count ends in it ("SELECT 2", "UPDATE 3", "INSERT 0 5"); the rest end
      // in a word ("CREATE TABLE").
      const parts = message.text.split(" ");
      const command = parts[0] ?? "";
      const rowCount = Number.parseInt(parts[parts.length - 1] ?? "", 10);
      switch (command) {
        case "INSERT":
        case "UPDATE":
        case "DELETE":
        case "COPY":
        case "MERGE":
          affectedRows += rowCount;
          break;
      }
      const result: Results<unknown> = { ...current, command, affectedRows };
      if (!Number.isNaN(rowCount)) result.rowCount = rowCount;
      if (blob) result.blob = blob;
      resultSets.push(result);
      current = { rows: [], fields: [] };
    }
  }

  if (resultSets.length === 0) {
    resultSets.push({ affectedRows: 0, rows: [], fields: [] });
  }
  return resultSets;
}

/** The parameter type OIDs from a Describe(statement) reply, when it has them. */
export function parseDescribeStatementResults(messages: readonly BackendMessage[]): number[] {
  const message = messages.find(
    (msg): msg is ParameterDescriptionMessage => msg instanceof ParameterDescriptionMessage,
  );
  return message ? message.dataTypeIDs : [];
}
