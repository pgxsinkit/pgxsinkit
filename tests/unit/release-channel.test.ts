import { describe, expect, test } from "bun:test";

import { isStableReleaseTag, releaseDistTag } from "../../scripts/lib/release-channel";
import { npmPublishCommand } from "../../scripts/release-to-npm";

describe("toolkit release tags", () => {
  test("only final releases participate in stable version ordering", () => {
    expect(isStableReleaseTag("0.5.5")).toBe(true);
    expect(isStableReleaseTag("0.6.0-rc.1")).toBe(false);
    expect(releaseDistTag("0.5.5")).toBe("latest");
    expect(releaseDistTag("0.6.0-rc.1")).toBe("rc");
    expect(releaseDistTag("1.2.3-rc.10")).toBe("rc");
  });

  test("unsupported or malformed tags are rejected rather than advancing latest", () => {
    for (const tag of [
      "",
      "v0.6.0",
      "00.6.0",
      "0.06.0",
      "0.6.00",
      "0.6.0-rc",
      "0.6.0-rc.01",
      "0.6.0-rc.-1",
      "0.6.0-rc.1.extra",
      "0.6.0-RC.1",
      "0.6.0-beta.1",
      "0.6.0-dev.1",
      "0.6.0+build.1",
      "0.6.0\n",
      "0.6.0-rc.1\n",
      " 0.6.0",
    ]) {
      expect(() => releaseDistTag(tag)).toThrow("expected N.N.N or N.N.N-rc.N");
    }
  });
});

describe("public registry mirror", () => {
  test("publishes the existing RC tarball directly to rc without repacking", () => {
    const tarball = "/runtime-scratch/pgwasm-pg-dump-0.6.0-rc.1.tgz";
    expect(npmPublishCommand("0.6.0-rc.1", tarball)).toEqual([
      "publish",
      "--access",
      "public",
      "--tag",
      "rc",
      "--registry",
      "https://registry.npmjs.org",
      tarball,
    ]);
  });

  test("stable mirroring retains latest, and unsupported tags cannot generate a publish command", () => {
    expect(npmPublishCommand("0.5.5", "release.tgz")).toContain("latest");
    expect(() => npmPublishCommand("0.6.0-beta.1", "release.tgz")).toThrow("Unsupported release tag");
  });
});
