# Unified TypeScript release, versioning, and tooling standard (emergent / conform-ed / pgxsinkit)

Status: accepted (2026-06-19)

The three core TypeScript repositories — `emergent` (private app + consumer),
`conform-ed`, and `pgxsinkit` (both public libraries) — had drifted into three
incompatible toolchains: bare `format`/`lint` *wrote* in pgxsinkit but *checked* in
conform-ed (a stray `bun run format` silently rewrote a committed source file during
this very work), pgxsinkit had no pre-commit hook while the others did, versions were
hand-maintained in `package.json` and kept drifting ahead of/behind the git tags, and
the GitHub-Packages dev channel had just shipped a build that sorted *below* the latest
release. Compounding this, GitHub's PR-merge UI regenerates commits (squash/merge
commits), which we reject outright. This ADR fixes one standard across all three repos.
It is a **personal engineering standard** in the same category as "rebase, never merge";
the living form lives in the global agent guide, and an immutable copy of this ADR is
placed in each repo so every repo is self-documenting with no cross-repo links.

## Decision

1. **Integration is rebase-only, pushed manually from the CL — never the GitHub UI.**
   Every PR must be a clean rebase on top of `upstream/main` and exists for **review
   only**. After review the maintainer pushes the rebased tip from the command line, so
   `main` advances by fast-forward and history stays strictly linear. No merge commits,
   no squash commits, no UI-side regeneration.

2. **Trigger → artifact map.**
   - **Pull request** → CI validation only. Nothing is published.
   - **Push to `main`** (the manual fast-forward) → a freshly built **dev** package on
     the GitHub Packages npm registry at dist-tag `@dev`. This is *not* a release.
   - **Push a semver tag** → an **official release**: release-parity publish to GitHub
     Packages at `@latest` **and** (conform-ed) the GHCR/OCI images, followed by the
     manual npm step in §4.

3. **Versioning: the most recent semver tag is the *sole* source of truth (Solution A).**
   Every publishable `package.json` carries `"version": "0.0.0"` as a placeholder,
   committed once and **never hand-edited**. The real version is derived at build/publish
   time, on the runner, where the latest tag *and* the commit SHA are both known — so no
   commit hook is involved (a commit hook cannot know its own SHA and would dirty the
   tree). Derivation:
   - tag push → `version = <tag>`.
   - main push → `version = max(placeholder, nextPatch(latestTag))-dev.<unixSeconds>.<shortSha>`,
     computed **once per run** so all sibling packages share one version and cross-deps
     resolve. `nextPatch(latestTag)` guarantees the dev build sorts strictly above the
     latest release; the unix-seconds stamp (a numeric SemVer identifier) makes
     successive dev builds sort chronologically; the sha is for traceability.

   This applies uniformly to npm packages, GitHub-Packages packages, and the
   GHCR/Argo OCI **image tags**. The only versioning action a human ever takes is
   **choosing the tag name to push** (the patch/minor/major decision); there is no
   changesets/conventional-commits automation.

4. **npm releases are GH-sourced and published by one deliberate CL command (Option A).**
   GitHub Packages is the canonical build output. On a tag, CI publishes release-parity
   there automatically. The npm publish is **not** automated: the maintainer runs
   `bun run release:npm <tag>` from the dev machine, which **downloads the exact tarballs
   already built on GitHub Packages** and `bun publish`es them byte-identical to npm. The
   npm token stays on the dev machine; the one truly irreversible action (npm is
   effectively un-unpublishable) is human-gated.

5. **Canonical script vocabulary — check-default.** Bare verbs never mutate; mutation is
   always explicit. Identical names and semantics in all three repos (consumer omits the
   publisher row):

   | Script | Semantics | Mutates? |
   |---|---|---|
   | `format` | oxfmt `--check` | no |
   | `format:write` | oxfmt `--write` | yes |
   | `lint` | oxlint (no fix) | no |
   | `lint:fix` | oxlint `--fix` | yes |
   | `typecheck` | tsgo / `turbo run typecheck` | no |
   | `test` | unit tests only (no containers) | no |
   | `test:integration` | container-backed lanes (Podman) | no |
   | `check` | `typecheck` + `lint` + `test` | no |
   | `validate` | `format` + `check` | no |
   | `validate:full` | `validate` unscoped (no `--affected`) | no |
   | `build` | `turbo run build` | — |
   | `release:npm <tag>` *(publishers only)* | download GH tarballs → publish to npm | publishes |

   `version:*` scripts are **deleted** (the tag is the version). `test` is unit-only;
   container lanes live behind `test:integration` and are never part of
   `test`/`check`/`validate`.

6. **Pre-commit hook is uniform `bun run validate`** (`format` + `lint` + `typecheck` +
   unit `test`) — container-free and fast — in all three repos (pgxsinkit gains one).
   Container/e2e lanes never run in the commit path.

7. **Publishes are gated on validation, asymmetrically (libraries only).** In the
   publish workflow the publish job `needs:` a validate job:
   - dev publish (main) → `validate` (fast).
   - release publish + images (tag) → `validate:full` + `test:integration`.

   emergent has nothing to publish to a registry, so this does not apply to it.

8. **Dev-channel flip lives in emergent as a three-command trio** (the libraries do not
   consume each other): `dev:link` / `dev:unlink` / `dev:status`. `dev:link` writes the
   gitignored `bunfig.toml` (token injected dynamically via `gh auth token`), repoints
   the `@conform-ed/*` + `@pgxsinkit/*` specs at the `@dev` dist-tag (a committed `^x`
   pin will not match a `-dev` prerelease, so rerouting the registry alone is
   insufficient), and installs. `dev:unlink` removes `bunfig.toml`, **surgically**
   restores only those scoped specs from `git show HEAD:package.json` (never clobbering
   unrelated edits), and installs. The committed default is always the public-npm release
   pins; the dev channel is a transient, local-only opt-in.

### Per-repo scope

| Layer | Applies to |
|---|---|
| Publishing & versioning (gating, Solution A, `release:npm`, GH-as-source) | conform-ed + pgxsinkit |
| Consuming the dev channel (`dev:link` trio) | emergent |
| Dev ergonomics (canonical scripts, `validate` pre-commit hook) | all three |

emergent is exempt from publishing/versioning: its packages are all `private`
(unpublished, so versions are moot) and its deploy image tag is already git-derived.

## Considered and rejected

- **GitHub-UI merge (squash or merge commit).** Regenerates commits and breaks linear
  history for no benefit we want; rejected in favour of manual fast-forward pushes.
- **Solution B — store the real version in `package.json` via a release commit** (the
  old conform-ed `release.ts`). Stores a redundant value that can drift from the tag and
  costs a commit per release. Rejected: only the tag should determine the version.
- **A commit hook that rewrites `package.json`.** Cannot know its own SHA, dirties the
  tree, races the commit. Rejected in favour of build-time derivation.
- **Option B — fully automated npm publish on tag.** Would require an `NPM_TOKEN` in each
  repo's GitHub secrets and could auto-ship a botched tag to npm. Rejected: keep the
  irreversible action human-gated on the dev machine.
- **Write-default scripts** (bare `format`/`lint` mutate). This is the footgun that
  rewrote a committed file. Rejected in favour of check-default.
- **Cross-repo documentation references.** Fragile — the conform-ed org move already
  rotted such links. Rejected: agents read the named standard from the always-loaded
  global guide; humans read an immutable per-repo copy of this ADR.

## Consequences

- `package.json` shows `0.0.0` locally; use `git describe --tags` to see the real
  version. The published artifact always carries the correct derived version.
- Muscle memory shifts: `bun run format` now **checks**; use `format:write` to mutate.
- Releasing is: `git tag X && git push upstream X` (CI publishes GH + images), then
  `bun run release:npm X` (npm). No release commit.
- This ADR is immutable and copied byte-identical into `emergent` and `pgxsinkit`
  (`docs/adr/`, repo-local numbers). The living "how" is the cross-repo standard in the
  global agent guide; each repo's `AGENTS.md` references it by name and its `RELEASING.md`
  points at this ADR locally.
- The earlier dev-version-ordering fix (pgxsinkit PR #2, conform-ed PR #4) is the
  `nextPatch + stamp` derivation in §3; it folds into this standard rather than landing
  separately.
