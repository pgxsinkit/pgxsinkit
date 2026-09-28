import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SKILL_PIN_PLACEHOLDER } from "../../scripts/lib/skill-pins";
import {
  type Manifest,
  type VersionContext,
  maxCore,
  nextPatch,
  pinSiblingDeps,
  readStagedSkills,
  skillPinViolations,
  stampSkillPins,
  targetVersion,
} from "../../scripts/publish-github-packages";

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

// Agent Skill pins are tag-derived like package.json's version: the repo carries the "0.0.0" placeholder and
// the publish stamps the version it publishes into the staged SKILL.md files, then refuses to publish any
// package whose staged pins are not exactly that version.
describe("skill pin stamping and the pre-publish assertion", () => {
  // `tmp/` is gitignored, so a fresh checkout (CI) has no `tmp/agents` for mkdtemp to create into.
  const scratchParent = join(process.cwd(), "tmp", "agents");
  mkdirSync(scratchParent, { recursive: true });
  const scratchRoot = mkdtempSync(join(scratchParent, "publish-skill-pins-"));

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  const skill = (name: string, pin: string | null): string =>
    [
      "---",
      `name: ${name}`,
      "description: a fixture skill",
      "metadata:",
      ...(pin === null ? [] : [`  library_version: "${pin}"`]),
      "---",
      "",
      `# ${name}`,
      "",
      'Body text mentioning library_version: "9.9.9" that must never be stamped.',
      "",
    ].join("\n");

  let fixtureCount = 0;
  // A package dir with a top-level skill, a nested skill, and a non-skill markdown file.
  function fixturePackage(pins: { core?: string | null; nested?: string | null } = {}): string {
    const dir = join(scratchRoot, `pkg-${++fixtureCount}`);
    mkdirSync(join(dir, "skills", "core"), { recursive: true });
    mkdirSync(join(dir, "skills", "group", "nested"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "core", "SKILL.md"),
      skill("core", pins.core === undefined ? SKILL_PIN_PLACEHOLDER : pins.core),
    );
    writeFileSync(
      join(dir, "skills", "group", "nested", "SKILL.md"),
      skill("nested", pins.nested === undefined ? SKILL_PIN_PLACEHOLDER : pins.nested),
    );
    writeFileSync(join(dir, "skills", "core", "NOTES.md"), 'library_version: "0.0.0"\n');
    return dir;
  }

  for (const [channel, ctx] of [
    ["release parity (tag build)", releaseCtx],
    ["dev channel (develop / dispatch)", devCtx],
  ] as const) {
    describe(channel, () => {
      const version = targetVersion("0.0.0", ctx);

      test("stamps every staged SKILL.md (nested included) with the publish version, pin line only", () => {
        const dir = fixturePackage();
        const stamped = stampSkillPins(dir, version, true);
        expect(stamped.map((s) => s.file.slice(dir.length))).toEqual([
          "/skills/core/SKILL.md",
          "/skills/group/nested/SKILL.md",
        ]);
        const onDisk = readStagedSkills(dir);
        expect(onDisk).toEqual(stamped);
        for (const { content } of onDisk) {
          expect(content).toContain(`  library_version: "${version}"`);
          expect(content).not.toContain(`library_version: "${SKILL_PIN_PLACEHOLDER}"`);
          // Only the frontmatter pin is rewritten; body text and non-skill files are untouched.
          expect(content).toContain('Body text mentioning library_version: "9.9.9"');
        }
        expect(readFileSync(join(dir, "skills", "core", "NOTES.md"), "utf8")).toBe('library_version: "0.0.0"\n');
        expect(skillPinViolations(onDisk, version)).toEqual([]);
      });

      test("a dry run stamps in memory only and leaves the files as the placeholder", () => {
        const dir = fixturePackage();
        const stamped = stampSkillPins(dir, version, false);
        expect(skillPinViolations(stamped, version)).toEqual([]);
        const onDisk = readStagedSkills(dir);
        expect(onDisk.every(({ content }) => content.includes(`library_version: "${SKILL_PIN_PLACEHOLDER}"`))).toBe(
          true,
        );
        expect(skillPinViolations(onDisk, version)).toHaveLength(2);
      });

      test("the assertion names every staged skill whose pin is not the publish version", () => {
        const dir = fixturePackage({ core: "0.3.1" });
        // Unstamped: the placeholder and a stale hand-edited pin both fail, each naming its file.
        expect(skillPinViolations(readStagedSkills(dir), version, dir)).toEqual([
          `skills/core/SKILL.md: library_version "0.3.1" is not the publish version "${version}"`,
          `skills/group/nested/SKILL.md: library_version "${SKILL_PIN_PLACEHOLDER}" is not the publish version "${version}"`,
        ]);
        // Stamped for the OTHER channel's version: still refused.
        const other = targetVersion("0.0.0", ctx === releaseCtx ? devCtx : releaseCtx);
        stampSkillPins(dir, other, true);
        expect(skillPinViolations(readStagedSkills(dir), version, dir)).toHaveLength(2);
        stampSkillPins(dir, version, true);
        expect(skillPinViolations(readStagedSkills(dir), version, dir)).toEqual([]);
      });

      test("a SKILL.md with no pin line cannot be stamped and fails the assertion", () => {
        const dir = fixturePackage({ nested: null });
        const stamped = stampSkillPins(dir, version, true);
        expect(skillPinViolations(stamped, version, dir)).toEqual([
          `skills/group/nested/SKILL.md: library_version "<missing>" is not the publish version "${version}"`,
        ]);
      });
    });
  }

  test("a package without skills stages nothing and passes", () => {
    const dir = join(scratchRoot, "no-skills");
    mkdirSync(dir, { recursive: true });
    expect(stampSkillPins(dir, "1.2.3", true)).toEqual([]);
    expect(skillPinViolations(readStagedSkills(dir), "1.2.3")).toEqual([]);
  });

  test("the channels publish different versions, so a pin stamped for one fails the other", () => {
    expect(targetVersion("0.0.0", releaseCtx)).toBe("0.2.1");
    expect(targetVersion("0.0.0", devCtx)).toBe("0.2.1-dev.1782043909.abc1234");
  });
});
