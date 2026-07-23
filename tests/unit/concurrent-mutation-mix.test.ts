import { describe, expect, it } from "bun:test";

import {
  applyConcurrentMutationToRowPool,
  buildConcurrentMutationPlan,
  cloneConcurrentRowPool,
  commitConcurrentBatchRowPools,
  createConcurrentRowPool,
  mergeConcurrentRowPools,
  pickConcurrentMutationKind,
  pickConcurrentPoolEntityId,
  reserveConcurrentDeletedEntities,
  resolveConcurrentMutationMix,
} from "../performance/support/concurrent-mutation-mix";

describe("concurrent mutation mix", () => {
  it("resolves update probability from create and delete probabilities", () => {
    const mix = resolveConcurrentMutationMix(0.2, 0.1);

    expect(mix.createProbability).toBe(0.2);
    expect(mix.deleteProbability).toBe(0.1);
    expect(mix.updateProbability).toBeCloseTo(0.7, 10);
  });

  it("falls back from delete to create when a table has no active rows", () => {
    const rowPool = createConcurrentRowPool([[]]);
    const mutationPlan = buildConcurrentMutationPlan({
      desiredKind: "delete",
      tableIndex: 0,
      selectionSequence: 3,
      rowPool,
    });

    expect(mutationPlan).toEqual({
      desiredKind: "delete",
      actualKind: "create",
      tableIndex: 0,
      entityId: null,
      fallbackApplied: true,
      skippedDelete: true,
    });
  });

  it("picks deterministic existing ids and removes deleted rows from future selection", () => {
    const rowPool = createConcurrentRowPool([["row-a", "row-b", "row-c"]]);
    expect(pickConcurrentPoolEntityId(rowPool.tableEntityIds[0] ?? [], 4)).toBe("row-b");

    const scratchPool = cloneConcurrentRowPool(rowPool);
    applyConcurrentMutationToRowPool({
      rowPool: scratchPool,
      tableIndex: 0,
      mutationKind: "delete",
      entityId: "row-b",
    });

    expect(scratchPool.tableEntityIds[0]).toEqual(["row-a", "row-c"]);
    expect(pickConcurrentPoolEntityId(scratchPool.tableEntityIds[0] ?? [], 1)).toBe("row-c");
  });

  it("adds created rows into the row pool for later updates or deletes", () => {
    const rowPool = createConcurrentRowPool([["seed-row"]]);

    applyConcurrentMutationToRowPool({
      rowPool,
      tableIndex: 0,
      mutationKind: "create",
      entityId: "created-row",
    });

    const mutationPlan = buildConcurrentMutationPlan({
      desiredKind: "update",
      tableIndex: 0,
      selectionSequence: 1,
      rowPool,
    });

    expect(mutationPlan.actualKind).toBe("update");
    expect(mutationPlan.entityId).toBe("created-row");
  });

  it("merges shared and local pools without duplicating ids", () => {
    const mergedPool = mergeConcurrentRowPools([
      createConcurrentRowPool([["shared-a", "shared-b"]]),
      createConcurrentRowPool([["shared-b", "local-a"]]),
    ]);

    expect(mergedPool.tableEntityIds[0]).toEqual(["shared-a", "shared-b", "local-a"]);
  });

  it("keeps creates local while removing deletes from both shared and local pools", () => {
    const sharedRowPool = createConcurrentRowPool([["shared-a", "shared-b"]]);
    const localRowPool = createConcurrentRowPool([["local-a"]]);

    commitConcurrentBatchRowPools({
      sharedRowPool,
      localRowPool,
      createdEntities: [{ tableIndex: 0, entityId: "created-a" }],
      deletedEntities: [
        { tableIndex: 0, entityId: "shared-a" },
        { tableIndex: 0, entityId: "local-a" },
      ],
    });

    expect(sharedRowPool.tableEntityIds[0]).toEqual(["shared-b"]);
    expect(localRowPool.tableEntityIds[0]).toEqual(["created-a"]);
  });

  it("does not keep rows that were created and deleted in the same batch", () => {
    const sharedRowPool = createConcurrentRowPool([["shared-a"]]);
    const localRowPool = createConcurrentRowPool([[]]);

    commitConcurrentBatchRowPools({
      sharedRowPool,
      localRowPool,
      createdEntities: [{ tableIndex: 0, entityId: "created-a" }],
      deletedEntities: [{ tableIndex: 0, entityId: "created-a" }],
    });

    expect(sharedRowPool.tableEntityIds[0]).toEqual(["shared-a"]);
    expect(localRowPool.tableEntityIds[0]).toEqual([]);
  });

  it("reserves deleted rows out of shared pools before convergence", () => {
    const sharedRowPool = createConcurrentRowPool([["shared-a", "shared-b"]]);
    const localRowPool = createConcurrentRowPool([["local-a", "shared-a"]]);

    reserveConcurrentDeletedEntities({
      sharedRowPool,
      localRowPool,
      deletedEntities: [{ tableIndex: 0, entityId: "shared-a" }],
    });

    expect(sharedRowPool.tableEntityIds[0]).toEqual(["shared-b"]);
    expect(localRowPool.tableEntityIds[0]).toEqual(["local-a"]);
  });

  it("selects create and delete kinds from deterministic samples", () => {
    const mix = resolveConcurrentMutationMix(0.2, 0.1);

    expect(pickConcurrentMutationKind(() => 0.05, mix)).toBe("create");
    expect(pickConcurrentMutationKind(() => 0.25, mix)).toBe("delete");
    expect(pickConcurrentMutationKind(() => 0.75, mix)).toBe("update");
  });
});
