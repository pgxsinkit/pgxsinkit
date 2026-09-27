// Began as a copy of `@electric-sql/pglite-repl` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { ReplTable } from "./repl-table";
import type { ReplResponse, ReplRows } from "./types";

function ResultLine({ result }: { readonly result: ReplRows }) {
  return (
    <div className="pgwasm-repl-line">
      {result.title !== undefined && <div className="pgwasm-repl-title">{result.title}</div>}
      {result.fields.length > 0 ? <ReplTable result={result} /> : <div className="pgwasm-repl-null">null</div>}
      {result.footers !== undefined && result.footers.length > 0 && (
        <pre className="pgwasm-repl-footers">{result.footers.join("\n")}</pre>
      )}
    </div>
  );
}

/** One input and what came back for it. */
export function ReplResponseView({
  response,
  showTime,
}: {
  readonly response: ReplResponse;
  readonly showTime: boolean;
}) {
  return (
    <>
      <pre className="pgwasm-repl-line pgwasm-repl-query">{response.query}</pre>
      {response.text !== undefined && <div className="pgwasm-repl-line pgwasm-repl-text">{response.text}</div>}
      {response.error !== undefined ? (
        <div className="pgwasm-repl-line pgwasm-repl-error">{response.error}</div>
      ) : (
        response.results?.map((result, index) => (
          // One statement's result per position in the input; nothing else identifies it.
          <ResultLine key={index} result={result} />
        ))
      )}
      <div className="pgwasm-repl-divider">
        <hr />
        {showTime && <div className="pgwasm-repl-time">{response.time.toFixed(1)}ms</div>}
      </div>
    </>
  );
}
