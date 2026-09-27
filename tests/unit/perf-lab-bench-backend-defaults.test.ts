import { describe, expect, it } from "bun:test";

// The storage bench's default backend selection: `idb` and the constant-four-handle `opfs-repacked` are
// default-ticked on every engine class; `opfs-repacked-sw` only on webkit-like, the one engine class whose
// SharedWorker scope grants sync-access handles. This is that pure decision's unit test — the page wires it to
// the real `classifyOpfsEngineClass()` result. (The `opfs-ahp` column and its platform-aware default retired
// with the switch to pgwasm, ADR-0062.)
import {
  defaultBackendChecked,
  OPFS_REPACKED_SW_NON_WEBKIT_WARNING,
  opfsRepackedSwWarning,
} from "../../apps/perf-lab/src/bench/backend-defaults";
import type { OpfsEngineClass } from "../../apps/perf-lab/src/bench/engine-class";
import { BENCH_BACKENDS, parseRepackedExtentSize } from "../../apps/perf-lab/src/bench/protocol";

const ENGINE_CLASSES: OpfsEngineClass[] = ["chromium-like", "firefox", "webkit-like"];

describe("parseRepackedExtentSize — shared bench extent profiles", () => {
  it("defaults to 64 KiB and accepts the two recorded profiles", () => {
    expect(parseRepackedExtentSize(undefined)).toBe(65_536);
    expect(parseRepackedExtentSize("8192")).toBe(8192);
    expect(parseRepackedExtentSize("65536")).toBe(65_536);
  });

  it("rejects every unsupported profile", () => {
    for (const value of ["", "8193", "0", "NaN"]) {
      expect(() => parseRepackedExtentSize(value)).toThrow(TypeError);
    }
  });
});

describe("defaultBackendChecked — engine-class aware default ticking", () => {
  it("compares the three pgwasm backends", () => {
    expect(BENCH_BACKENDS).toEqual(["idb", "opfs-repacked", "opfs-repacked-sw"]);
  });

  it.each(ENGINE_CLASSES)("idb is always default-ticked (engine class %s)", (engineClass) => {
    expect(defaultBackendChecked("idb", engineClass)).toBe(true);
  });

  it.each(ENGINE_CLASSES)(
    "opfs-repacked is default-ticked with constant handle ownership (engine class %s)",
    (engineClass) => {
      expect(defaultBackendChecked("opfs-repacked", engineClass)).toBe(true);
    },
  );

  it("opfs-repacked-sw is default-ticked ONLY on webkit-like — the one engine class granting SharedWorker sync-access handles", () => {
    expect(defaultBackendChecked("opfs-repacked-sw", "webkit-like")).toBe(true);
    expect(defaultBackendChecked("opfs-repacked-sw", "chromium-like")).toBe(false);
    expect(defaultBackendChecked("opfs-repacked-sw", "firefox")).toBe(false);
  });

  it("the opfs-repacked-sw default and its warning are two views of the same decision", () => {
    for (const engineClass of ENGINE_CLASSES) {
      expect(defaultBackendChecked("opfs-repacked-sw", engineClass)).toBe(
        opfsRepackedSwWarning(engineClass) === undefined,
      );
    }
    expect(opfsRepackedSwWarning("webkit-like")).toBeUndefined();
    expect(opfsRepackedSwWarning("chromium-like")).toBe(OPFS_REPACKED_SW_NON_WEBKIT_WARNING);
    expect(opfsRepackedSwWarning("firefox")).toBe(OPFS_REPACKED_SW_NON_WEBKIT_WARNING);
  });
});
