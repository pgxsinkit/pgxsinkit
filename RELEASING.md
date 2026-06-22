# Releasing

> Implements the Cross-repo TypeScript release & versioning standard — see
> [docs/adr/0001](docs/adr/0001-unified-ts-release-versioning-tooling-standard.md).

pgxsinkit publishes its public packages (`@pgxsinkit/client`, `contracts`, `pglite-sync`, `react`,
`server`) to **two** registries:

| Registry                                   | Role                                                                                                      | How it's published                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **GitHub Packages** (`npm.pkg.github.com`) | Canonical build output: a `dev` fast-cycle channel + the source-of-truth for releases. Auth even to read. | Automatic, by the `GitHub Packages` workflow (gated on validation)              |
| **npmjs.com**                              | Public, prod-facing. What consumers (incl. emergent's CI/prod) install.                                   | Manual, by `bun run release:npm <tag>` — re-publishes the GH tarballs unchanged |

## Versioning — the tag is the only source of truth

Every publishable `package.json` carries `"version": "0.0.0"` as a **placeholder you never edit**.
The real version is derived at publish time from the most recent semver tag:

- **push to `main`** → `<nextPatch(latestTag)>-dev.<unixSeconds>.<shortSha>` at dist-tag `dev` (always
  sorts above the latest release; successive dev builds sort chronologically).
- **semver tag** (e.g. `0.1.33`) → the exact `<tag>` at dist-tag `latest` (release parity).

There is no version-bump step and no release commit. Sibling deps are `workspace:*`, resolved to the
derived version at pack/publish time.

## Cutting a release

```bash
# 1. Tag a reviewed commit on main and push the single tag. CI validates
#    (validate:full + test:integration) then publishes release-parity to GitHub Packages.
git tag 0.1.33 && git push upstream 0.1.33

# 2. Once the GitHub Packages publish is green, mirror it to public npm
#    (your npm token stays on your machine; this never runs in CI).
bun run release:npm 0.1.33
```

`release:npm` downloads the exact tarballs GitHub Packages built for the tag and `bun publish`es them
byte-identical to npm — no rebuild. Be logged in to npm (`bun pm whoami`); GitHub read uses
`gh auth token` (needs `read:packages`). Preview with `DRY_RUN=1 bun run release:npm 0.1.33`.

## Gotchas

1. **Push release tags one at a time.** GitHub will not create workflow events for tags _"when more
   than three tags are pushed at once"_ — a bulk `git push --tags` silently skips the publish.
2. **All packages, one version.** Every public package releases at the same tag; never cherry-publish
   one. The publish derives a single version per run and pins siblings to it.

(Consumers: emergent installs releases from public npm by default and treats GitHub Packages as a
local-only dev channel — see emergent's `bun run dev:link` and
`docs/runbooks/consuming-conform-ed-and-pgxsinkit.md`.)
