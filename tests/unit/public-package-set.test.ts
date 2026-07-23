import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The publish surface is exactly these five packages. Every other workspace member MUST set
// "private": true so it can never be published by accident — e.g. a future demo/support package
// silently going public by omitting the flag (readiness review, "Other / Release and packaging").
// scripts/build-public-packages.ts hardcodes the same set; this test guards the package.json side
// independently, so the two cannot drift apart unnoticed.
const EXPECTED_PUBLIC = [
  "@pgxsinkit/client",
  "@pgxsinkit/contracts",
  "@pgxsinkit/pglite-opfs-repacked",
  "@pgxsinkit/react",
  "@pgxsinkit/server",
];

const repoRoot = join(import.meta.dir, "..", "..");

interface PkgManifest {
  name: string;
  private?: boolean;
  publishConfig?: { access?: string };
}

interface WorkspacePackage {
  dir: string;
  name: string;
  isPrivate: boolean;
  access: string | undefined;
}

function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgPath = join(repoRoot, group, entry.name, "package.json");
      let raw: string;
      try {
        raw = readFileSync(pkgPath, "utf8");
      } catch {
        continue;
      }
      const pkg = JSON.parse(raw) as PkgManifest;
      found.push({
        dir: `${group}/${entry.name}`,
        name: pkg.name,
        isPrivate: pkg.private === true,
        access: pkg.publishConfig?.access,
      });
    }
  }
  return found;
}

describe("publish surface", () => {
  const packages = workspacePackages();
  const byName = (a: string, b: string) => a.localeCompare(b);

  it("exposes exactly the five public packages", () => {
    const publishable = packages
      .filter((pkg) => !pkg.isPrivate)
      .map((pkg) => pkg.name)
      .sort(byName);
    expect(publishable).toEqual([...EXPECTED_PUBLIC].sort(byName));
  });

  it("marks every other workspace package private", () => {
    const leaked = packages.filter((pkg) => !pkg.isPrivate && !EXPECTED_PUBLIC.includes(pkg.name));
    // Names the offending directory so the failure points straight at the missing "private": true.
    expect(leaked.map((pkg) => pkg.dir)).toEqual([]);
  });

  it("sets publishConfig.access=public on every published package", () => {
    for (const pkg of packages.filter((entry) => !entry.isPrivate)) {
      expect(pkg.access).toBe("public");
    }
  });
});
