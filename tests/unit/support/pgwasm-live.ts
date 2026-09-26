/**
 * Waiting on live-query callbacks: a recorder keeps the latest delivery, and `next()` resolves on the
 * following one (or fails after a deadline, so a missing delivery fails the test instead of hanging it).
 */
export class Recorder<T> {
  latest: T | undefined;
  /** How many deliveries there have been. */
  deliveries = 0;
  #waiters: ((value: T) => void)[] = [];

  readonly callback = (value: T): void => {
    this.latest = value;
    this.deliveries++;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve(value);
  };

  /** The next delivery. Call before the change that causes it. */
  next(timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no live delivery within ${timeoutMs}ms`)), timeoutMs);
      this.#waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

/** Wait until there have been at least `count` deliveries. */
export async function deliveriesReach<T>(recorder: Recorder<T>, count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (recorder.deliveries < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} live deliveries, saw ${recorder.deliveries}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Resolve after `ms` milliseconds: for asserting that nothing more is delivered. */
export const quietFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
