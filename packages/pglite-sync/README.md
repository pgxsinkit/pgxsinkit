# @pgxsinkit/pglite-sync

This package vendors the upstream `@electric-sql/pglite-sync` `0.5.4` source from `tmp/pglite/packages/pglite-sync`.

It exists so this repository can:

- patch sync behavior locally when upstream drift appears
- add repository-specific regression tests without waiting on a release
- keep `@electric-sql/pglite` pinned to the version actually required by the vendored code until the upgrade is proven

When updating this package, record the upstream source commit or release and add tests for any behavioral change.
