# One registry interpreter: shared resolvers and a registry fingerprint

Status: proposed (2026-06-22)

The sync registry (`defineSyncTable` / `defineSyncRegistry`) is the single
declaration of every synced table — its mode, keys, projection, shape, and
governance (`packages/contracts/src/registry.ts`). Validation runs at declaration
time (`:515-607`). But the *meaning* of that declaration is re-derived
independently in many modules: local DDL (`client/schema.ts`), client construction
(`client/index.ts`), mutation mapping (`client/mutation.ts`), shape config
(`sync-engine`), the Electric proxy (`server/electric-proxy.ts`), write validation
(`server/mutations/route.ts`), the applier generator
(`server/mutations/plpgsql-apply.ts`), and governance migration generation
(`schema/governance.ts`).

This is not merely theoretical drift. Identifier/SQL quoting alone has **five-plus
independent, disagreeing implementations**:

- `client/schema.ts:473` conditionally quotes, consulting the only
  `RESERVED_SQL_KEYWORDS` set (`:393`); its comment (`:379-387`) records the
  already-shipped `group`-table bug.
- `client/mutation.ts:1783` returns the **bare** name for the `public` schema and
  otherwise always-quotes, consulting **no** reserved-word set — the same class of
  bug `schema.ts` fixed, still latent in the mutation path.
- `server/mutations/plpgsql-apply.ts:15` always-quotes unconditionally.
- `contracts/supabase-rls.ts:52` **throws** on complex identifiers, with a regex
  that allows uppercase (`[A-Za-z_]`) — a different definition of "simple
  identifier" than `schema.ts`'s lowercase-only `[a-z_]`.
- `schema/governance.ts:126` and `schema/performance.ts:385` each carry their own
  `quoteIdent`.

Other modules also each interpret mode, primary keys, local primary keys,
projection, omitted columns, and managed fields. Managed-field selection is
appropriately centralised in `route.ts` — quoting is the real offender, and it has
already produced one shipped bug plus one latent one.

## Decision

1. **Identifier and literal handling has exactly one home.** A single
   quoting/identifier module in `contracts` (the shared layer) owns: what a "simple
   identifier" is, the reserved-word set, quote-when-needed, `qualify(schema,
   name)`, and string-literal escaping. Every consumer imports it; the five
   divergent copies are deleted. Deleting the copies removes the drift (passes the
   deletion test); a shared resolver each consumer routes through is a useful deep
   module.

2. **We do not build a compiled "plan" representation.** A compiler that emits
   path-specific plans each consumer still re-interprets merely moves code and adds
   a **second** model that can drift from the registry (fails the deletion test).
   Consolidation is via shared resolvers, not a parallel artifact.

3. **The registry gains a canonical fingerprint** — a stable hash of its shape
   (tables, columns, types, keys, projection, governance). This is a foundational
   primitive consumed by [ADR-0006](0006-local-schema-evolution.md) (journal
   version-stamp + schema-evolution detection) and the registry-diff gate. It
   belongs here because the registry is the single source of truth.

4. **`rowTransform` moves out of the client-named `clientProjection` bucket.** It
   is a **server-executed** function (run in the proxy, `electric-proxy.ts:144`);
   housing it under "clientProjection" is a domain-ownership leak. It is renamed to
   a server-projection concept. Pre-launch, rename cleanly and migrate every
   consumer and test (no legacy).

## Consequences

- One quoting bug fixed (the `mutation.ts` public-schema bare path) and that class
  of bug closed permanently.
- The fingerprint unlocks ADR-0006 with no new model to maintain.
- Modest churn across packages, all behind one import.

References: [ADR-0006](0006-local-schema-evolution.md) (consumes the fingerprint);
`CONTEXT.md` (Read model, Overlay, Mutation journal);
[docs/plans/0004-one-registry-interpreter.md](../plans/0004-one-registry-interpreter.md).
