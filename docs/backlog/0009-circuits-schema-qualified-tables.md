# Circuits keys tables by bare name — schema-bound registries cannot sync on the native path

Status: candidate (blocks native-path cutover for any registry declaring a schema)

Found 2026-08-20 while building [ADR-0055](../adr/0055-circuits-native-sync-core.md)'s control
plane. The shape compiler refuses a schema-qualified target rather than sending a name the engine
would not find; this item is the engine change that removes the refusal.

## What breaks

`SyncRegistryDefinition.schema` is the **Postgres source** schema, not just a local-store namespace:
`attachSyncRegistrySchema` validates it against `getTableConfig(entry.table).schema` and qualifies
`shape.tableName` / `electricTable` from it. So a registry bound to a non-`public` schema is a
shipped, supported pgxsinkit feature — and on the Circuits-native path it has nowhere to land.

Electric supports schema-qualified shapes, so this is a **regression at cutover**, not a capability
we never had. pgxsinkit's own demo registries are all `public`, which is exactly why it would have
gone unnoticed until a consumer hit it.

## Evidence

The engine's table identity is a bare `String` end to end.

| Site                                 | What it does                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `apps/engine/src/pg.rs:148`          | lists tables with `table_schema = 'public'`, and probes the PK via `to_regclass('public.'\|\|t.table_name)` |
| `apps/engine/src/pg.rs:167`          | reads columns with `table_schema = 'public'`                                                                |
| `apps/engine/src/pg.rs:173`          | fails with `table '{table}' not found in postgres (schema public)`                                          |
| `apps/engine/src/pgoutput.rs:62`     | **parses** the relation namespace off the replication wire                                                  |
| `apps/engine/src/replication.rs:233` | `Message::Relation { rel_id, name, columns, .. }` — **discards** it; `RelMeta.table` is the bare name       |

Two same-named tables in different schemas therefore collide silently rather than erroring: whichever
relation arrives keys the same entry.

## A second defect, in the compat adapter

`apps/engine/src/electric.rs:797` handles Electric clients' qualified names by **stripping the
prefix**:

```rust
// Electric clients send schema-qualified table names (`public.users`); our engine keys by the bare
// table name. Strip any schema prefix.
if let Some((_schema, bare)) = p.table.rsplit_once('.') {
    p.table = bare.to_string();
}
```

So `GET /v1/shape?table=private.users` is answered with `public.users` — a different table's rows,
no error. `docs/live-queries-guide.md:125` documents this as "schema-qualified names like
`public.todos` are **accepted**", which is true only for the one schema that happens to be right.

This is a fifth defect in the same file as the four already fixed and contributed upstream, and it
belongs in the same report — it is a wrong-rows disclosure on the compat path, which is a
sharper class of bug than the four ordering and header fixes.

**Fixed in the fork** (`84c068c`, "reject a non-public schema qualifier instead of stripping it`") —
but note what that fix is and is not. It removes the **disclosure**: a qualified name for a schema the
engine cannot serve now errors instead of silently answering with a different table's rows. It does
not add **schema support**, which is what this item is about and what remains open below.

**Neither half is on our path.** ADR-0055 decision 1 puts us on the native API, which never reaches
`electric.rs`. The disclosure is recorded because the upstream report should carry it; the capability
gap is recorded because the native path hits it too, from the other side.

## Why it is almost certainly an alpha shortcut, not a decision

Worth stating explicitly, because we have no answer from the maintainers and the mailing list has
not replied — so the reading below is inference from the code, and should be labelled as such if it
ever reaches an upstream thread.

- The namespace **is** parsed off the wire and then thrown away. Nobody decodes a field they have
  decided not to support.
- `TableDef` / `Schema` are keyed by a plain `String`, with no qualified-name type anywhere — the
  shape of code that has not yet met the requirement, rather than code that turned it down.
- The compat adapter **strips** rather than **errors**. A deliberate public-only design would reject
  a foreign schema loudly; silently aliasing it is what you write when collisions have not been
  considered.
- No ADR, design note, README line, or commit message anywhere in the repo argues for it.

The practical consequence: an upstream fix is likely to be welcome rather than contentious. But we
cannot confirm that, and should not assume the fork's version will land.

## Scope of the change

Bounded, and mostly mechanical — the information is already on the wire, merely discarded.

1. `pg.rs` — take a schema (or scan all non-system schemas) in `list_tables` and `introspect`; drop
   the `'public.'||` literal in favour of a qualified `to_regclass` argument.
2. `replication.rs` — stop discarding the namespace in `on_relation`; make `RelMeta.table` qualified.
3. `schema.rs` — key `Schema.tables` by qualified name, with a documented rule for how a bare name
   resolves (almost certainly `public`, for compatibility with every existing caller).
4. `ShapeDef.table` — accept a qualified name; the predicate AST needs no change, since it references
   columns of one already-resolved table.
5. `electric.rs` — resolve the prefix instead of stripping it, which fixes the defect above as a
   side effect.
6. Conformance: a fixture with the same table name in two schemas, asserting they stay distinct.

Estimate: about a day in the engine plus conformance. Not a redesign.

## Reopen trigger

Before native-path cutover, unconditionally — the library ships the feature, so "no consumer uses it
today" is not a reason to carry the regression into a release. Sooner if a consumer's registry
declares a schema, which turns this from a cutover blocker into an outright blocker.

Until then the control plane's refusal stands, and it names the reason rather than failing deep
inside shape creation.
