# PG19 toolkit release candidates

The C release and the toolkit release have independent versions. The C build
`pgwasm-postgres 19.0.0-rc.1` supplies the PostgreSQL server, initdb and pg_dump
assets. The toolkit candidate `0.6.0-rc.1` publishes the coordinated TypeScript
packages that consume those assets. Source `package.json` versions remain
`0.0.0`; the release tag supplies the published version.

## Channels and qualification

| Ref                             | Published version                                   | Registry dist-tag |
| ------------------------------- | --------------------------------------------------- | ----------------- |
| `develop`                       | Next stable patch plus the dev timestamp and commit | `dev`             |
| Final `N.N.N` tag               | Exact tag                                           | `latest`          |
| `N.N.N-rc.N` tag                | Exact tag                                           | `rc`              |
| Other branch or unsupported tag | No publication                                      | —                 |

All public packages are released together, including `pgwasm`, `pgwasm-c` and
`pgwasm-pg-dump`. Same-scope dependencies and peers are pinned to that exact
candidate version, so an RC install cannot silently mix a PG19 package with its
stable PG18 sibling. Agent Skill version pins are stamped with that version too.

An RC tag can point at the reviewed `port-19` commit without promoting PG19 onto
`main` or `develop`. Pushing that branch publishes nothing. Manually dispatching
the GitHub Packages workflow on it runs validation but skips publication;
manual branch publication is limited to `develop`.

For either a stable or RC tag, the GitHub Packages publish job depends on:

1. `bun run validate:full`.
2. The existing `bun run test:integration` container lanes.
3. `bun run test:browser:pgwasm-idb`, including dump/restore, in Chromium and WebKit.
4. `bun run test:browser:pgwasm-opfs` in Chromium and WebKit.

Failure in any required lane prevents publication. An RC uses `rc` in both
registries and leaves `latest` unchanged. Unsupported prerelease types, malformed
versions and leading-zero numeric components are refused before package staging.

## Publication

After adopting and qualifying the PG19 assets, inspect both publication plans:

```bash
DRY_RUN=1 GITHUB_REPOSITORY=pgxsinkit/pgxsinkit GITHUB_REF_TYPE=tag GITHUB_REF_NAME=0.6.0-rc.1 bun run publish:github-packages
DRY_RUN=1 bun run release:npm 0.6.0-rc.1
```

Dry runs do not rewrite package manifests or skills, require credentials, fetch
tarballs, or publish packages. The GitHub dry run still checks the staged skill
pins in memory. The npm dry run shows the mirror plan; it does not prove the
candidate already exists on GitHub Packages.

Tag and push the qualified commit only when publication is authorized. The
GitHub Packages workflow builds and publishes the candidate under `rc` after
its gates pass. Wait for that job to finish before mirroring to public npm:

```bash
bun run release:npm 0.6.0-rc.1
```

The mirror downloads the exact GitHub Packages tarball for each package and
passes that tarball directly to `bun publish --tag rc`; it does not rebuild,
repack or rewrite the package. The npm credential stays on the maintainer's
machine. Verify the candidate versions and `rc` dist-tags in both registries,
and verify that their `latest` dist-tags retain their previous versions.

## Store compatibility

The PG19 candidate uses C data format 2. PG18 stores use format 1 and cannot be
opened by the PG19 build. Use fresh, separately named stores for this candidate
and retain the incompatible-store refusal. A package upgrade alone does not
authorize destroying, overwriting or migrating a PG18 store.
