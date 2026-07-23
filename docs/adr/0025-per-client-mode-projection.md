# Per-client mode projection: one authoritative registry, readonly projections per client

Status: accepted (2026-06-29) — `asReadonly` + read-contract fingerprint + the projection invariant implemented and tested in `@pgxsinkit/contracts`

## Context

A registry entry's `mode` is `readonly` | `readwrite` | `writeonly`, fixed at `defineSyncTable` time. Until
now the implicit assumption was that a table's mode is a global property of the table. Planning a
consumer's migration (emergent's teacher-portal moving from request/response onto the sync rail) surfaced a
case that assumption cannot express: **the same table is `readwrite` for one client and `readonly` for
another.** Both directions occur — a teacher writes `posting_restriction` / `group` / `discussion` that a
learner only reads; a learner writes `report` that a teacher only reads. Mode is genuinely a **per-client**
capability, not a property of the table.

### Why mode can't simply be reused or hand-overridden

`mode` is not a passive flag — `defineSyncTable` derives three things from it
([`registry.ts`](../../packages/contracts/src/registry.ts)): the overlay/journal client projection
(`${t}_overlay`, `${t}_mutations`), the overlay-merged `_read_model` view that `useLiveDrizzleRows` reads,
and (via `defineSyncRegistry` validation) the requirement that a writable table declare a `conflictPolicy`
+ a `nowMicroseconds` server version. The client mirrors it: `generateLocalSchemaSql`
([`client/schema.ts`](../../packages/client/src/schema.ts)) skips the overlay/journal/reconcile cluster for
`readonly`, and the mutation runtime only builds `client.tables.X` write handles for non-readonly tables.

So the two naive workarounds both fail:

- **Reuse the `readwrite` entry in the read-only client** — the client provisions overlay/journal, exposes
  write handles it must never call, and any accidental write is optimistically applied then **quarantined**
  when RLS rejects it. A footgun, and it cannot serve the reverse direction at all.
- **Hand-spread `{ ...entry, mode: "readonly" }`** — the entry still carries the `readwrite`-derived
  `view` and `clientProjection.overlay/journalTable`, but schema generation (keyed on `mode`) never creates
  them, so the `_read_model` view references missing overlay state. Broken, because the mode-derived fields
  are not re-resolved.

### The fingerprint is not a blocker (the earlier concern, closed)

The registry-shape fingerprint (ADR-0004, `fingerprintRegistry`) folds in `mode`, the overlay/journal
projection, and `managedFields`, so a writable entry and its readonly counterpart hash **differently**.
That is **not** a problem, on evidence: that fingerprint is **client-local** — `reconcileLocalStoreVersion`
([`client/local-store.ts`](../../packages/client/src/local-store.ts)) compares a client's *stored* vs
*current* fingerprint to decide whether to rebuild **its own** store. It is never sent to the server (the
flushed batch body is `{ writeUnit, mutations }`), the apply function takes no fingerprint argument, and the
server mutation path never reads it. Two clients **should** have different full fingerprints — their local
stores genuinely differ (one has the write cluster, one doesn't), and the fingerprint exists to guard each
client's own rebuild. The server's separate apply-function fingerprint (ADR-0018) is generated from the
*authoritative* registry and is independent of any client.

What the consumer *also* asked for — a stable identity that abstracts the readwrite-vs-readonly difference —
is real and useful, but for a different job: a **checked invariant** that a projection didn't silently
diverge the data it syncs (see decision 3).

## Decision

1. **One authoritative registry; per-client registries are projections of it.** The authoritative registry
   defines every table at its true maximum capability (`readwrite` wherever *any* client writes it) with a
   claims-branching `customWhere` and role-aware RLS. The server uses it for both the Electric shape proxy
   and apply-function generation — the apply function already emits a branch for **every** table regardless
   of mode and keys `reject-if-stale` / managed-field stamping off `entry.conflictPolicy` / `governance`
   ([`plpgsql-apply.ts`](../../packages/server/src/mutations/plpgsql-apply.ts)), so it must be generated from
   the entry that carries the full write contract. A claims-branching read filter serves every client from
   one shape definition (each request carries its own claims), so the proxy needs no per-client registry.

2. **`asReadonly(entry)` — the readonly projection** (`@pgxsinkit/contracts`,
   [`projection.ts`](../../packages/contracts/src/projection.ts)). It returns the entry `defineSyncTable`
   would have produced for the same table with `mode: "readonly"`: `mode` → `readonly`; the `_read_model`
   `view` and the overlay/journal client projection are dropped (a readonly client reads the synced base
   table directly); `conflictPolicy`, `governance`, and `writeMode` are dropped (no write path). The
   read/identity contract — `table`, `localTable`, columns, primary key, synced-table name, column
   omission, the shape/row filter — is preserved, and lifecycle axes (`consistencyGroup`, `subscription`,
   `retention`) carry through. `defineSyncRegistry` then accepts it without the writable-table requirements.

3. **A read-contract fingerprint** (`fingerprintReadContract`,
   [`fingerprint.ts`](../../packages/contracts/src/fingerprint.ts)) over the subset of the canonical shape
   that decides *what data syncs and how a row is identified/filtered*: synced-table name, columns, primary
   key (+ local-PK override), column omission, and the shape (electric table + row filter). It deliberately
   **excludes** write capability (`mode`, overlay/journal, `managedFields`, `conflictPolicy`, `writeMode`)
   and lifecycle orchestration (`consistencyGroup`, `subscription`, `retention`) — the two axes a projection
   may legitimately differ on. It is **equal** for a writable entry and its `asReadonly` projection.

4. **`assertReadContractPreserved(authoritative, projection)`** — the invariant the whole model rests on.
   For every table a projection declares, its read-contract fingerprint must equal the authoritative
   entry's; a table only in the authoritative registry is a permitted subset, a table in the projection with
   no authoritative source is an error. Called where the client registries are assembled, it turns "a
   projection may differ *only* in write capability and lifecycle" from a convention into a fail-closed
   check. Like every fingerprint here it cannot see the `customWhere` *body* — bump `rowFilter.revision` so
   a logic-only divergence is caught.

## Alternatives considered

- **A `mode` override on `defineSyncRegistry` (a per-registry mode map)** — rejected as heavier: the
  mode-derived fields (view, overlay/journal projection) would still need re-resolution at registry
  assembly, duplicating `defineSyncTable`'s logic at a second site. `asReadonly` is one composable transform
  applied per entry, readable at the call site, and symmetric with how entries are already spread into a
  registry.
- **Strip write capability out of the main registry fingerprint so the variants share one** — rejected: the
  full fingerprint *must* differ, because it guards each client's local-store rebuild and the local stores
  genuinely differ. The stable cross-variant identity belongs in a *separate* fingerprint scoped to the read
  contract (decision 3), not by weakening the one whose job is to detect local-store change.
- **No invariant — rely on `asReadonly` being used correctly** — rejected: a hand-built or drifted
  projection that drops a column or diverges a filter would silently serve different rows to different
  clients. The read-contract fingerprint makes the check a one-line equality; not enforcing it wastes the
  primitive that exists precisely to catch this.

## Consequences

- A consumer can put one table on the rail as `readwrite` for the role that authors it and `readonly` for
  the role that only reads it, from a single authoritative registry — with **no** Electric or server change
  (the apply function and proxy already accept the authoritative registry; clients consume projections).
- `assertReadContractPreserved` keeps a growing authoritative registry honest as projections multiply: a
  projection can only differ in write capability and lifecycle, never in the data it syncs.
- The read-contract fingerprint inherits the `customWhere`-invisibility caveat of ADR-0004 — a logic-only
  row-filter change between an authoritative entry and a projection is caught only if `revision` is bumped.
- This is the `@pgxsinkit/contracts` half. The consuming half (an authoritative registry + teacher/learner
  client projections, the role-branching read filters, and the teacher-write RLS) lands in the consumer.
