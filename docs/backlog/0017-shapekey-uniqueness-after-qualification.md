# 0017 — `shapeKey` uniqueness is checked before schema qualification

Status: candidate (recorded 2026-08-22)
Opened: 2026-08-22 · Area: `packages/contracts/src/registry.ts` (`validateRegistryShapeKeyUniqueness`,
`attachSyncRegistrySchema`), `packages/server/src/circuits/compile.ts` (entry lookup by `shapeKey`)
Reopen trigger: a registry that gives one entry an explicit schema-qualified `shapeKey` while another
entry's key is left to default — or the first "wrong shape for this key" report on a schema-bound
registry.

## The fact

- `defineSyncRegistry` refuses duplicate `shapeKey`s (`validateRegistryShapeKeyUniqueness`, in both
  overloads) — but it runs on the **input**, before `attachSyncRegistrySchema` qualifies keys.
  Qualification rewrites a defaulted key (`shapeKey === tableName`) to `<schema>.<table>` and leaves
  an explicit key alone.
- So `{ tableName: "x" }` (key `x`, qualified to `app.x`) beside `{ tableName: "y", shapeKey: "app.x" }`
  passes the check and collides after qualification. Nothing downstream refuses the collision: the
  server resolves an entry by `Object.values(registry).find((entry) => entry.shape.shapeKey === key)`
  — first match — and the client keys readers and cursors by the same string, so the second entry's
  subscribe, cursor and rows all land on the first entry's definition, silently.
- It takes a contrived registry (an explicit qualified key that happens to equal another entry's
  qualified default) — but it is silent when it happens, and the refusal it slips past was added
  precisely so this class fails at definition.

## The fix

Validate again on the **qualified** registry — after `attachSyncRegistrySchema`, before storage is
attached — or move the one check there and have its message name the keys as they are
post-qualification. One call plus a unit test with the colliding pair. For defence in depth, make the
server's lookup refuse more than one match (registries are small; a `filter` costs nothing), so a
registry that did not pass through `defineSyncRegistry` fails loud at the first subscribe rather than
serving the wrong shape.
