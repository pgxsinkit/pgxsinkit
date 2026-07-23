# Runbook: bump the pinned ElectricSQL version

## When to use

Every pgxsinkit release, **before tagging**. ElectricSQL ships fast; each release re-pins to a current,
tested Electric image so the compose stacks, the docs, and the integration lanes all agree.

## The one command

```bash
bun run electric:bump 1.7.6     # or: bun run electric:bump --latest
```

`--latest` resolves the newest `X.Y.Z` tag from the Docker Hub API. Either way the script updates the
single source of truth — `infra/electric-version.json` — then rewrites every managed reference from it
(both compose files and the two docs pages). It never touches provenance mentions (see below).

## The checklist the script prints (do NOT skip)

1. `bun update @electric-sql/client` — the wire-protocol client lib versions **separately** from the
   server image; review it in the same motion.
2. `bun run test:integration` — the **sync-e2e** lane is the real wire-compat proof; it pulls the new
   image in the podman lanes. A move-in/move-out tag or shape-log failure is a genuine incompatibility —
   stop and report, do **not** pin back down silently.
3. Commit the pin file, the rewritten references, and any lockfile change together.

`bun run electric:check` (also in `check` and `check:fast`, the commit gate) asserts every managed
reference still matches the pin — a millisecond filesystem check that fails drift closed.

## The floor vs the version

`infra/electric-version.json` carries two numbers:

- **`version`** — the pinned/tested release. Auto-bumped by `electric:bump`.
- **`floor`** — the hard minimum, feature-driven: the subquery preview `where` needs Electric ≥ 1.7.
  It changes **rarely and by hand**, only when a new Electric-version-gated capability becomes required.
  A bump below the floor is refused.

## Provenance is never rewritten

The bump script deliberately leaves historical wire-capture mentions alone — they record _what was
verified when_, not a live compatibility claim:

- `docs/adr/0023-*.md`, `docs/adr/0024-*.md` ("captured wire messages, Electric 1.7.4")
- `packages/client/src/sync/tags.ts` and `tests/unit/shape-tags.test.ts` (wire-capture comment/fixture)

The integration lanes re-verify the wire against each new image; those comments are provenance, not
pins. Do not hand-edit them to match a bump.
