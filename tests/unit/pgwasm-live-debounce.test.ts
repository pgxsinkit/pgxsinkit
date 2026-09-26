// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { describe, expect, it } from "bun:test";

import { debounceMutex } from "../../packages/pgwasm/src/live/debounce-mutex";
import { rejectionOf } from "./support/rejection";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("debounceMutex", () => {
  it("runs the first and the last call, cancelling the ones between", async () => {
    const results: number[] = [];
    const debounced = debounceMutex(async (n: number) => {
      await delay(10);
      results.push(n);
      return n;
    });
    const returnValues = await Promise.all([debounced(1), debounced(2), debounced(3)]);
    expect(results).toEqual([1, 3]);
    expect(returnValues).toEqual([1, undefined, 3]);
  });

  it("keeps the call order whatever each call's duration", async () => {
    const results: number[] = [];
    const debounced = debounceMutex(async (n: number, delayMs: number) => {
      await delay(delayMs);
      results.push(n);
      return n;
    });
    const returnValues = await Promise.all([debounced(1, 50), debounced(2, 10), debounced(3, 10)]);
    expect(results).toEqual([1, 3]);
    expect(returnValues).toEqual([1, undefined, 3]);
  });

  it("rejects with the call's error", async () => {
    const debounced = debounceMutex(async () => {
      throw new Error("Test error");
    });
    expect((await rejectionOf(debounced())).message).toBe("Test error");
  });
});
