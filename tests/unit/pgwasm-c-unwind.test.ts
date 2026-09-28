// What the host treats as an Emscripten unwind (isEmscriptenUnwind) rather than an engine failure. Since
// pgwasm-postgres 18.6.1 (Emscripten 6.0.10), a longjmp that escapes every setjmp throws an instance of the
// glue's unexported `EmscriptenSjLj` class; 3.1.74 (18.3.0, 18.6.0) threw a number. The host recognises both.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isEmscriptenUnwind } from "../../packages/pgwasm-c/src/host/postgres-instance";

// The glue's own shapes (postgres.js): `class EmscriptenEH{}` and `class EmscriptenSjLj extends EmscriptenEH{}`,
// neither exported, so the test declares classes of the same names.
class EmscriptenEH {}
class EmscriptenSjLj extends EmscriptenEH {}
class ExitStatus {
  readonly name = "ExitStatus";
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

const GLUE = path.join(import.meta.dir, "../../packages/pgwasm-c/artefacts/postgres.js");

describe("isEmscriptenUnwind", () => {
  it("recognises the 'unwind' an intercepted siglongjmp and a Terminate throw", () => {
    expect(isEmscriptenUnwind("unwind")).toBe(true);
  });

  it("recognises an escaped longjmp on Emscripten 6 (an EmscriptenSjLj instance)", () => {
    expect(isEmscriptenUnwind(new EmscriptenSjLj())).toBe(true);
  });

  it("still recognises an escaped longjmp on Emscripten 3.1.74 (a number)", () => {
    expect(isEmscriptenUnwind(0)).toBe(true);
    expect(isEmscriptenUnwind(1)).toBe(true);
  });

  it("does not treat a FATAL's ExitStatus, an error or any other value as an unwind", () => {
    expect(isEmscriptenUnwind(new ExitStatus(1))).toBe(false);
    expect(isEmscriptenUnwind(new EmscriptenEH())).toBe(false);
    expect(isEmscriptenUnwind(new Error("unwind"))).toBe(false);
    expect(isEmscriptenUnwind(new RangeError("Maximum call stack size exceeded"))).toBe(false);
    expect(isEmscriptenUnwind({ constructor: { name: 1 } })).toBe(false);
    expect(isEmscriptenUnwind(Object.create(null))).toBe(false);
    expect(isEmscriptenUnwind({})).toBe(false);
    expect(isEmscriptenUnwind(null)).toBe(false);
    expect(isEmscriptenUnwind(undefined)).toBe(false);
    expect(isEmscriptenUnwind("abort")).toBe(false);
    expect(isEmscriptenUnwind(true)).toBe(false);
  });

  it("matches the class the pinned glue throws for an escaped longjmp", () => {
    const glue = readFileSync(GLUE, "utf8");
    expect(glue).toContain("class EmscriptenSjLj extends EmscriptenEH{}");
    expect(glue).toContain("throw new EmscriptenSjLj");
  });
});
