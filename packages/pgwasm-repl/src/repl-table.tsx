// Began as a copy of `@electric-sql/pglite-repl` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { useState } from "react";

import type { ReplRows } from "./types";

const ROW_INCREMENT = 100;
const MAX_CELL_LENGTH = 200;

function cellClass(value: unknown): string {
  if (value === null) return "pgwasm-repl-null";
  if (typeof value === "number") return "pgwasm-repl-number";
  if (typeof value === "boolean") return "pgwasm-repl-boolean";
  return "";
}

export function cellValue(value: unknown): string {
  let text: string;
  if (value === null) text = "null";
  else if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "bigint") text = value.toString();
  else if (typeof value === "boolean") text = value ? "true" : "false";
  else if (value instanceof Date) text = value.toISOString();
  else if (Array.isArray(value)) text = `[${value.map(cellValue).join(", ")}]`;
  else if (ArrayBuffer.isView(value)) text = `${value.byteLength} bytes`;
  else if (typeof value === "object") text = JSON.stringify(value);
  else if (typeof value === "symbol") text = value.toString();
  else text = "[function]";
  return text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH)}…` : text;
}

/** One result as a table, a hundred rows at a time. */
export function ReplTable({ result }: { readonly result: ReplRows }) {
  // A response's results never change once shown, so the count only grows.
  const [maxRows, setMaxRows] = useState(ROW_INCREMENT);
  const rows = result.rows.slice(0, maxRows);

  return (
    <>
      <div className="pgwasm-repl-table-scroll">
        <table className="pgwasm-repl-table">
          <thead>
            <tr>
              {result.fields.map((field, index) => (
                <th key={`${index}:${field.name}`}>{field.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              // Rows have no identity of their own; their position is theirs.
              <tr key={rowIndex}>
                {row.map((value, columnIndex) => (
                  <td key={columnIndex} className={cellClass(value)}>
                    {cellValue(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pgwasm-repl-table-row-count">
        {result.rows.length > maxRows ? `${maxRows} of ` : ""}
        {result.rows.length} rows{" "}
        {result.rows.length > maxRows && (
          <button
            type="button"
            className="pgwasm-repl-show-more"
            onClick={() => setMaxRows((previous) => previous + ROW_INCREMENT)}
          >
            Show more
          </button>
        )}
      </div>
    </>
  );
}
