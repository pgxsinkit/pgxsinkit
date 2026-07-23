# One claim-stamping managed-field strategy: `authClaim`

Status: accepted (2026-06-29) — `authClaim` (claim path + cast) replaces `authUid` across `@pgxsinkit/contracts`, `@pgxsinkit/server`, `@pgxsinkit/client`, and the reference + board schemas; implemented and tested.

## Context

A governance **managed field** is a column the in-database apply function stamps under the verified
request claims, overriding any client-sent value (the client write payload omits managed fields; the
create-validation schema strips managed-on-create columns). Until now there were two strategies
([`config.ts`](../../packages/contracts/src/config.ts)):

- `nowMicroseconds` — `clock_timestamp()` microseconds (the audit columns; the `updated_at_us`-on-update
  field is the strictly-monotonic server version, ADR-0010).
- `authUid` — emitted `auth.uid()`, i.e. the auth subject (`request.jwt.claims ->> 'sub'`), cast to `uuid`.

Planning emergent's teacher-portal migration onto the sync rail surfaced a gap `authUid` cannot fill:
emergent keys authorization off **`app_metadata.person_id`**, an app-minted identity that is *independent
of the auth uid* (its `person.id` is decoupled from the Supabase `sub`). emergent therefore could not
declare `created_by_person_id` / `author_person_id` as managed fields at all — it hand-stamped them in a
per-table applier shim in front of `pgxsinkit_apply_mutations`, re-deriving the person id from the claims
the apply function *already has*. That shim is an app-layer workaround for a missing pgxsinkit capability.

The key observation: the person id is **already inside the apply function** — it sets the full claims as
`request.jwt.claims` before running the DML (it is exactly what RLS reads). Nothing is missing at the data
level; the only gap is a codegen strategy that stamps a column from an **arbitrary claim path**, not just
`sub`. And once such a strategy exists, `authUid` is just a special case of it — `claimPath: ["sub"]`,
`cast: "uuid"`. Keeping both would be a `sub`-only mechanism sitting beside a general one: two ways to do
the same thing.

## Decision

Collapse to **one** claim-stamping strategy. `ManagedFieldStrategy` is `"nowMicroseconds" | "authClaim"`;
`authUid` was removed before the supported `0.2.0` baseline. An `authClaim` field declares:

```ts
{ column: "createdByPersonId", applyOn: ["create"], strategy: "authClaim", claimPath: ["app_metadata", "person_id"] }
// the old owner idiom is just:
{ column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] }
```

- **`claimPath`** (required) — a JSON path into the verified claims. Each segment must be a plain
  identifier (`[A-Za-z_][A-Za-z0-9_]*`); it is emitted into the apply-function DDL as a `jsonb #>>`
  text-array path, so it is validated at registry build and is never a value-injection surface.
- **`cast`** (optional) — defaults to the **target column's own SQL type**, so a `uuid` column needs no
  declaration. Overridable to force a different cast; must be a plain SQL type name.

The server codegen ([`plpgsql-apply.ts`](../../packages/server/src/mutations/plpgsql-apply.ts)) emits, for
a create/update managed assignment:

```sql
(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb #>> '{app_metadata,person_id}')::uuid
```

`current_setting('request.jwt.claims', …)` is the GUC the function already sets from the passed claims;
`NULLIF` guards an unset GUC so an absent claim stamps `NULL` (never errors). The write path no longer
emits `auth.uid()` at all (RLS policies may still use it — that is orthogonal, checked by
`verifyRlsAuthHelpers`).

The client optimistic overlay generalizes in step
([`mutation.ts`](../../packages/client/src/mutation.ts)): `decodeJwtClaims` + `readJwtClaimPath` fill an
`authClaim` create field from the decoded claim at its path (the same value the server stamps), so a
NOT-NULL claim-stamped column renders attributed immediately and never flips on convergence.

## Consequences

- **One mechanism.** A reader learns claim-stamping once; `["sub"]` is not a special case in the codegen,
  the client, or the docs.
- **emergent's applier shim collapses.** With `created_by_person_id` / owner columns declared `authClaim`,
  the per-table stamping that re-derived the person id moves into the registry; the shim keeps only genuine
  cross-table derivations (a post's group from membership, a report's context from the post) and projections.
- **pgxsinkit's own schemas + board migrated.** The reference (`packages/schema`) and board
  (`packages/board-schema`) owner/author fields are `authClaim` at `["sub"]`; the apply-function migrations
  (`infra/drizzle`, `infra/board-drizzle`) were regenerated (their fingerprints shifted — ADR-0018 drift
  detection confirms the committed migration matches).
- **The `sub` case.** `authClaim ["sub"]` cast to `uuid` stamps the owner/author column with the JWT
  `sub` claim, read from `request.jwt.claim.sub` — the same source `auth.uid()` resolves.
