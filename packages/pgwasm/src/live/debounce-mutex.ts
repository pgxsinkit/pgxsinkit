// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * Run at most one call at a time, and collapse waiting calls into the latest: a call made while one
 * runs is scheduled after it, replacing (and resolving to `undefined`) any call already scheduled.
 */
export function debounceMutex<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | undefined> {
  let next:
    | {
        args: A;
        resolve: (value: R | undefined) => void;
        reject: (reason?: unknown) => void;
      }
    | undefined;
  let isRunning = false;

  const processNext = async (): Promise<void> => {
    const current = next;
    if (!current) {
      isRunning = false;
      return;
    }
    isRunning = true;
    next = undefined;
    try {
      current.resolve(await fn(...current.args));
    } catch (error) {
      current.reject(error);
    } finally {
      void processNext();
    }
  };

  return async (...args: A) => {
    next?.resolve(undefined);
    const promise = new Promise<R | undefined>((resolve, reject) => {
      next = { args, resolve, reject };
    });
    if (!isRunning) void processNext();
    return await promise;
  };
}
