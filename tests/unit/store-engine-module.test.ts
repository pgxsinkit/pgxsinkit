import { describe, expect, it } from "bun:test";
// The DECLARED store engine's module loading (ADR-0050 addendum 2026-09-08, packages/client/src/store-engine.ts)
// — the resolution only: which export is taken, how both ways of getting the module wrong fail, and that a
// module is loaded ONCE per scope, rejections included. No browser, no bundler, no real store: the loader is
// injected and each "store" is an identity-tagged sentinel, so a mint can be traced to the module that made it.

import { createStoreEngineResolver, loadStoreEngineFactory, type ClientPGlite } from "../../packages/client/src/index";

const MODULE = "/store-engine/factory.js";

const storeSentinel = (tag: string) => ({ tag }) as unknown as ClientPGlite;

describe("loadStoreEngineFactory — which export answers for the store", () => {
  it("takes the module's default export", async () => {
    const factory = await loadStoreEngineFactory(MODULE, () =>
      Promise.resolve({ default: (storePath: string) => Promise.resolve(storeSentinel(storePath)) }),
    );
    expect(await factory("store-a")).toEqual(storeSentinel("store-a"));
  });

  it("falls back to a named `createPglite` when there is no default", async () => {
    const factory = await loadStoreEngineFactory(MODULE, () =>
      Promise.resolve({ createPglite: (storePath: string) => Promise.resolve(storeSentinel(storePath)) }),
    );
    expect(await factory("store-b")).toEqual(storeSentinel("store-b"));
  });

  it("passes the mint arguments through unchanged — a store PATH and the internal memory selection", async () => {
    const mints: Array<[string, "memory" | undefined]> = [];
    const factory = await loadStoreEngineFactory(MODULE, () =>
      Promise.resolve({
        default: (storePath: string, backendOverride?: "memory") => {
          mints.push([storePath, backendOverride]);
          return Promise.resolve(storeSentinel(storePath));
        },
      }),
    );
    await factory("store-c");
    await factory("store-d", "memory");
    expect(mints).toEqual([
      ["store-c", undefined],
      ["store-d", "memory"],
    ]);
  });

  it("an unimportable module URL throws loudly, naming the module and keeping the cause", async () => {
    const cause = new Error("404");
    const failure: Error = await loadStoreEngineFactory(MODULE, () => Promise.reject(cause)).then(
      () => new Error("expected the load to fail"),
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain(MODULE);
    expect(failure.message).toContain("could not be imported");
    expect(failure.cause).toBe(cause);
  });

  it("a module with no callable export throws loudly rather than resolving to nothing", async () => {
    const failure: Error = await loadStoreEngineFactory(MODULE, () => Promise.resolve({ createPglite: 42 })).then(
      () => new Error("expected the load to fail"),
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain("exports no store factory");
  });
});

describe("createStoreEngineResolver — one load per module, for the scope's whole life", () => {
  it("imports a module once however many stores it mints", async () => {
    const urls: string[] = [];
    const resolve = createStoreEngineResolver((url) => {
      urls.push(url);
      return Promise.resolve({ default: (storePath: string) => Promise.resolve(storeSentinel(storePath)) });
    });

    const first = await resolve(MODULE);
    const second = await resolve(MODULE);
    expect(await first("store-e")).toEqual(storeSentinel("store-e"));
    expect(second).toBe(first);
    expect(urls).toEqual([MODULE]);
  });

  it("keeps a FAILED load failed — a half-started engine must never degrade to the built-in store", async () => {
    let attempts = 0;
    const resolve = createStoreEngineResolver(() => {
      attempts += 1;
      return Promise.reject(new Error("offline"));
    });

    const first: Error = await resolve(MODULE).then(
      () => new Error("expected the load to fail"),
      (error: unknown) => error as Error,
    );
    const second: Error = await resolve(MODULE).then(
      () => new Error("expected the load to fail"),
      (error: unknown) => error as Error,
    );
    expect(first.message).toMatch(/could not be imported/);
    expect(second).toBe(first);
    expect(attempts).toBe(1);
  });

  it("keys the memo by module URL, so two declared engines never cross-talk", async () => {
    const urls: string[] = [];
    const resolve = createStoreEngineResolver((url) => {
      urls.push(url);
      return Promise.resolve({ default: () => Promise.resolve(storeSentinel(url)) });
    });

    expect(await (await resolve("/store-engine/a.js"))("x")).toEqual(storeSentinel("/store-engine/a.js"));
    expect(await (await resolve("/store-engine/b.js"))("x")).toEqual(storeSentinel("/store-engine/b.js"));
    expect(urls).toEqual(["/store-engine/a.js", "/store-engine/b.js"]);
  });
});
