import { describe, expect, it } from "bun:test";

import { escapeSqlLiteral, maybeQuoteIdentifier, quoteIdentifier, quoteSqlLiteral } from "@pgxsinkit/contracts";

// The single SQL identifier/literal resolver every package now routes through
// (ADR-0004). Previously five-plus copies disagreed; the mutation path even left
// reserved-word table names unquoted. These pin the one definition.

describe("sql identifier resolver (ADR-0004)", () => {
  it("always quotes identifiers and doubles embedded quotes", () => {
    expect(quoteIdentifier("owner_id")).toBe(`"owner_id"`);
    expect(quoteIdentifier(`a"b`)).toBe(`"a""b"`);
  });

  it("leaves simple non-reserved names bare and quotes the rest", () => {
    // Covers the bare-safe + reserved-keyword decisions (now private to maybeQuoteIdentifier):
    expect(maybeQuoteIdentifier("todos")).toBe("todos");
    expect(maybeQuoteIdentifier("_x1")).toBe("_x1");
    // The regression: a reserved-word table name must be quoted, not emitted bare.
    expect(maybeQuoteIdentifier("group")).toBe(`"group"`);
    expect(maybeQuoteIdentifier("order")).toBe(`"order"`);
    // Uppercase would be folded to lowercase by Postgres, so it is quoted.
    expect(maybeQuoteIdentifier("Todos")).toBe(`"Todos"`);
    expect(maybeQuoteIdentifier("with space")).toBe(`"with space"`);
  });

  it("escapes and quotes string literals", () => {
    expect(escapeSqlLiteral("x' OR '1'='1")).toBe("x'' OR ''1''=''1");
    expect(quoteSqlLiteral("a'b")).toBe("'a''b'");
  });
});
