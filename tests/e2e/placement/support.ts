// Shared helpers for the ADR-0049 placement lanes — a typed bridge to the page's `window.__placement` hooks.

import type { Page } from "@playwright/test";

import type { PlacementHarness } from "./harness";

type HarnessFn<K extends keyof PlacementHarness> = Extract<PlacementHarness[K], (...args: never[]) => unknown>;

/** Invoke a `window.__placement` hook in the page, forwarding structured-cloneable args and its result. */
export function harnessCall<K extends keyof PlacementHarness>(
  page: Page,
  method: K,
  ...args: Parameters<HarnessFn<K>>
): Promise<Awaited<ReturnType<HarnessFn<K>>>> {
  return page.evaluate(
    ({ m, a }) =>
      (window.__placement[m as keyof PlacementHarness] as (...x: unknown[]) => unknown)(...(a as unknown[])),
    { m: method as string, a: args },
  ) as Promise<Awaited<ReturnType<HarnessFn<K>>>>;
}

/** A per-test unique store path so distinct SharedWorker instances never dedupe across lanes. */
export const uniqueStore = (label: string): string =>
  `placement-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── SERVER-lane control surface (node/test side; set only under the container launcher) ──
/** The fixture server base URL, or undefined in the serverless suite (the server lanes skip). */
export const PLACEMENT_SERVER_URL = process.env["PLACEMENT_SERVER_URL"];

/** Toggle/read the fixture write behaviour and its monotonic dispatch count. */
export async function serverControl(patch: { writeDelayMs?: number; refuseWrites?: boolean }): Promise<{
  writeDelayMs: number;
  refuseWrites: boolean;
  writesStarted: number;
}> {
  const response = await fetch(`${PLACEMENT_SERVER_URL}/__control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return (await response.json()) as { writeDelayMs: number; refuseWrites: boolean; writesStarted: number };
}

/** The server-side `fk_parents` row count — the exactly-once convergence truth. */
export async function serverCount(): Promise<number> {
  const res = await fetch(`${PLACEMENT_SERVER_URL}/__count`);
  return ((await res.json()) as { count: number }).count;
}
