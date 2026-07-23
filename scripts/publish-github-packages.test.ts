import { describe, expect, test } from "bun:test";

import {
  type Manifest,
  type VersionContext,
  maxCore,
  nextPatch,
  pinSiblingDeps,
  targetVersion,
} from "./publish-github-packages";

const devCtx: VersionContext = {
  isReleaseTag: false,
  refName: "",
  devBaseFloor: "0.2.1",
  devPreId: "1782043909.abc1234",
};

const releaseCtx: VersionContext = {
  isReleaseTag: true,
  refName: "0.2.1",
  devBaseFloor: null,
  devPreId: "ignored",
};

describe("targetVersion", () => {
  test("release-parity uses the tag verbatim", () => {
    expect(targetVersion("0.0.0", releaseCtx)).toBe("0.2.1");
  });

  test("dev channel anchors above the latest release, regardless of the 0.0.0 placeholder", () => {
    expect(targetVersion("0.0.0", devCtx)).toBe("0.2.1-dev.1782043909.abc1234");
  });

  test("dev channel never sorts below the latest release", () => {
    const v = targetVersion("0.0.0", devCtx);
    // nextPatch(latest 0.2.0) == 0.2.1, so the dev pre-release is strictly above the 0.2.0 release.
    expect(Bun.semver.order(v, "0.2.0")).toBe(1);
    expect(Bun.semver.order(v, "0.2.1")).toBe(-1);
  });

  test("falls back to the package.json base when no release tags are reachable", () => {
    expect(targetVersion("0.0.0", { ...devCtx, devBaseFloor: null })).toBe("0.0.0-dev.1782043909.abc1234");
  });
});

describe("pinSiblingDeps", () => {
  const version = "0.2.1-dev.1782043909.abc1234";

  test("pins same-scope peerDependencies to the exact version (the release back-fill bug)", () => {
    // pgxsinkit has no same-scope peer today; this guards the moment one is added. Left as a `>=`
    // range, a dev consumer silently back-fills the latest *release* of the sibling (mixing dev +
    // release), because a pre-release dev version does NOT satisfy `>=0.2.0` under SemVer.
    const pkg: Manifest = {
      name: "@pgxsinkit/react",
      version: "0.0.0",
      peerDependencies: { "@pgxsinkit/client": ">=0.2.0" },
    };
    pinSiblingDeps(pkg, "@pgxsinkit/", version);
    expect((pkg["peerDependencies"] as Record<string, string>)["@pgxsinkit/client"]).toBe(version);

    // The pinned peer must satisfy itself — proving the dev build now resolves the dev sibling, not
    // a back-filled release (a `>=0.2.0` range does NOT match this pre-release under SemVer).
    expect(Bun.semver.satisfies(version, version)).toBe(true);
    expect(Bun.semver.satisfies(version, ">=0.2.0")).toBe(false);
  });

  test("pins runtime + optional same-scope deps, leaves foreign-scope deps untouched", () => {
    const pkg: Manifest = {
      name: "@pgxsinkit/client",
      version: "0.0.0",
      dependencies: { "@pgxsinkit/contracts": "workspace:*", zod: ">=4.4.0" },
      optionalDependencies: { "@pgxsinkit/schema": "workspace:*" },
      peerDependencies: { react: ">=19" },
    };
    pinSiblingDeps(pkg, "@pgxsinkit/", version);
    expect((pkg["dependencies"] as Record<string, string>)["@pgxsinkit/contracts"]).toBe(version);
    expect((pkg["dependencies"] as Record<string, string>)["zod"]).toBe(">=4.4.0");
    expect((pkg["optionalDependencies"] as Record<string, string>)["@pgxsinkit/schema"]).toBe(version);
    // Foreign-scope peers (react, zod) are a different scope and MUST stay ranges.
    expect((pkg["peerDependencies"] as Record<string, string>)["react"]).toBe(">=19");
  });
});

describe("semver helpers", () => {
  test("nextPatch bumps the patch component", () => {
    expect(nextPatch("0.2.0")).toBe("0.2.1");
  });

  test("maxCore returns the greater of two cores", () => {
    expect(maxCore("0.0.0", "0.2.1")).toBe("0.2.1");
    expect(maxCore("0.3.0", "0.2.9")).toBe("0.3.0");
  });
});
