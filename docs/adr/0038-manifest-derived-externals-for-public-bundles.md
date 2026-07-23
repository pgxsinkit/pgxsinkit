# Manifest-derived externals for the public package bundles

Status: accepted (2026-07-11). Generalizes the externalization half of
[ADR-0037](0037-vite-library-build-for-react-package.md) to every public package;
[ADR-0008](0008-docs-prove-interface.md) Decision 4's `target: "bun"` conclusion continues to stand
for the non-react packages.

The three Bun-built public bundles (`contracts`, `client`, `server`) each shipped a full inlined
copy of drizzle-orm's entity machinery, and `client`/`server` additionally inlined all of
`@pgxsinkit/contracts` — dependencies their manifests declare as peers/dependencies the consumer
installs anyway. This was never a decision: the root `tsconfig.base.json` `paths` map `drizzle-orm`
and every `@pgxsinkit/*` name to file paths, and `Bun.build` applies that resolution *before*
`packages: "external"` classifies imports as bare-vs-local — so exactly the paths-mapped names
stopped being "packages" and were vendored in. Consumers paid twice (their own installed copy plus
the inlined one; ~190 kB × 3), and cross-copy correctness survived only because drizzle and the
store-path marker happen to use `Symbol.for`.

## Decision

1. **The artifact contract, all four packages:** every static import in a published bundle is
   declared in that package's manifest, and nothing is bundled except the package's own source.
   (For react this was ADR-0037 §2; this ADR promotes it to the general rule.) The deliberate
   ADR-0036 carve-out is unaffected: `client`'s `index`/`testing` entry points keep bundling their
   own *relative* modules independently.
2. **Bun stays for `contracts`/`client`/`server`; each build derives `external` from its own
   manifest** (`dependencies` + `peerDependencies` keys). `external` matches specifiers **as
   written** — before `paths` resolution — so the list defeats the mapping, and because it *is* the
   package.json, it cannot drift from the manifest. All-Vite was rejected: it was only attractive
   while Bun looked unable to externalize correctly, and moving the server package onto a
   browser-oriented toolchain for uniformity is exactly the aesthetic-only migration this repo
   avoids. React stays on Vite for its own recorded reason (production JSX runtime, ADR-0037).
3. **`packages: "external"` is dropped, not kept as a backstop — the options do not compose.**
   Probed on Bun 1.3.14: with both `packages: "external"` and an explicit `external` list set, the
   paths-mapped names are inlined again; `external` alone behaves correctly. The backstop against a
   bare-but-undeclared import being silently vendored moves into the test (below), which is
   strictly stronger.
4. **The contract is test-pinned in the fast lane.**
   `tests/unit/public-package-artifacts.test.ts` builds every public package through the real build
   path and asserts, per entry point: every static import is manifest-declared; known runtime
   dependencies appear as external imports; no `drizzle:entityKind` inline marker; and — the
   general backstop — the external sourcemap's `sources` contain **no `node_modules` path**, so
   *any* vendored dependency (declared or not) fails loudly. React additionally keeps its
   production-JSX assertions. The packed fixture (ADR-0008/0037) proves the de-inlined bundles
   install, typecheck, and render downstream.

Result: `contracts` 246 kB → 60 kB, `client` 526 kB → 263 kB, `server` 260 kB → 75 kB, one shared
implementation of drizzle/contracts per consumer instead of up to four.
