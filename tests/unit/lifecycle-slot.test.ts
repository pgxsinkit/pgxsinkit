import { describe, expect, it } from "bun:test";
// The single-occupancy engine lifecycle slot (ADR-0035 decision 4): one operation at a time, a second
// entrant refused immediately with a typed busy error (no queueing). Pure — no PGlite, no bridge.

import { createLifecycleSlot, LifecycleBusyError } from "../../packages/client/src/lifecycle-slot";

describe("lifecycle slot (ADR-0035 decision 4)", () => {
  it("runs an operation and returns its value, releasing the slot afterwards", async () => {
    const slot = createLifecycleSlot();
    expect(slot.isBusy()).toBe(false);

    const value = await slot.run("exportStore", async () => "done");
    expect(value).toBe("done");
    // Released → a follow-up operation runs cleanly.
    expect(slot.isBusy()).toBe(false);
    expect(await slot.run("exportStore", async () => 42)).toBe(42);
  });

  it("refuses a second operation while one is in flight, with a typed busy error naming the holder", async () => {
    const slot = createLifecycleSlot();

    // Hold the slot open with a controlled promise (the slot's own API), so the second call collides.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = slot.run("exportStore", () => held);
    expect(slot.isBusy()).toBe(true);
    expect(slot.runningLabel()).toBe("exportStore");

    // The second entrant is refused synchronously (in its own microtask) — WITHOUT invoking its fn.
    let fnRan = false;
    let caught: unknown;
    try {
      await slot.run("destroy", async () => {
        fnRan = true;
      });
    } catch (error) {
      caught = error;
    }
    expect(fnRan).toBe(false);
    expect(caught).toBeInstanceOf(LifecycleBusyError);
    expect((caught as LifecycleBusyError).runningLabel).toBe("exportStore");
    expect((caught as LifecycleBusyError).attemptedLabel).toBe("destroy");

    // Release the first → the slot frees and accepts the next operation.
    release();
    await first;
    expect(slot.isBusy()).toBe(false);
    await slot.run("destroy", async () => undefined);
  });

  it("releases the slot even when the running operation throws", async () => {
    const slot = createLifecycleSlot();
    let thrown = "";
    try {
      await slot.run("exportStore", async () => {
        throw new Error("boom");
      });
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toBe("boom");
    // Failure must not wedge the slot.
    expect(slot.isBusy()).toBe(false);
    expect(await slot.run("exportStore", async () => "recovered")).toBe("recovered");
  });
});
