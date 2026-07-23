#!/usr/bin/env bun
/**
 * Publish an already-released version from GitHub Packages to the public npm registry.
 *
 * GitHub Packages is the canonical build output: on a semver tag, CI publishes release-parity there
 * automatically (`publish:github-packages`). This script is the deliberate, human-gated second step
 * (ADR-0016 §4) — it downloads the *exact* tarballs already built and published to GitHub Packages
 * for `<tag>` and re-publishes them byte-identical to npmjs.com. No rebuild, so npm gets precisely
 * what was tested and tagged.
 *
 *   bun run release:npm 0.2.1
 *
 * Auth: GitHub read via `gh auth token` (or $GH_PACKAGES_TOKEN / $GITHUB_TOKEN); npm via your normal
 * npm login (~/.npmrc) or $NPM_TOKEN. The npm token stays on your machine — it is never in CI.
 * Set DRY_RUN=1 to print the plan without downloading or publishing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DRY_RUN = process.env["DRY_RUN"] === "1";
const GH_REGISTRY = "https://npm.pkg.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
const RELEASE_TAG_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const tag = process.argv[2];
if (!tag || !RELEASE_TAG_RE.test(tag)) {
  console.error(
    `Usage: bun run release:npm <version>\n  <version> must be a bare semver, e.g. 0.2.1 (got: ${tag ?? "<none>"})`,
  );
  process.exit(1);
}

function ghToken(): string {
  for (const key of ["GH_PACKAGES_TOKEN", "GITHUB_TOKEN"] as const) {
    const v = process.env[key];
    if (v) return v;
  }
  const proc = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  const token = proc.status === 0 ? proc.stdout.trim() : "";
  if (!token) {
    console.error("No GitHub token. Run `gh auth login` (with read:packages) or set $GH_PACKAGES_TOKEN.");
    process.exit(1);
  }
  return token;
}

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
}

function findPublishablePackages(): string[] {
  const names: string[] = [];
  for (const workspace of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(ROOT, workspace));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const pkg = JSON.parse(readFileSync(join(ROOT, workspace, entry, "package.json"), "utf8")) as Manifest;
        if (!pkg.private && typeof pkg.name === "string") names.push(pkg.name);
      } catch {
        continue;
      }
    }
  }
  return names;
}

function curl(args: string[]): { ok: boolean; out: string } {
  const proc = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: proc.status === 0, out: proc.stdout ?? "" };
}

const token = ghToken();
const authHeader = `Authorization: Bearer ${token}`;
const packages = findPublishablePackages();
if (packages.length === 0) {
  console.error("No publishable packages found.");
  process.exit(1);
}

console.log(
  `release:npm — ${packages.length} package(s) @ ${tag}: GitHub Packages -> npm${DRY_RUN ? "  (DRY RUN)" : ""}\n`,
);

const workDir = mkdtempSync(join(tmpdir(), "pgxsinkit-release-npm-"));
const failures: string[] = [];
try {
  for (const name of packages) {
    // The packument carries dist.tarball for the exact published version.
    const packument = curl(["-fsSL", "-H", authHeader, `${GH_REGISTRY}/${name}`]);
    if (!packument.ok) {
      console.error(`  FAILED ${name}: cannot read packument from GitHub Packages`);
      failures.push(name);
      continue;
    }
    let tarballUrl: string | undefined;
    try {
      const doc = JSON.parse(packument.out) as { versions?: Record<string, { dist?: { tarball?: string } }> };
      tarballUrl = doc.versions?.[tag]?.dist?.tarball;
    } catch {
      /* fallthrough to the missing-version error below */
    }
    if (!tarballUrl) {
      console.error(`  FAILED ${name}@${tag}: not found on GitHub Packages (was the tag built there yet?)`);
      failures.push(name);
      continue;
    }

    const tarball = join(workDir, `${name.replace(/[@/]/g, "_")}-${tag}.tgz`);
    if (DRY_RUN) {
      console.log(`  [dry-run] would download ${name}@${tag} and publish to npm`);
      continue;
    }
    // GitHub Packages 302-redirects tarballs to blob storage; -L follows.
    const dl = curl(["-fsSL", "-L", "-H", authHeader, "-o", tarball, tarballUrl]);
    if (!dl.ok) {
      console.error(`  FAILED ${name}@${tag}: tarball download error`);
      failures.push(name);
      continue;
    }

    const pub = spawnSync(
      "bun",
      ["publish", "--access", "public", "--tag", "latest", "--registry", NPM_REGISTRY, tarball],
      {
        stdio: "inherit",
      },
    );
    if (pub.status === 0) {
      console.log(`  published ${name}@${tag} to npm`);
    } else {
      console.error(`  FAILED ${name}@${tag}: npm publish error`);
      failures.push(name);
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package(s) failed.`);
  process.exit(1);
}
console.log(`\nDone. ${DRY_RUN ? "Planned" : "Published"} ${packages.length} package(s) @ ${tag} to npm.`);
