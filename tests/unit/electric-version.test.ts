import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkElectricVersion, MANAGED, readPin } from "../../scripts/electric-version";

// The pin file `infra/electric-version.json` is the single source of truth for the pinned ElectricSQL
// image; `checkElectricVersion` is the drift guard wired into `check` / `check:fast`. These tests assert
// the pin parses within its floor, the working tree is drift-free, and synthetic drift is caught.

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function ge(version: string, floor: string): boolean {
  const [vMaj, vMin] = version.split(".").map(Number) as [number, number, number];
  const [fMaj, fMin] = floor.split(".").map(Number) as [number, number];
  return vMaj > fMaj || (vMaj === fMaj && vMin >= fMin);
}

describe("electric-version pin file", () => {
  it("parses and its version is an X.Y.Z semver at or above the floor", () => {
    const pin = readPin(REPO_ROOT);
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin.floor).toMatch(/^\d+\.\d+$/);
    expect(ge(pin.version, pin.floor)).toBe(true);
  });
});

describe("checkElectricVersion (working tree)", () => {
  it("reports no drift for the committed references", () => {
    expect(checkElectricVersion(REPO_ROOT)).toEqual([]);
  });
});

describe("checkElectricVersion (synthetic fixture)", () => {
  const tmpBase = path.join(REPO_ROOT, "tmp/agents");
  mkdirSync(tmpBase, { recursive: true });
  const tmpRoot = mkdtempSync(path.join(tmpBase, "electric-version-"));

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seedFixture(root: string, pinVersion: string, refVersion: string): void {
    mkdirSync(path.join(root, "infra"), { recursive: true });
    writeFileSync(
      path.join(root, "infra/electric-version.json"),
      `${JSON.stringify({ image: "docker.io/electricsql/electric", version: pinVersion, floor: "1.7" }, null, 2)}\n`,
    );
    // Each managed reference gets a file containing a line the corresponding pattern matches.
    for (const ref of MANAGED) {
      const abs = path.join(root, ref.file);
      mkdirSync(path.dirname(abs), { recursive: true });
      const body = ref.pattern.label.replace("<version>", refVersion).replace(/^/, "prefix ").concat(" suffix\n");
      writeFileSync(abs, body);
    }
  }

  it("returns [] when every reference matches the pin", () => {
    const root = path.join(tmpRoot, "match");
    seedFixture(root, "1.7.6", "1.7.6");
    expect(checkElectricVersion(root)).toEqual([]);
  });

  it("flags every reference that disagrees with the pin", () => {
    const root = path.join(tmpRoot, "drift");
    seedFixture(root, "1.7.6", "1.7.4");
    const drift = checkElectricVersion(root);
    expect(drift.map((d) => d.file).sort()).toEqual(MANAGED.map((r) => r.file).sort());
    for (const d of drift) {
      expect(d.expected).toBe("1.7.6");
      expect(d.found).toEqual(["1.7.4"]);
    }
  });

  it("flags a reference whose version token is missing entirely", () => {
    const root = path.join(tmpRoot, "missing");
    mkdirSync(path.join(root, "infra"), { recursive: true });
    writeFileSync(
      path.join(root, "infra/electric-version.json"),
      `${JSON.stringify({ image: "docker.io/electricsql/electric", version: "1.7.6", floor: "1.7" }, null, 2)}\n`,
    );
    for (const ref of MANAGED) {
      const abs = path.join(root, ref.file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "no version token here\n");
    }
    const drift = checkElectricVersion(root);
    expect(drift).toHaveLength(MANAGED.length);
    for (const d of drift) expect(d.found).toEqual([]);
  });
});
