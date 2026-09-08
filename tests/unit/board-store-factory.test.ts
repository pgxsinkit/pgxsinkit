import { describe, expect, it } from "bun:test";

import type { ClientPGlite } from "@pgxsinkit/client";

import {
  BOARD_STORE_FACTORY_ENV,
  resolveBoardStoreFactory,
  type StoreFactoryEnv,
} from "../../apps/board/src/board/store-factory";

// Unit test of the board's local-store seam (apps/board/src/board/store-factory.ts) — the resolution only:
// unset ⇒ the built-in default, set ⇒ the module's factory, anything wrong with the module ⇒ a loud throw.
// No browser, no bundler, no real store: the env object and the module loader are both injected, and the
// "store" each factory hands back is an identity-tagged sentinel so a mint can be traced to its module.

const storeSentinel = (tag: string) => ({ tag }) as unknown as ClientPGlite;

const envWith = (url: string): StoreFactoryEnv => ({ [BOARD_STORE_FACTORY_ENV]: url });

describe("board local-store factory seam", () => {
  it("resolves to the built-in default when the module URL is absent or blank", () => {
    const loadNothing = () => Promise.reject(new Error("the loader must not run"));

    expect(resolveBoardStoreFactory({}, loadNothing)).toBeUndefined();
    expect(resolveBoardStoreFactory(envWith("   "), loadNothing)).toBeUndefined();
    expect(resolveBoardStoreFactory({ [BOARD_STORE_FACTORY_ENV]: 1 }, loadNothing)).toBeUndefined();
  });

  it("mints through the configured module, loading it once and passing the mint arguments through", async () => {
    const mints: Array<[string, "memory" | undefined]> = [];
    const urls: string[] = [];
    const load = (url: string) => {
      urls.push(url);
      return Promise.resolve({
        default: (storePath: string, backendOverride?: "memory") => {
          mints.push([storePath, backendOverride]);
          return Promise.resolve(storeSentinel(storePath));
        },
      });
    };

    const factory = resolveBoardStoreFactory(envWith(" https://engine.example/factory.js "), load);
    expect(factory).toBeDefined();
    expect(await factory?.("store-a")).toEqual(storeSentinel("store-a"));
    expect(await factory?.("store-b", "memory")).toEqual(storeSentinel("store-b"));

    // Trimmed to the bare URL, imported ONCE however many stores are minted.
    expect(urls).toEqual(["https://engine.example/factory.js"]);
    expect(mints).toEqual([
      ["store-a", undefined],
      ["store-b", "memory"],
    ]);
  });

  it("accepts a named `createPglite` export when the module has no default", async () => {
    const factory = resolveBoardStoreFactory(envWith("https://engine.example/named.js"), () =>
      Promise.resolve({ createPglite: (storePath: string) => Promise.resolve(storeSentinel(storePath)) }),
    );

    expect(await factory?.("store-c")).toEqual(storeSentinel("store-c"));
  });

  it("throws loudly, naming the variable and the URL, when the module cannot be imported", async () => {
    const cause = new Error("404");
    const factory = resolveBoardStoreFactory(envWith("https://engine.example/missing.js"), () => Promise.reject(cause));

    const failure = await factory?.("store-d").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`${BOARD_STORE_FACTORY_ENV}=https://engine.example/missing.js`);
    expect((failure as Error).message).toContain("could not be imported");
    expect((failure as Error).cause).toBe(cause);
  });

  it("throws loudly when the module exports no callable factory", async () => {
    const factory = resolveBoardStoreFactory(envWith("https://engine.example/empty.js"), () =>
      Promise.resolve({ createPglite: "not a function" }),
    );

    const failure = await factory?.("store-e").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("exports no store factory");
  });
});
