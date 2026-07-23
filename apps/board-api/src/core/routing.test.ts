import { describe, expect, test } from "bun:test";

import { stripFunctionPrefix } from "./routing";

describe("board function routing", () => {
  test("strips the Supabase function prefix", () => {
    const request = new Request("http://localhost/board-sync?table=team");
    expect(new URL(stripFunctionPrefix(request, "board-sync").url).pathname).toBe("/");
  });

  test("keeps the canonical board-write mutation subpath", () => {
    const request = new Request("http://localhost/board-write/api/mutations", { method: "POST" });
    expect(new URL(stripFunctionPrefix(request, "board-write").url).pathname).toBe("/api/mutations");
  });

  test("does not rewrite bare board-write POSTs", () => {
    const request = new Request("http://localhost/board-write", { method: "POST" });
    expect(new URL(stripFunctionPrefix(request, "board-write").url).pathname).toBe("/");
  });
});
