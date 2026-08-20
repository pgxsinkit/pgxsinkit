import { expect, it } from "bun:test";

import { createShapeGroup, type ShapeGroupBatch } from "@pgxsinkit/client";
import type { StreamEnvelope } from "@pgxsinkit/contracts";

// The multi-stream coordinator (ADR-0055 decisions 4 + 10). @durable-streams/client reads ONE
// stream, so the K-streams layer is ours permanently. Two properties carry weight here: deliveries
// are serialized (the apply path's inbox and commit queue assume one batch at a time, and K streams
// answer concurrently), and group up-to-date is the ADR-0031 alignment — every shape, not any.

function envelope(key: string): StreamEnvelope {
  return { type: "offering_content", key, value: { id: key }, headers: { operation: "upsert" } };
}

/** A durable-streams catch-up response: the envelopes, plus the headers the client reads off it. */
function dsResponse(envelopes: StreamEnvelope[], offset: string, upToDate = true): Response {
  return new Response(JSON.stringify(envelopes), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Stream-Next-Offset": offset,
      ...(upToDate ? { "Stream-Up-To-Date": "true" } : {}),
    },
  });
}

it("delivers every shape's envelopes and aligns up-to-date across the whole group", async () => {
  const served = new Map([
    ["http://edge/shape/s1", dsResponse([envelope("a"), envelope("b")], "off-1")],
    ["http://edge/shape/s2", dsResponse([envelope("c")], "off-2")],
  ]);

  const group = createShapeGroup({
    shapes: { scopeA: { url: "http://edge/shape/s1" }, scopeB: { url: "http://edge/shape/s2" } },
    token: () => "t",
    live: false,
    fetch: (async (input: URL | string) => {
      const url = new URL(String(input));
      return served.get(`${url.origin}${url.pathname}`)!.clone();
    }) as unknown as typeof fetch,
  });

  const batches: ShapeGroupBatch[] = [];
  group.subscribe((batch) => {
    batches.push(batch);
  });

  expect(group.isUpToDate).toBe(false);
  expect(group.pending.sort()).toEqual(["scopeA", "scopeB"]);

  await group.start();
  await Bun.sleep(50);

  expect(group.isUpToDate).toBe(true);
  expect(batches.flatMap((b) => b.envelopes.map((e) => e.key)).sort()).toEqual(["a", "b", "c"]);
  expect(new Set(batches.map((b) => b.shape))).toEqual(new Set(["scopeA", "scopeB"]));

  group.unsubscribeAll();
});

// A slow subscriber must not be re-entered while it is still applying. K concurrent streams make
// this the default failure rather than an edge case.
it("never overlaps deliveries, however many streams answer at once", async () => {
  const shapes = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [`scope${index}`, { url: `http://edge/shape/s${index}` }]),
  );

  const group = createShapeGroup({
    shapes,
    token: () => "t",
    live: false,
    fetch: (async (input: URL | string) => {
      const key = new URL(String(input)).pathname.split("/").pop()!;
      return dsResponse([envelope(key)], "off-1");
    }) as unknown as typeof fetch,
  });

  let inFlight = 0;
  let maxInFlight = 0;
  let delivered = 0;
  group.subscribe(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(5);
    delivered += 1;
    inFlight -= 1;
  });

  await group.start();
  await Bun.sleep(200);

  expect(delivered).toBe(4);
  expect(maxInFlight).toBe(1);

  group.unsubscribeAll();
});
