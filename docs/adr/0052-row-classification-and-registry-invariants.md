# Row classification and registry invariants

Status: accepted (2026-07-31)

## Context

A consumer's privacy or visibility rule ("a private row is never visible to anyone but its owner",
"nothing in this registry streams to an anonymous caller") is almost never a property of ONE entry. It is
a property of a whole KIND of row, spread across many entries, enforced on two different engines: the
Electric shape `where` on the read path and Postgres RLS on the write path. The registry already makes
each entry's two surfaces derivable from one declaration (ADR-0003's mirrors), and
`assertReadContractPreserved` (ADR-0025) pins one table's read contract across per-client projections.
Neither addresses a rule that spans entries. Consumers expressing one hit two structural drift modes:

1. **Read/write asymmetry.** The row filter and the policies are two engines and two code paths. Either
   can be tightened or loosened alone, and the mismatch is invisible until a row turns up
   readable-but-unwritable (or, worse, readable by the wrong caller). Per-entry review does not catch it
   reliably, because the reviewer sees one entry and the rule lives across many.

2. **Under-enumeration — the worse one.** An invariant expressed over a hand-written list of tables is
   only as complete as that list. Every NEW entry inherits the obligation *invisibly*: nobody who adds a
   table is prompted to ask whether it carries private rows, and the test that "enforces" the invariant
   keeps passing because it never looked at the new table. Coverage silently decays as the registry grows
   — the failure mode is a green suite, which is the worst kind.

The fingerprint cannot help with either: the `customWhere` **body** is a closure, so only its presence and
the consumer-bumped `RowFilterSpec.revision` are hashed. A logic change inside the filter that widens who
can see what is, to the fingerprint, no change at all.

## Decision

Add a consumer-defined **row classification** to the registry, validated exhaustively, and a
contracts-level assertion that audits the **rendered** authorization artifacts per classification.

1. **`rowClass` on the entry — a consumer vocabulary, not ours.** `SyncTableEntry.rowClass?: string` (and
   the matching `defineSyncTable` input) names what KIND of rows the entry carries. pgxsinkit defines no
   values and attaches no behaviour to any: the vocabulary belongs to the domain, and only the consumer
   knows whether their split is owner/team/reference or something else entirely. Its immediate value is
   documentation-as-code at the definition site for every future entry author.

2. **`rowClasses` on the registry — declaring the vocabulary makes classification mandatory.**
   `SyncRegistryDefinition.rowClasses?: readonly string[]` is the registry's CLOSED vocabulary. When
   declared, a fifth validation pass in `defineSyncRegistry` (`validateRowClassification`, beside
   `validateStorageDeclaration`) rejects — at module eval, for every consumer — any entry that carries no
   `rowClass` or one outside the set, naming **every** offender in one error. This is the direct answer to
   drift mode 2: a new entry cannot join the registry without its author classifying it, so it joins its
   class's invariants by construction rather than by someone remembering. Declaring nothing leaves
   `rowClass` unconstrained, and the bare-registry-map overload is always unconstrained (it has nowhere to
   declare a set). The declared set rides on the returned registry as a third non-enumerable symbol
   (`syncRegistryRowClassesSymbol` / `attachSyncRegistryRowClasses` / `getSyncRegistryRowClasses`),
   exactly as the schema and storage declarations do.

3. **`assertRegistryInvariant` — audit the RENDERED artifacts, per persona.** A new module-eval assertion
   in the `assertReadContractPreserved` family. A spec names the invariant, binds it (`appliesTo`: row
   classes — the normal form — or a predicate), declares named `claimsFixtures` personas, and supplies a
   `holds` predicate over one (entry × fixture) cell. Each cell carries the **real** rendered output:
   `renderedWhere` from `buildRowFilterShape(entry.shape.rowFilter, claims)` — the exact call the Electric
   proxy makes per shape request — and `renderedPolicies`, the entry's table policies read off drizzle's
   `getTableConfig` and rendered to inline SQL text the way the policy DDL carries them. Both surfaces, one
   predicate: that is the answer to drift mode 1. Every bound entry is evaluated against every fixture and
   **all** failing cells are aggregated into one error (`entry (fixture): reason`), never first-failure-only.
   Three fail-closed choices: an `appliesTo` class outside the registry's declared vocabulary throws
   immediately (a typo must not pass as "nothing to check"); an invariant binding **zero** entries throws
   (an invariant that checks nothing passes vacuously, which is the failure this mechanism exists to
   remove); and a spec with no fixtures throws. It is a pure audit — it renders through production code
   paths and changes no runtime behaviour.

4. **Classification is carried explicitly by every entry-rebuilding helper.** `asReadonly` (which rebuilds
   field-by-field) and `defineReadProjection` (which rebuilds through an inner `defineSyncTable`) carry
   `rowClass`; a read projection **inherits the owner's** class by default, with a per-projection override
   for the case where the narrower shape genuinely changes the kind of row a client receives.
   `withRetention`/`asEphemeral` spread the whole entry and carry it inherently. A projection that dropped
   the class would silently un-enrol from its invariants.

5. **Classification participates in the lock and diff as a SIBLING field — never in the fingerprint.**
   `RegistryLock` gains `rowClasses: Record<string, string | null>`, built beside `tables` with sorted
   keys. `diffCanonicalRegistries` takes the two class maps alongside the canonical tables and classifies:
   class → different class is `risky` (`row class changed: A -> B (review invariant enrollment)`),
   unclassified → classified is `compatible` (`row class declared: X` — pure adoption), and classified →
   unclassified is `risky` (`row class removed: X (un-enrols from registry invariants)`). A lock predating
   the field reads as an entirely unclassified baseline, so adopting classification against an old lock is
   a set of compatible declarations, never spurious risk.

**Why `rowClass` stays OUT of the canonical fingerprint serialization.** `CanonicalTable` /
`canonicalizeRegistry` / `canonicalRegistryString` are what `fingerprintRegistry` hashes, and that value is
**persisted** as the local store's read-cache key (and its subscription-state key). Folding classification
in would mean that merely *classifying* an existing table — a pure authoring act that changes not one row,
column, filter or policy — wipes every store's read cache and forces a full resync for every user. That is
an unacceptable price for metadata the runtime never reads. The same reasoning excludes it from
`fingerprintReadContract`: two per-client projections of one table must stay contract-equal, and
classification is not part of the data they sync. The lock carries it instead, so an un-enrolment is still
a reviewable diff. Unit tests pin both invariances (`registry-row-class.test.ts`), and the
registry-fingerprint goldens are unchanged.

## Consequences

- A consumer with a declared vocabulary gets a compile-time-ish (module-eval) prompt on every new entry:
  classify it, or the registry refuses to build. Coverage of a class-bound invariant grows with the
  registry instead of decaying behind it.
- An invariant can assert things the fingerprint structurally cannot see — the rendered `customWhere` body
  per persona — but only for the fixtures it is given. `RowFilterSpec.revision` and the assertion are
  complements, not substitutes: `revision` forces a cache/subscription reset on a logic change; the
  assertion checks whether that logic still upholds the rule, for the personas you enumerated.
- The assertion sees only per-entry declarations. Cross-rail composition (a worker minting rows in table B
  as a consequence of a row written to table A) remains the consumer's obligation and is invisible here —
  documented as such in the `registry-authoring` skill.
- Classification is optional. An existing registry that declares no `rowClasses` behaves exactly as before,
  and adopting one is a `compatible` diff.
- New surface to maintain: one entry field, one registry field, one symbol pair, one validation pass, one
  diff rule, and one assertion.

## Deferred

**Option A — `basePredicates` on `SyncRegistryDefinition`**: a registry-level declaration of predicates
every entry of a class must *include*, so the shared part of a filter is written once and composed rather
than restated per entry. It is the natural next step and this substrate is what it needs (a validated
classification to attach a base predicate to). Deferred because composition semantics — how a base
predicate intersects a per-entry filter, on both engines, without becoming a second authoring language —
need their own design; assertion-based auditing gets the safety property first, at a fraction of the
surface.

## Considered and rejected

- **Hand-listing the bound tables in each invariant (`appliesTo: ["papers", "drafts", …]`).** Rejected:
  that hand-maintained list *is* drift mode 2. Every new entry silently escapes coverage, and the test goes
  on passing.
- **Putting `rowClass` in the registry fingerprint** (so a classification change is caught by the existing
  cache-rebuild machinery). Rejected: the fingerprint is a persisted cache key; classifying a table would
  wipe every store's read cache and force a resync for a change no runtime path reads. The lock/diff gives
  the visibility without the cost.
- **Enforcing classification only through the diff gate** (flag unclassified entries as risky). Rejected:
  the lock is *consumer CI policy* — pgxsinkit ships the mechanism and the consumer decides whether a
  non-zero check blocks (ADR-0006). An obligation that only fires if someone opted into a CI gate is not
  fail-closed; module-eval validation reaches every consumer, always.
- **A pgxsinkit-defined vocabulary** (`"private" | "shared" | "public"`). Rejected: the correct split is
  domain knowledge, and any fixed set would be wrong for most consumers and quietly mis-applied by the
  rest.
- **Asserting over the static specs rather than rendered output.** Rejected: the static spec is what the
  fingerprint already covers. The value here is precisely in rendering the closure per persona, which is
  the only way to see a `customWhere` logic change at all.
