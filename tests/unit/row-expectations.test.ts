import { describe, expect, it } from "bun:test";

import { selectRowExpectationsForVerification } from "../performance/support/row-expectations";

describe("row expectation selection", () => {
  it("keeps only the final expected state for each entity", () => {
    expect(
      selectRowExpectationsForVerification([
        { tableName: "perf_items_003", entityId: "row-a", shouldExist: true },
        { tableName: "perf_items_003", entityId: "row-b", shouldExist: true },
        { tableName: "perf_items_003", entityId: "row-a", shouldExist: false },
      ]),
    ).toEqual([
      { tableName: "perf_items_003", entityId: "row-b", shouldExist: true },
      { tableName: "perf_items_003", entityId: "row-a", shouldExist: false },
    ]);
  });

  it("trims after collapsing to final entity states", () => {
    const expectations = Array.from({ length: 10 }, (_, index) => ({
      tableName: "perf_items_001",
      entityId: `row-${index}`,
      shouldExist: true,
    }));

    expectations.splice(2, 0, {
      tableName: "perf_items_001",
      entityId: "row-8",
      shouldExist: false,
    });

    expect(selectRowExpectationsForVerification(expectations, 4)).toEqual([
      { tableName: "perf_items_001", entityId: "row-6", shouldExist: true },
      { tableName: "perf_items_001", entityId: "row-7", shouldExist: true },
      { tableName: "perf_items_001", entityId: "row-8", shouldExist: true },
      { tableName: "perf_items_001", entityId: "row-9", shouldExist: true },
    ]);
  });
});
