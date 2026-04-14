export interface RowPresenceExpectation {
  tableName: string;
  entityId: string;
  shouldExist: boolean;
}

export function selectRowExpectationsForVerification(expectations: RowPresenceExpectation[], maxCount = 8) {
  const finalExpectationsByEntity = new Set<string>();
  const normalized: RowPresenceExpectation[] = [];

  for (let index = expectations.length - 1; index >= 0; index -= 1) {
    const expectation = expectations[index]!;
    const key = `${expectation.tableName}:${expectation.entityId}`;

    if (finalExpectationsByEntity.has(key)) {
      continue;
    }

    finalExpectationsByEntity.add(key);
    normalized.push(expectation);
  }

  normalized.reverse();

  if (normalized.length <= maxCount) {
    return normalized;
  }

  return normalized.slice(-maxCount);
}
