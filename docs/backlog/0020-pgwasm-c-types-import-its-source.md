# 0020 — `@pgxsinkit/pgwasm-c`'s published types import its TypeScript source

Status: candidate (recorded 2026-09-29)
Opened: 2026-09-29 · Area: `packages/pgwasm-c` (`artefacts/postgres.d.ts`, `artefacts/initdb.d.ts`,
the `files` list in `package.json`)
Reopen trigger: a consumer that typechecks without the DOM or WebWorker library, or the next change
to how `pgwasm-c` is packaged.

## The fact

- The package publishes `artefacts/postgres.d.ts` and `artefacts/initdb.d.ts`, and both import their
  types from `../src/host/emscripten`. That is a `.ts` source file, which the package also ships
  (`src` is in `files`).
- A consumer's `tsc` follows the import and typechecks that source as part of the consumer's own
  program. `skipLibCheck` does not apply: it skips declaration files, not sources.
- The source uses `WebAssembly.Memory` and `WebAssembly.Instance`. TypeScript declares those only in
  its DOM and WebWorker libraries; `@types/node` does not declare them.
- So a consumer whose `lib` has neither cannot typecheck once it imports the package, with errors
  that point into `node_modules`.

## Who it affects

Browser applications have the DOM library, so emergent and the board never see it. It was found in
`pgxsinkit/circuits`, whose test harness is typed for Node alone and briefly used pgwasm as an
in-process oracle: the workaround there was to add `"DOM"` to `lib` for the whole workspace.

pgwasm does not support Node at run time either (its C build loads its files with `fetch` on
`file://` URLs, which Node's `fetch` does not read). That is documented and deliberate; this item is
only about the types.

## Fix direction

The artefacts' declarations should import from the package's built declarations (`dist`), not from
`src`, so that a consumer typechecks declarations only. Whether `src` needs to be published at all
is the second question.
