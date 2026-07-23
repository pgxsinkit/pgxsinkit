# Context Map

This repo holds three bounded contexts with deliberately separate vocabularies.

## Contexts

- [Toolkit](./CONTEXT.md) — the `@pgxsinkit/*` packages: the offline-first sync
  product (read path, write path, convergence model). This is what ships.
- [Board demo](./apps/board/CONTEXT.md) — `apps/board`, the reference
  application: a Linear-style issue board with realtime chat that drives the
  toolkit end-to-end for a human to see. An exerciser, not the product.
- [OPFS Repacked VFS](./packages/pglite-opfs-repacked/CONTEXT.md) —
  `packages/pglite-opfs-repacked`, the packed-storage OPFS filesystem under
  PGlite. A storage engine, not sync: it deliberately shares no vocabulary with
  the Toolkit ("journal", "group") or with Postgres ("checkpoint", "WAL",
  "page" are reserved upward and banned here).

## Relationships

- **Board → Toolkit (Consumer)**: the Board installs `@pgxsinkit/*` and declares
  a sync registry; the toolkit interprets that registry to generate the local
  schema, proxy Electric shapes, and apply mutations. The registry is the entire
  contract between them.
- **Vocabulary stays separated**: the Toolkit owns sync vocabulary (shape,
  overlay, mutation journal, consistency group, convergence barrier); the Board
  owns domain vocabulary (Team, Issue, Channel, Message). Neither borrows the
  other's words — in particular the Board's app-domain container is **Team**, never
  "group", because the Toolkit reserves "group" (reserved word + Consistency
  group).
