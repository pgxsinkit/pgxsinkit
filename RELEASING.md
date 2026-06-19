# Releasing

pgxsinkit publishes its public packages (`@pgxsinkit/client`, `contracts`, `pglite-sync`,
`react`, `server`, `sync-engine`) to **two** npm registries:

| Registry                                   | Role                                                                          | How it's published                           |
| ------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------- |
| **npmjs.com**                              | Public, prod-facing. What consumers (incl. emergent's CI/prod) install.       | Manual, by `release:public:publish:latest`   |
| **GitHub Packages** (`npm.pkg.github.com`) | Internal: a `dev` channel + a mirror of releases. Requires auth even to read. | Automatic, by the `GitHub Packages` workflow |

The GitHub Packages workflow (`.github/workflows/github-packages.yml`) fires on:

- **push to `main`** → publishes `<version>-dev.<shortSha>` under dist-tag `dev`
- **semver tag** (e.g. `0.1.33`) → publishes the exact `<tag>` under dist-tag `latest` (release parity)

Sibling deps are declared `workspace:*` and resolved to the exact version at pack/publish time.

## Cutting a release

There is no single release command yet; the sequence is:

```bash
# 1. Bump all public packages + regenerate the lockfile.
#    (A workspace version bump does NOT dirty bun.lock — not even `bun install --force` —
#     so this script removes and regenerates it; otherwise workspace:* packs the prior version.)
bun run version:public-packages --version 0.1.33

# 2. Commit the bump.
git add packages/*/package.json bun.lock && git commit -m "chore: release 0.1.33"

# 3. Tag + push (single tag → triggers the GitHub Packages release-parity publish).
git tag 0.1.33 && git push <remote> main 0.1.33

# 4. Build + publish all public packages to npm @ latest.
#    (validate first: bun run release:public:dry-run)
bun run release:public:publish:latest
```

For a prerelease on the `next` dist-tag instead, use `bun run release:public:publish`.
You must be logged in to npm (`bun pm whoami`).

## Gotchas (these have bitten us)

1. **Push release tags one at a time.** GitHub will not create workflow events for tags
   _"when more than three tags are pushed at once"_ — so a bulk `git push --tags` (e.g. during a
   repo migration) silently skips the GitHub Packages publish.

2. **Bump source _before_ tagging.** GitHub Packages release-parity uses the **tag name** as the
   published version, but npm (`bun publish`) uses **`package.json`**. A tag created ahead of the
   `version:public-packages` bump publishes the tag-version to GitHub Packages while npm stays on
   the old source version. Run step 1 before step 3.

3. **All packages, one version.** Every public package is released at the same version; never
   cherry-publish one.

## Reconciling when a tag is already ahead of source

If a tag was pushed ahead of the bump (GitHub Packages has `0.1.32` but npm is still on the old
version), republish the **already-correct GitHub Packages tarball** straight to npm —
byte-identical, no source churn, and it self-heals on the next release (`version:public-packages`
sets an absolute version):

```bash
TOKEN=$(gh auth token)   # needs read:packages
VER=0.1.32
for pkg in contracts pglite-sync sync-engine client server react; do
  URL=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "https://npm.pkg.github.com/@pgxsinkit%2f$pkg" | jq -r ".versions[\"$VER\"].dist.tarball")
  curl -sL -H "Authorization: Bearer $TOKEN" -o "$pkg.tgz" "$URL"   # -L: 302s to blob storage
  bun publish --tag latest --access public --registry=https://registry.npmjs.org "$pkg.tgz"
done
```

(Consumers: emergent treats GitHub Packages as a local-only dev channel and otherwise installs
releases from public npm — see emergent's `docs/runbooks/consuming-conform-ed-and-pgxsinkit.md`.)
