// Began as a copy of `@electric-sql/pglite-repl` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

/**
 * The REPL's stylesheet. It ships as a string, not a `.css` import (which only some bundlers can load):
 * the component renders it as a React-hoisted `<style>`, which React inserts into the document once,
 * however many REPLs are mounted. Every class is prefixed `pgwasm-repl-`. `--pgwasm-repl-font-size`
 * sets the size; the colours and borders follow the editor's theme.
 */
export const REPL_STYLESHEET_ID = "pgwasm-repl";

export const REPL_STYLES = `
.pgwasm-repl-root {
  --pgwasm-repl-fg: var(--pgwasm-repl-foreground-color);
  --pgwasm-repl-bg: var(--pgwasm-repl-background-color);
  --pgwasm-repl-size: var(--pgwasm-repl-font-size, 12px);
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  font-size: var(--pgwasm-repl-size);
  color: var(--pgwasm-repl-fg);
  background-color: var(--pgwasm-repl-bg);
}
.pgwasm-repl-loading-msg {
  opacity: 0.5;
}
.pgwasm-repl-root table {
  font-size: var(--pgwasm-repl-size);
}
.pgwasm-repl-root-border {
  border: var(--pgwasm-repl-border);
}
.pgwasm-repl-output {
  flex: 1;
  overflow-y: auto;
  padding: 0.5em 0 0.5em 0.5em;
  border-bottom: var(--pgwasm-repl-border);
}
.pgwasm-repl-root hr {
  margin: 0.5em 0;
  border: none;
  border-top: var(--pgwasm-repl-border);
}
.pgwasm-repl-input {
  display: flex;
  min-height: 60px;
  max-height: 50%;
  width: 100%;
}
.pgwasm-repl-input .cm-editor.cm-focused {
  outline: none;
}
.pgwasm-repl-input-loading {
  pointer-events: none;
}
.pgwasm-repl-table-scroll {
  overflow-x: auto;
}
.pgwasm-repl-table {
  border-collapse: collapse;
}
.pgwasm-repl-line {
  margin: 0 0 0 1em;
  position: relative;
}
.pgwasm-repl-line::before {
  display: block;
  width: 0.7em;
  text-align: center;
  content: "\\276E";
  margin-right: 0.5em;
  color: var(--pgwasm-repl-border-color);
  position: absolute;
  left: -1em;
}
.pgwasm-repl-line + .pgwasm-repl-line {
  margin-top: 0.25em;
}
.pgwasm-repl-query {
  margin: 0 0 0.25em 1em;
}
.pgwasm-repl-query::before {
  content: "\\276F";
}
.pgwasm-repl-table th {
  text-align: center;
  font-weight: 600;
}
.pgwasm-repl-table td {
  text-align: left;
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pgwasm-repl-table .pgwasm-repl-number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pgwasm-repl-table .pgwasm-repl-boolean {
  text-align: center;
}
.pgwasm-repl-table th,
.pgwasm-repl-table td {
  padding: 0 0.2em;
  border: var(--pgwasm-repl-border);
}
.pgwasm-repl-divider {
  font-size: 9px;
  display: flex;
  align-items: center;
  color: var(--pgwasm-repl-border-color);
  padding-right: 0.5em;
}
.pgwasm-repl-divider hr {
  margin: 0;
  flex-grow: 1;
}
.pgwasm-repl-time {
  margin: 0 0.5em;
}
.pgwasm-repl-null {
  color: var(--pgwasm-repl-border-color);
}
.pgwasm-repl-error {
  color: #c33;
}
.pgwasm-repl-error::before {
  content: "!";
  color: #c33;
  font-weight: bold;
}
.pgwasm-repl-title {
  font-weight: 600;
}
.pgwasm-repl-footers {
  margin: 0.25em 0 0;
}
.pgwasm-repl-show-more {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
`;
