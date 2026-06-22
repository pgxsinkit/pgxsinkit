import { describe, expect, it } from "bun:test";

import {
  type ConvergenceClient,
  type ConvergenceTrigger,
  createBrowserConvergenceTrigger,
  createConvergenceDriver,
  createIntervalConvergenceTrigger,
} from "../../packages/client/src/convergence";

// ADR-0005 decision 3: the opt-in convergence driver + the trigger seam.

function manualTrigger(shouldConverge = true) {
  let signal: (() => void) | null = null;
  const trigger: ConvergenceTrigger = {
    subscribe: (onSignal) => {
      signal = onSignal;
      return () => {
        signal = null;
      };
    },
    shouldConverge: () => shouldConverge,
  };
  return {
    trigger,
    fire: () => signal?.(),
    isSubscribed: () => signal !== null,
  };
}

function countingClient(): ConvergenceClient & { calls: { flush: number; reconcile: number; retryFailed: number } } {
  const calls = { flush: 0, reconcile: 0, retryFailed: 0 };
  return {
    calls,
    flush: async () => {
      calls.flush += 1;
    },
    reconcile: async () => {
      calls.reconcile += 1;
    },
    retryFailed: async () => {
      calls.retryFailed += 1;
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("convergence driver (ADR-0005)", () => {
  it("runs a convergence pass on start and on each trigger signal", async () => {
    const client = countingClient();
    const { trigger, fire } = manualTrigger();
    const driver = createConvergenceDriver({ client, trigger });

    driver.start();
    await tick();
    expect(client.calls).toEqual({ flush: 1, reconcile: 1, retryFailed: 1 });

    fire();
    await tick();
    expect(client.calls.flush).toBe(2);

    driver.stop();
  });

  it("does not converge while shouldConverge() is false", async () => {
    const client = countingClient();
    const { trigger, fire } = manualTrigger(false);
    const driver = createConvergenceDriver({ client, trigger });

    driver.start();
    fire();
    await tick();

    expect(client.calls.flush).toBe(0);
    driver.stop();
  });

  it("coalesces signals that arrive mid-pass into a single follow-up pass", async () => {
    let flushCount = 0;
    let releaseFirstFlush!: () => void;
    const client: ConvergenceClient = {
      retryFailed: async () => undefined,
      reconcile: async () => undefined,
      flush: async () => {
        flushCount += 1;
        if (flushCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstFlush = resolve;
          });
        }
      },
    };
    const { trigger, fire } = manualTrigger();
    const driver = createConvergenceDriver({ client, trigger });

    driver.start();
    await tick(); // pass 1 is now blocked inside flush #1
    expect(flushCount).toBe(1);

    fire();
    fire(); // two signals during the in-flight pass coalesce
    expect(flushCount).toBe(1);

    releaseFirstFlush();
    await tick();

    // Exactly one follow-up pass ran, not one per signal.
    expect(flushCount).toBe(2);
    driver.stop();
  });

  it("stops driving after stop()", async () => {
    const client = countingClient();
    const { trigger, fire, isSubscribed } = manualTrigger();
    const driver = createConvergenceDriver({ client, trigger });

    driver.start();
    await tick();
    const flushesAtStop = client.calls.flush;

    driver.stop();
    expect(isSubscribed()).toBe(false);

    fire();
    await tick();
    expect(client.calls.flush).toBe(flushesAtStop);
  });

  it("reports a pass error to onPass and keeps driving", async () => {
    const errors: unknown[] = [];
    let shouldThrow = true;
    const client: ConvergenceClient = {
      retryFailed: async () => undefined,
      reconcile: async () => undefined,
      flush: async () => {
        if (shouldThrow) {
          throw new Error("flush boom");
        }
      },
    };
    const { trigger, fire } = manualTrigger();
    const driver = createConvergenceDriver({
      client,
      trigger,
      onPass: (error) => {
        errors.push(error);
      },
    });

    driver.start();
    await tick();
    expect((errors[0] as Error)?.message).toBe("flush boom");

    shouldThrow = false;
    fire();
    await tick();
    expect(errors[1]).toBeNull(); // recovered

    driver.stop();
  });
});

describe("convergence triggers (the seam's two adapters)", () => {
  it("interval trigger fires on its cadence and stops on unsubscribe", async () => {
    const trigger = createIntervalConvergenceTrigger(5);
    expect(trigger.shouldConverge()).toBe(true);

    let signals = 0;
    const unsubscribe = trigger.subscribe(() => {
      signals += 1;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 18));
    unsubscribe();
    const afterUnsubscribe = signals;
    expect(afterUnsubscribe).toBeGreaterThan(0);

    await new Promise<void>((resolve) => setTimeout(resolve, 18));
    expect(signals).toBe(afterUnsubscribe);
  });

  it("browser trigger exposes a gating predicate and a disposable subscription", () => {
    const trigger = createBrowserConvergenceTrigger({ intervalMs: 1000 });

    // In a non-DOM env online/visibility are absent → not blocked.
    expect(typeof trigger.shouldConverge()).toBe("boolean");

    const unsubscribe = trigger.subscribe(() => undefined);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});
