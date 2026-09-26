/**
 * A FIFO async mutex: `runExclusive` runs its callback once every earlier one has settled. Not
 * re-entrant — a callback that waits on the same mutex deadlocks, as with any mutex.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#tail.then(fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
