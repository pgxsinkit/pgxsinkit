# Host a public board /demo on GitHub Pages, reset nightly

[ADR-0008](./0008-board-on-managed-baas.md) made the board runnable against managed Supabase Cloud +
Electric Cloud, with the **frontend run locally** (`bun run dev:board` against the cloud backend) and
"hosting the static SPA somewhere is an optional, documented follow-on." This ADR is that follow-on: a
**public, always-on** board served at `https://pgxsinkit.github.io/demo/`, so the toolkit can be linked
and tried in a browser with zero setup. The Electric subquery preview is now active on the demo's Cloud
source (the ADR-0008 caveat), so the full membership fan-out works for ordinary members, not just admin.

A public, writable, signed-in-as-a-fixture board invites vandalism (offensive issue titles, chat spam).
The decision is to make the shared state **disposable**: restore it to the seeded fixtures every night.

## Decision

- **Publish into the existing docs deploy, not a second workflow.** The board builds into
  `apps/docs/dist/demo/`, so the docs site **and** the demo deploy as one artifact to the
  `pgxsinkit/pgxsinkit.github.io` repo. The docs deploy uses `peaceiris` with `force_orphan: true`,
  which replaces the whole publish — a separate demo workflow would be clobbered on every docs push (or
  the two would race). Co-publishing is the only stable topology. `docs.yml` gains `apps/board/**` and
  `packages/**` to its trigger paths, and a demo-build step gated on the public repo variables so a
  fork still gets a clean docs deploy.
- **Hash routing for the Pages build only.** GitHub Pages serves the **root** `/404.html` for any
  unknown path across the whole site, and that root 404 belongs to the Starlight docs site the demo is
  published alongside. A path-based deep-link/refresh into `/demo/login` would therefore render the docs
  404, not the board. The static demo build sets `VITE_BOARD_HASH_ROUTING=1`, which flips TanStack Router
  to hash history (`/demo/#/login`), so every route boots `/demo/index.html` and the hash drives routing
  — no dependence on the docs-owned 404. Local dev and `board:cloud:dev` keep clean path URLs.
- **The build's two `VITE_BOARD_*` values are public repo VARIABLES, not secrets.** The project URL and
  the `sb_publishable_…` key are baked into client JS by design (the publishable key is meant to be
  public; RLS + the new-key gateway translation are what gate access). They live as
  `DEMO_BOARD_SUPABASE_URL` + `DEMO_BOARD_PUBLISHABLE_KEY` GitHub **variables** — visible, not secret —
  which also lets `docs.yml` gate the demo build on their presence.
- **Nightly truncate + refresh via a scheduled `seed:board`.** A `demo-reset.yml` workflow runs the
  existing seed script (`reset()` truncate-cascades every board table, then recreates the deterministic
  identities + fixtures) on a `0 3 * * *` cron plus `workflow_dispatch`, pointed at the cloud project via
  env. Its inputs are the public URL variable plus two **secrets** — `DEMO_BOARD_SECRET_KEY` (admin API)
  and `DEMO_BOARD_DATABASE_URL` (the **session-pooler** connection for truncate/insert as `postgres`; the
  direct connection is IPv6-only and unreachable from IPv4-only GitHub-hosted runners). It is the same
  script used locally and by `board:cloud:seed`; only the env differs.
- **CORS allows the github.io origin.** The functions read `BOARD_ALLOWED_ORIGINS`; the operator sets it
  to include `https://pgxsinkit.github.io` (a CORS origin is scheme+host — the `/demo` path is irrelevant)
  alongside the localhost dev origins, then redeploys secrets (`board:cloud:secrets`).
- **Disable open signups on the project.** The reset truncates all board **rows** regardless of author
  (so vandal-created issues/messages are always wiped) but only deletes the **fixture** auth identities.
  Disabling open email signups (Supabase → Auth) keeps the auth user set to exactly the seeded fixtures,
  so no stranger accounts accumulate between resets.

## Considered Options

- **A separate `demo.yml` Pages workflow with `keep_files: true`** — rejected. The docs deploy's
  `force_orphan` replaces the publish wholesale, so the demo would vanish on the next docs push unless the
  two workflows were carefully coordinated; co-publishing removes the race entirely.
- **A separate project-pages site/repo** — rejected. A second URL to publicise and a second deploy to
  maintain, for no isolation benefit the subpath doesn't already give.
- **Path routing + a `/demo/*` redirect shim in the root 404.html** — rejected. It couples the demo to
  Starlight's generated 404 (which can change shape on a docs upgrade); hash routing is self-contained.
- **No reset (or reset only on demand)** — rejected. A public writable board needs an automatic floor;
  `workflow_dispatch` is kept for on-demand resets on top of the nightly cron.
- **Read-only public demo** — rejected. Watching optimistic writes, membership fan-out, and conflict
  convergence is the whole point of the board; making it read-only guts the demo. Disposability is the
  better answer to abuse than removing the interactivity.

## Consequences

- The hosted demo cannot be CI-validated end-to-end (same as ADR-0008: it needs the live managed
  backend). The build is exercised by `demo:build`; the live page is operator-verified.
- The docs deploy now also builds the board, so a `packages/**` change can trigger a docs+demo deploy.
- The demo depends on the Electric subquery preview staying active on its Cloud source; if Electric ever
  rolls it back, members see the ADR-0008 `Subqueries are not supported` symptom again.
- Anyone forking the repo gets the docs deploy with the demo step skipped (variables unset) and the reset
  workflow skipped — no broken nightly runs, no broken Pages build.

## Realization

- **Routing:** `apps/board/src/router.tsx` selects `createHashHistory()` when `VITE_BOARD_HASH_ROUTING=1`.
- **Build:** `apps/board/vite.config.ts` reads `BOARD_DEMO_BASE` + `BOARD_DEMO_OUTDIR`; the root
  `demo:build` script sets base `/demo/`, output `apps/docs/dist/demo`, and the hash flag.
- **Deploy:** `.github/workflows/docs.yml` builds the demo into the docs `dist/` (gated on the public
  variables) so it co-deploys.
- **Reset:** `.github/workflows/demo-reset.yml` runs `seed:board` nightly + on demand against the cloud.
- **Operator setup** (variables, secrets, `BOARD_ALLOWED_ORIGINS`, disabling signups) is documented in
  the [hosted-demo guide](https://pgxsinkit.github.io/demo-and-harness/hosted-demo/) and the
  board-on-cloud runbook.
