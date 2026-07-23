import { describe, expect, it } from "bun:test";

// The opfs-ahp failure is a Chrome-on-Linux storage-service FD-limit wedge (~1070 open sync handles vs a
// zygote-inherited 1024 soft limit), NOT a generic "hangs off Firefox" story. So the default is PLATFORM-aware:
// default-ticked on firefox (any platform) and on chromium-like when the platform is Windows or macOS;
// default-unticked on chromium-like Linux/unknown (the FD wedge) and on webkit-like (the ~252 handle cap). The
// `opfs-repacked` owns four handles and is available on every supported engine class, so it is default-ticked
// alongside IDB. This is that pure decision's unit test — the page wires it to the real
// `classifyOpfsEngineClass()` result + `navigator.userAgentData.platform`.
import {
  type BenchPlatform,
  defaultBackendChecked,
  normalizePlatform,
  OPFS_AHP_LINUX_FD_WARNING,
  OPFS_AHP_WEBKIT_WARNING,
  OPFS_REPACKED_SW_NON_WEBKIT_WARNING,
  opfsAhpWarning,
  opfsRepackedSwWarning,
} from "../../apps/perf-lab/src/bench/backend-defaults";
import type { OpfsEngineClass } from "../../apps/perf-lab/src/bench/engine-class";
import { parseRepackedExtentSize } from "../../apps/perf-lab/src/bench/protocol";

const ENGINE_CLASSES: OpfsEngineClass[] = ["chromium-like", "firefox", "webkit-like"];
const PLATFORMS: BenchPlatform[] = ["windows", "macos", "linux", "unknown"];

describe("normalizePlatform — userAgentData.platform → BenchPlatform", () => {
  it("maps the known platform strings", () => {
    expect(normalizePlatform("Windows")).toBe("windows");
    expect(normalizePlatform("macOS")).toBe("macos");
    expect(normalizePlatform("Linux")).toBe("linux");
  });

  it("is case-insensitive and whitespace-trimming", () => {
    expect(normalizePlatform("WINDOWS")).toBe("windows");
    expect(normalizePlatform("MacOs")).toBe("macos");
    expect(normalizePlatform("  linux  ")).toBe("linux");
  });

  it("maps empty / undefined / unrecognized to unknown", () => {
    expect(normalizePlatform("")).toBe("unknown");
    expect(normalizePlatform(undefined)).toBe("unknown");
    expect(normalizePlatform(null)).toBe("unknown");
    expect(normalizePlatform("Android")).toBe("unknown");
    expect(normalizePlatform("Chrome OS")).toBe("unknown");
  });
});

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

describe("opfsAhpWarning — the platform-aware warning table", () => {
  it.each(PLATFORMS)("firefox never warns (opfs-ahp runs everywhere on Firefox) — platform %s", (platform) => {
    expect(opfsAhpWarning("firefox", platform)).toBeUndefined();
  });

  it("chromium-like on Windows/macOS does not warn (opfs-ahp runs there)", () => {
    expect(opfsAhpWarning("chromium-like", "windows")).toBeUndefined();
    expect(opfsAhpWarning("chromium-like", "macos")).toBeUndefined();
  });

  it("chromium-like on Linux/unknown warns with the FD-limit message (unknown = Linux-equivalent)", () => {
    expect(opfsAhpWarning("chromium-like", "linux")).toBe(OPFS_AHP_LINUX_FD_WARNING);
    expect(opfsAhpWarning("chromium-like", "unknown")).toBe(OPFS_AHP_LINUX_FD_WARNING);
  });

  it.each(PLATFORMS)("webkit-like always warns with the handle-cap message — platform %s", (platform) => {
    expect(opfsAhpWarning("webkit-like", platform)).toBe(OPFS_AHP_WEBKIT_WARNING);
  });
});

describe("defaultBackendChecked — engine + platform aware default ticking", () => {
  it.each(ENGINE_CLASSES)("idb is always default-ticked (engine class %s)", (engineClass) => {
    for (const platform of PLATFORMS) {
      expect(defaultBackendChecked("idb", engineClass, platform)).toBe(true);
    }
  });

  it.each(ENGINE_CLASSES)(
    "opfs-repacked is default-ticked with constant handle ownership (engine class %s)",
    (engineClass) => {
      for (const platform of PLATFORMS) {
        expect(defaultBackendChecked("opfs-repacked", engineClass, platform)).toBe(true);
      }
    },
  );

  it.each(PLATFORMS)("opfs-ahp is default-ticked on firefox regardless of platform (%s)", (platform) => {
    expect(defaultBackendChecked("opfs-ahp", "firefox", platform)).toBe(true);
  });

  it("opfs-ahp is default-ticked on chromium-like Windows/macOS", () => {
    expect(defaultBackendChecked("opfs-ahp", "chromium-like", "windows")).toBe(true);
    expect(defaultBackendChecked("opfs-ahp", "chromium-like", "macos")).toBe(true);
  });

  it("opfs-ahp is default-UNTICKED on chromium-like Linux/unknown (the FD wedge), but stays selectable", () => {
    expect(defaultBackendChecked("opfs-ahp", "chromium-like", "linux")).toBe(false);
    expect(defaultBackendChecked("opfs-ahp", "chromium-like", "unknown")).toBe(false);
  });

  it.each(PLATFORMS)("opfs-ahp is default-UNTICKED on webkit-like (~252 handle cap) — platform %s", (platform) => {
    expect(defaultBackendChecked("opfs-ahp", "webkit-like", platform)).toBe(false);
  });

  it("the checkbox default and the warning are two views of the same decision", () => {
    for (const engineClass of ENGINE_CLASSES) {
      for (const platform of PLATFORMS) {
        // opfs-ahp is default-off exactly where a warning applies.
        expect(defaultBackendChecked("opfs-ahp", engineClass, platform)).toBe(
          opfsAhpWarning(engineClass, platform) === undefined,
        );
      }
    }
  });

  it.each(PLATFORMS)(
    "opfs-repacked-sw is default-ticked ONLY on webkit-like — the one engine class granting SharedWorker sync-access handles (%s)",
    (platform) => {
      expect(defaultBackendChecked("opfs-repacked-sw", "webkit-like", platform)).toBe(true);
      expect(defaultBackendChecked("opfs-repacked-sw", "chromium-like", platform)).toBe(false);
      expect(defaultBackendChecked("opfs-repacked-sw", "firefox", platform)).toBe(false);
    },
  );

  it("the opfs-repacked-sw default and its warning are two views of the same decision", () => {
    for (const engineClass of ENGINE_CLASSES) {
      expect(defaultBackendChecked("opfs-repacked-sw", engineClass, "unknown")).toBe(
        opfsRepackedSwWarning(engineClass) === undefined,
      );
    }
    expect(opfsRepackedSwWarning("webkit-like")).toBeUndefined();
    expect(opfsRepackedSwWarning("chromium-like")).toBe(OPFS_REPACKED_SW_NON_WEBKIT_WARNING);
    expect(opfsRepackedSwWarning("firefox")).toBe(OPFS_REPACKED_SW_NON_WEBKIT_WARNING);
  });
});

describe("the warning copy shown next to the checkbox", () => {
  it("the Linux FD warning names the FD budget and the DefaultLimitNOFILE knob", () => {
    expect(OPFS_AHP_LINUX_FD_WARNING).toContain("file descriptors");
    expect(OPFS_AHP_LINUX_FD_WARNING).toContain("DefaultLimitNOFILE");
  });

  it("the WebKit warning names the handle cap and opfs-repacked", () => {
    expect(OPFS_AHP_WEBKIT_WARNING).toContain("252");
    expect(OPFS_AHP_WEBKIT_WARNING).toContain("opfs-repacked");
  });
});
