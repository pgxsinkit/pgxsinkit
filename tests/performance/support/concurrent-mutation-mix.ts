export type ConcurrentMutationKind = "create" | "update" | "delete";

export interface ConcurrentMutationMix {
  createProbability: number;
  updateProbability: number;
  deleteProbability: number;
}

export interface ConcurrentRowPool {
  tableEntityIds: string[][];
}

export interface ConcurrentRowEntityRef {
  tableIndex: number;
  entityId: string;
}

export interface ConcurrentMutationPlan {
  desiredKind: ConcurrentMutationKind;
  actualKind: ConcurrentMutationKind;
  tableIndex: number;
  entityId: string | null;
  fallbackApplied: boolean;
  skippedDelete: boolean;
}

export function resolveConcurrentMutationMix(
  createProbability: number,
  deleteProbability: number,
): ConcurrentMutationMix {
  const normalizedCreate = clampProbability(createProbability);
  const normalizedDelete = clampProbability(deleteProbability);
  const totalNonUpdate = Math.min(1, normalizedCreate + normalizedDelete);
  const scale = totalNonUpdate > 1 ? 1 / totalNonUpdate : 1;
  const scaledCreate = normalizedCreate * scale;
  const scaledDelete = normalizedDelete * scale;

  return {
    createProbability: scaledCreate,
    updateProbability: Math.max(0, 1 - scaledCreate - scaledDelete),
    deleteProbability: scaledDelete,
  };
}

export function pickConcurrentMutationKind(random: () => number, mix: ConcurrentMutationMix): ConcurrentMutationKind {
  const sample = random();

  if (sample < mix.createProbability) {
    return "create";
  }

  if (sample < mix.createProbability + mix.deleteProbability) {
    return "delete";
  }

  return "update";
}

export function createConcurrentRowPool(tableEntityIds: string[][]): ConcurrentRowPool {
  return {
    tableEntityIds: tableEntityIds.map((entityIds) => [...entityIds]),
  };
}

export function cloneConcurrentRowPool(pool: ConcurrentRowPool): ConcurrentRowPool {
  return createConcurrentRowPool(pool.tableEntityIds);
}

export function mergeConcurrentRowPools(pools: ReadonlyArray<ConcurrentRowPool>): ConcurrentRowPool {
  const tableCount = pools.reduce((maxTableCount, pool) => Math.max(maxTableCount, pool.tableEntityIds.length), 0);
  const mergedTableEntityIds = Array.from({ length: tableCount }, (_, tableIndex) => {
    const mergedEntityIds: string[] = [];
    const seenEntityIds = new Set<string>();

    for (const pool of pools) {
      for (const entityId of pool.tableEntityIds[tableIndex] ?? []) {
        if (seenEntityIds.has(entityId)) {
          continue;
        }

        seenEntityIds.add(entityId);
        mergedEntityIds.push(entityId);
      }
    }

    return mergedEntityIds;
  });

  return createConcurrentRowPool(mergedTableEntityIds);
}

export function commitConcurrentBatchRowPools(options: {
  sharedRowPool: ConcurrentRowPool;
  localRowPool: ConcurrentRowPool;
  createdEntities: ReadonlyArray<ConcurrentRowEntityRef>;
  deletedEntities: ReadonlyArray<ConcurrentRowEntityRef>;
}) {
  const { sharedRowPool, localRowPool, createdEntities, deletedEntities } = options;
  const deletedEntityKeys = new Set(
    deletedEntities.map((deletedEntity) => `${deletedEntity.tableIndex}:${deletedEntity.entityId}`),
  );

  reserveConcurrentDeletedEntities({
    sharedRowPool,
    localRowPool,
    deletedEntities,
  });

  for (const createdEntity of createdEntities) {
    if (deletedEntityKeys.has(`${createdEntity.tableIndex}:${createdEntity.entityId}`)) {
      continue;
    }

    applyConcurrentMutationToRowPool({
      rowPool: localRowPool,
      tableIndex: createdEntity.tableIndex,
      mutationKind: "create",
      entityId: createdEntity.entityId,
    });
  }
}

export function reserveConcurrentDeletedEntities(options: {
  sharedRowPool: ConcurrentRowPool;
  localRowPool: ConcurrentRowPool;
  deletedEntities: ReadonlyArray<ConcurrentRowEntityRef>;
}) {
  const { sharedRowPool, localRowPool, deletedEntities } = options;

  for (const deletedEntity of deletedEntities) {
    applyConcurrentMutationToRowPool({
      rowPool: sharedRowPool,
      tableIndex: deletedEntity.tableIndex,
      mutationKind: "delete",
      entityId: deletedEntity.entityId,
    });
    applyConcurrentMutationToRowPool({
      rowPool: localRowPool,
      tableIndex: deletedEntity.tableIndex,
      mutationKind: "delete",
      entityId: deletedEntity.entityId,
    });
  }
}

export function buildConcurrentMutationPlan(options: {
  desiredKind: ConcurrentMutationKind;
  tableIndex: number;
  selectionSequence: number;
  rowPool: ConcurrentRowPool;
}): ConcurrentMutationPlan {
  const { desiredKind, tableIndex, selectionSequence, rowPool } = options;
  const availableEntityIds = rowPool.tableEntityIds[tableIndex] ?? [];

  if (desiredKind === "create") {
    return {
      desiredKind,
      actualKind: "create",
      tableIndex,
      entityId: null,
      fallbackApplied: false,
      skippedDelete: false,
    };
  }

  if (availableEntityIds.length === 0) {
    return {
      desiredKind,
      actualKind: "create",
      tableIndex,
      entityId: null,
      fallbackApplied: true,
      skippedDelete: desiredKind === "delete",
    };
  }

  return {
    desiredKind,
    actualKind: desiredKind,
    tableIndex,
    entityId: pickConcurrentPoolEntityId(availableEntityIds, selectionSequence),
    fallbackApplied: false,
    skippedDelete: false,
  };
}

export function applyConcurrentMutationToRowPool(options: {
  rowPool: ConcurrentRowPool;
  tableIndex: number;
  mutationKind: ConcurrentMutationKind;
  entityId: string;
}) {
  const { rowPool, tableIndex, mutationKind, entityId } = options;
  const tableEntityIds = rowPool.tableEntityIds[tableIndex] ?? [];

  if (!rowPool.tableEntityIds[tableIndex]) {
    rowPool.tableEntityIds[tableIndex] = tableEntityIds;
  }

  if (mutationKind === "create") {
    tableEntityIds.push(entityId);
    return;
  }

  if (mutationKind !== "delete") {
    return;
  }

  const entityIndex = tableEntityIds.indexOf(entityId);

  if (entityIndex >= 0) {
    tableEntityIds.splice(entityIndex, 1);
  }
}

export function pickConcurrentPoolEntityId(entityIds: string[], selectionSequence: number): string | null {
  if (entityIds.length === 0) {
    return null;
  }

  const index = Math.abs(selectionSequence) % entityIds.length;
  return entityIds[index] ?? null;
}

function clampProbability(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
