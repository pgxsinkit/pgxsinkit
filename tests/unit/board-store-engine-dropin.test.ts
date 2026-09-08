import { describe, expect, it } from "bun:test";
// The board's store-engine DROP-IN convention (apps/board/src/board/store-engine-dropin.ts) — the discovery
// only: where the manifest lives under the app's base URL, which manifests name a usable engine, and the two
// conditions under which nothing at all is offered. No browser, no network, no engine: `fetch` is injected
// and cross-origin isolation is a parameter, exactly as the login screen supplies them.
//
// The manifest is REQUIRED and there is deliberately no file-name fallback: guessing an engine's bundle name
// is precisely the engine-specific knowledge the local-store seam exists to keep out of this repo.

import {
  parseStoreEngineManifest,
  probeStoreEngineDropIn,
  storeEngineManifestUrl,
  storeEngineModuleLabel,
} from "../../apps/board/src/board/store-engine-dropin";

const manifestResponse = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const missing = () => Promise.resolve({ ok: false, json: () => Promise.reject(new Error("no body")) });

describe("where the drop-in lives", () => {
  it("hangs off the app's BASE URL, so a subpath build finds its own copy", () => {
    expect(storeEngineManifestUrl("/")).toBe("/store-engine/manifest.json");
    expect(storeEngineManifestUrl("/demo/")).toBe("/demo/store-engine/manifest.json");
    // A base without its trailing slash is still a base, not a sibling path.
    expect(storeEngineManifestUrl("/demo")).toBe("/demo/store-engine/manifest.json");
  });
});

describe("parseStoreEngineManifest — which manifests name a usable engine", () => {
  it("resolves the factory against the drop-in directory and takes the display name", () => {
    expect(parseStoreEngineManifest("/", { factory: "some-store-factory.js", name: "Some Engine" })).toEqual({
      module: "/store-engine/some-store-factory.js",
      name: "Some Engine",
    });
    expect(parseStoreEngineManifest("/demo/", { factory: "some-store-factory.js", name: "Some Engine" })).toEqual({
      module: "/demo/store-engine/some-store-factory.js",
      name: "Some Engine",
    });
  });

  it("falls back to the factory's file name when the display name is missing or blank", () => {
    // Cosmetic: a drop-in that works is not hidden over a field nobody filled in.
    expect(parseStoreEngineManifest("/", { factory: "engine.js" })?.name).toBe("engine.js");
    expect(parseStoreEngineManifest("/", { factory: "engine.js", name: "  " })?.name).toBe("engine.js");
  });

  it("refuses a factory that is not a plain file INSIDE the drop-in directory", () => {
    // The manifest is somebody else's file dropped into `public/`, so it is input, not configuration this
    // repo wrote — it names the drop-in's own factory or it names nothing.
    expect(parseStoreEngineManifest("/", { factory: "/elsewhere/factory.js" })).toBeUndefined();
    expect(parseStoreEngineManifest("/", { factory: "https://elsewhere.example/factory.js" })).toBeUndefined();
    expect(parseStoreEngineManifest("/", { factory: "../../factory.js" })).toBeUndefined();
    expect(parseStoreEngineManifest("/", { factory: "" })).toBeUndefined();
  });

  it("refuses a body that is not a manifest at all", () => {
    expect(parseStoreEngineManifest("/", null)).toBeUndefined();
    expect(parseStoreEngineManifest("/", "manifest.json")).toBeUndefined();
    expect(parseStoreEngineManifest("/", { name: "No factory named" })).toBeUndefined();
  });
});

describe("probeStoreEngineDropIn — the one input the engine preference needs", () => {
  const manifest = { factory: "some-store-factory.js", name: "Some Engine" };

  it("finds the drop-in on an isolated page", async () => {
    const asked: string[] = [];
    const found = await probeStoreEngineDropIn({
      base: "/",
      isolated: true,
      fetch: (url) => {
        asked.push(url);
        return manifestResponse(manifest);
      },
    });
    expect(found).toEqual({ module: "/store-engine/some-store-factory.js", name: "Some Engine" });
    expect(asked).toEqual(["/store-engine/manifest.json"]);
  });

  it("offers NOTHING on a page that is not cross-origin isolated, without even asking", async () => {
    // Isolation is a property of the served headers (VITE_BOARD_ISOLATED=1), not a run-time choice, so an
    // engine that needs it could only refuse to construct — offering it would be a promise the page cannot keep.
    let asked = 0;
    const found = await probeStoreEngineDropIn({
      base: "/",
      isolated: false,
      fetch: () => {
        asked += 1;
        return manifestResponse(manifest);
      },
    });
    expect(found).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("offers nothing when there is no manifest, a malformed one, or the fetch fails", async () => {
    expect(await probeStoreEngineDropIn({ base: "/", isolated: true, fetch: missing })).toBeUndefined();
    expect(
      await probeStoreEngineDropIn({ base: "/", isolated: true, fetch: () => manifestResponse({ nope: 1 }) }),
    ).toBeUndefined();
    expect(
      await probeStoreEngineDropIn({ base: "/", isolated: true, fetch: () => Promise.reject(new Error("offline")) }),
    ).toBeUndefined();
    // A directory that serves an HTML 404 page with a 200: the JSON parse throws, and that is still "nothing".
    expect(
      await probeStoreEngineDropIn({
        base: "/",
        isolated: true,
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("<!doctype html>")) }),
      }),
    ).toBeUndefined();
  });
});

describe("storeEngineModuleLabel — naming an engine whose manifest is no longer readable", () => {
  it("shows the module's file name, which is enough to recognise and enough to leave", () => {
    expect(storeEngineModuleLabel("/store-engine/some-store-factory.js")).toBe("some-store-factory.js");
    expect(storeEngineModuleLabel("https://engine.example/build/factory.js")).toBe("factory.js");
    expect(storeEngineModuleLabel("factory.js")).toBe("factory.js");
  });
});
