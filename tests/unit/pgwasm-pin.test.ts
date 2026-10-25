import { describe, expect, it } from "bun:test";
import path from "node:path";

import {
  ARTEFACT_FILES as C_BUILD_FILES,
  ARTEFACT_RELEASE as C_BUILD_RELEASE,
} from "../../packages/pgwasm-c/src/artefact-pins";
import { C_BUILD_IDENTITY } from "../../packages/pgwasm-c/src/build";
import {
  ARTEFACT_FILES as PG_DUMP_FILES,
  ARTEFACT_RELEASE as PG_DUMP_RELEASE,
} from "../../packages/pgwasm-pg-dump/src/artefact-pins";
import { sha256 } from "../../scripts/pgwasm-artefacts";
import {
  PINNED_ASSETS,
  checkRelease,
  parsePinArguments,
  parseSha256Sums,
  pinRelease,
  renderPins,
  type CheckedRelease,
} from "../../scripts/pgwasm-pin";
import { rejectionOf } from "./support/rejection";

// `bun run pgwasm:pin <tag>` (scripts/pgwasm-pin.ts, ADR-0064): both build packages pin one
// pgwasm-postgres release, written from its manifest.json once that agrees with its SHA256SUMS, and the C
// build's identity carries the release's name and data format.

const repoRoot = path.join(import.meta.dir, "..", "..");
const encode = (text: string) => new TextEncoder().encode(text);
const hex = (char: string) => char.repeat(64);

/** A release as GitHub serves it: a manifest for `tag` and the SHA256SUMS that agrees with it. */
function release(tag: string, edit: (manifest: Record<string, unknown>) => void = () => {}) {
  const files = Object.values(PINNED_ASSETS)
    .flat()
    .map((name, index) => ({ name, bytes: index + 1, sha256: hex(String(index % 10)) }));
  const rc = /^(\d+)\.0\.0-rc\.(\d+)$/.exec(tag);
  const manifest: Record<string, unknown> = {
    version: tag,
    commit: "a".repeat(40),
    upstream: { tag: rc === null ? "REL_18_3" : `REL_${rc[1]}_RC${rc[2]}`, commit: "b".repeat(40) },
    dataFormat: 1,
    builder: { image: "ghcr.io/pgxsinkit/pgwasm-builder@sha256:" + hex("c") },
    files,
  };
  edit(manifest);
  const manifestBytes = encode(JSON.stringify(manifest));
  const listed = manifest["files"] as readonly { name: string; sha256: string }[];
  const sums = [
    ...listed.map(({ name, sha256: digest }) => `${digest}  ${name}`),
    `${sha256(manifestBytes)}  manifest.json`,
  ];
  return { manifestBytes, sums: `${sums.join("\n")}\n` };
}

describe("the pins", () => {
  it("of both build packages name one release, with the data format and name the C build's identity carries", () => {
    expect(PG_DUMP_RELEASE).toEqual(C_BUILD_RELEASE);
    expect(C_BUILD_RELEASE.repository).toBe("pgxsinkit/pgwasm-postgres");
    expect(C_BUILD_IDENTITY.release).toBe(`pgwasm-postgres ${C_BUILD_RELEASE.tag}`);
    expect(C_BUILD_IDENTITY.dataFormat).toBe(C_BUILD_RELEASE.dataFormat);
    expect(Object.keys(C_BUILD_FILES).sort()).toEqual([...(PINNED_ASSETS["packages/pgwasm-c"] ?? [])]);
    expect(Object.keys(PG_DUMP_FILES).sort()).toEqual([...(PINNED_ASSETS["packages/pgwasm-pg-dump"] ?? [])]);
  });

  it("are exactly what pgwasm:pin writes for that release (never hand-edited)", async () => {
    const checked: CheckedRelease = {
      release: C_BUILD_RELEASE,
      files: new Map(Object.entries({ ...C_BUILD_FILES, ...PG_DUMP_FILES })),
    };
    for (const packageDir of Object.keys(PINNED_ASSETS)) {
      const committed = await Bun.file(path.join(repoRoot, packageDir, "src/artefact-pins.ts")).text();
      expect(renderPins(packageDir, checked)).toBe(committed);
    }
  });
});

describe("pgwasm:pin", () => {
  const download = (served: ReturnType<typeof release>) => async (url: string) => {
    if (url.endsWith("/manifest.json")) return served.manifestBytes;
    if (url.endsWith("/SHA256SUMS")) return encode(served.sums);
    throw new Error(`unexpected download ${url}`);
  };

  it("writes both packages' pins from one release, from GitHub's release URLs", async () => {
    const served = release("18.3.7");
    const urls: string[] = [];
    const written = new Map<string, string>();
    const { release: pinned } = await pinRelease("18.3.7", {
      download: async (url) => {
        urls.push(url);
        return download(served)(url);
      },
      currentDataFormat: 1,
      write: async (packageDir, text) => void written.set(packageDir, text),
    });
    expect(urls).toEqual([
      "https://github.com/pgxsinkit/pgwasm-postgres/releases/download/18.3.7/manifest.json",
      "https://github.com/pgxsinkit/pgwasm-postgres/releases/download/18.3.7/SHA256SUMS",
    ]);
    expect(pinned.name).toBe("pgwasm-postgres 18.3.7");
    expect(pinned.manifestSha256).toBe(sha256(served.manifestBytes));
    expect([...written.keys()].sort()).toEqual(Object.keys(PINNED_ASSETS).sort());
    for (const text of written.values()) {
      expect(text).toContain('tag: "18.3.7",');
      expect(text).toContain('name: "pgwasm-postgres 18.3.7",');
    }
    expect(written.get("packages/pgwasm-pg-dump")).toContain('"pg_dump.wasm": { bytes: ');
    expect(written.get("packages/pgwasm-pg-dump")).not.toContain("postgres.wasm");
  });

  it("refuses a release of another data format, naming ADR-0064's open question, and writes nothing", async () => {
    const served = release("19.1.0", (manifest) => void (manifest["dataFormat"] = 2));
    const written: string[] = [];
    const failure = await rejectionOf(
      pinRelease("19.1.0", {
        download: download(served),
        currentDataFormat: 1,
        write: async (packageDir) => void written.push(packageDir),
      }),
    );
    expect(failure.message).toContain("declares dataFormat 2, but the C build's identity is dataFormat 1");
    expect(failure.message).toContain("ADR-0064's open question");
    expect(written).toEqual([]);
  });

  it("requires a fresh-store acknowledgement before adopting an RC with another format", async () => {
    const served = release("19.0.0-rc.1", (manifest) => void (manifest["dataFormat"] = 2));
    const written = new Map<string, string>();
    const options = {
      download: download(served),
      currentDataFormat: 1,
      write: async (packageDir: string, text: string) => void written.set(packageDir, text),
    };
    const failure = await rejectionOf(pinRelease("19.0.0-rc.1", options));
    expect(failure.message).toContain("--fresh-stores 1:2");
    expect(written.size).toBe(0);

    const { release: pinned } = await pinRelease("19.0.0-rc.1", {
      ...options,
      freshStores: { from: 1, to: 2 },
    });
    expect(pinned.dataFormat).toBe(2);
    expect(pinned.upstream.tag).toBe("REL_19_RC1");
    expect([...written.keys()].sort()).toEqual(Object.keys(PINNED_ASSETS).sort());
    for (const text of written.values()) {
      expect(text).toContain('tag: "19.0.0-rc.1",');
      expect(text).toContain("dataFormat: 2,");
    }
  });

  it("refuses a mismatched, non-advancing or final-release fresh-store transition before writing", async () => {
    for (const [tag, from, to] of [
      ["19.0.0-rc.1", 2, 3],
      ["19.0.0-rc.1", 1, 3],
      ["19.0.0-rc.1", 0, 2],
      ["19.0.0-rc.1", 1.5, 2],
      ["19.0.0-rc.1", 2, 1],
      ["19.0.0", 1, 2],
    ] as const) {
      const served = release(tag, (manifest) => void (manifest["dataFormat"] = 2));
      const written: string[] = [];
      const failure = await rejectionOf(
        pinRelease(tag, {
          download: download(served),
          currentDataFormat: 1,
          freshStores: { from, to },
          write: async (packageDir) => void written.push(packageDir),
        }),
      );
      expect(failure.message).toContain("must advance the current dataFormat 1");
      expect(written).toEqual([]);
    }
    const served = release("19.0.0-rc.1", (manifest) => void (manifest["dataFormat"] = 2));
    const failure = await rejectionOf(
      pinRelease("19.0.0-rc.1", {
        download: download(served),
        currentDataFormat: 2,
        freshStores: { from: 2, to: 2 },
        write: async () => {
          throw new Error("must not write");
        },
      }),
    );
    expect(failure.message).toContain("must advance the current dataFormat 2");
  });

  it("accepts only exact RC tags and requires the manifest's upstream RC to agree", async () => {
    for (const upstreamTag of ["REL_18_RC1", "REL_19_RC2", "REL_19_BETA1", "REL_19_0"]) {
      const served = release("19.0.0-rc.1", (manifest) => {
        manifest["upstream"] = { tag: upstreamTag, commit: "b".repeat(40) };
      });
      const written: string[] = [];
      const failure = await rejectionOf(
        pinRelease("19.0.0-rc.1", {
          download: download(served),
          currentDataFormat: 1,
          write: async (packageDir) => void written.push(packageDir),
        }),
      );
      expect(failure.message).toContain(`upstream.tag ${upstreamTag} does not match RC release 19.0.0-rc.1`);
      expect(written).toEqual([]);
    }
    for (const tag of ["19.0.0-beta.1", "19.1.0-rc.1", "19.0.0-rc.0", "19.0.0-rc.01", "019.0.0-rc.1", "v19.0.0-rc.1"]) {
      let downloads = 0;
      const failure = await rejectionOf(
        pinRelease(tag, {
          download: async () => {
            downloads++;
            throw new Error("must not download");
          },
          write: async () => {
            throw new Error("must not write");
          },
        }),
      );
      expect(failure.message).toContain("unsupported release tag");
      expect(downloads).toBe(0);
    }
  });

  it("parses the RC-only fresh-store option without accepting ambiguous or malformed transitions", () => {
    expect(parsePinArguments(["18.6.2"])).toEqual({ tag: "18.6.2" });
    expect(parsePinArguments(["19.0.0-rc.1"])).toEqual({ tag: "19.0.0-rc.1" });
    expect(parsePinArguments(["19.0.0-rc.1", "--fresh-stores", "1:2"])).toEqual({
      tag: "19.0.0-rc.1",
      freshStores: { from: 1, to: 2 },
    });
    for (const args of [
      [],
      ["19.0.0-rc.1", "--fresh-stores"],
      ["19.0.0-rc.1", "--fresh-stores", "2:2"],
      ["19.0.0-rc.1", "--fresh-stores", "2:1"],
      ["19.0.0-rc.1", "--fresh-stores", "01:2"],
      ["19.0.0-rc.1", "--fresh-stores", "1:9007199254740992"],
      ["19.0.0-rc.1", "--fresh-stores", "1:2", "extra"],
      ["19.0.0", "--fresh-stores", "1:2"],
    ]) {
      expect(() => parsePinArguments(args)).toThrow(/usage:/);
    }
  });

  it("refuses a manifest and SHA256SUMS that disagree", () => {
    const served = release("18.3.7");
    expect(() => checkRelease("18.3.8", served.manifestBytes, served.sums)).toThrow(/is for release 18\.3\.7/);
    expect(() => checkRelease("18.3.7", encode("{}"), served.sums)).toThrow(/SHA256SUMS gives manifest\.json as/);
    const tampered = served.sums.replace(/^[0-9a-f]{64}(?= {2}amcheck)/m, hex("f"));
    expect(() => checkRelease("18.3.7", served.manifestBytes, tampered)).toThrow(
      /manifest\.json gives amcheck\.tar\.gz as 0+, SHA256SUMS as f+/,
    );
    const extra = `${served.sums}${hex("e")}  stray.bin\n`;
    expect(() => checkRelease("18.3.7", served.manifestBytes, extra)).toThrow(/SHA256SUMS lists files .*: stray\.bin/);
    const short = release("18.3.7", (manifest) => {
      manifest["files"] = (manifest["files"] as { name: string }[]).filter(({ name }) => name !== "pg_dump.js");
    });
    expect(() => checkRelease("18.3.7", short.manifestBytes, short.sums)).toThrow(/has no pg_dump\.js/);
  });

  it("reads SHA256SUMS strictly", () => {
    expect(parseSha256Sums(`${hex("a")}  x.wasm\n${hex("b")} *y.data\n`)).toEqual(
      new Map([
        ["x.wasm", hex("a")],
        ["y.data", hex("b")],
      ]),
    );
    expect(() => parseSha256Sums("not a digest  x.wasm")).toThrow(/malformed line/);
    expect(() => parseSha256Sums(`${hex("a")}  x\n${hex("b")}  x\n`)).toThrow(/lists x twice/);
  });
});
