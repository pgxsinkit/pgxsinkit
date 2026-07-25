# Mobile support — apps/board

The board is the toolkit's public-facing exerciser ([ADR-0009 hosted public
demo](./adr/0009-hosted-public-demo.md)): engineers evaluating pgxsinkit will open
the demo link on a phone, and a broken first paint reads as a toolkit defect. This
doc records the supported-browser matrix, the mobile design decisions and their
rationale, the verification lanes, and the staged work. It is reference
documentation, not an ADR — every decision here is cheaply reversible.

## Supported matrix

**Chrome for Android, Safari on iOS, and Firefox for Android — current stable
versions.** All three support `SharedWorker`, so **there is no separate mobile
engine mode**: the per-store SharedWorker topology (ADR-0032 S3) carries over from
desktop unchanged.

Browser facts, from primary sources:

- **Chrome for Android**: `SharedWorker` shipped in **Chrome 148**, alongside the
  `extendedLifetime` option the board already relies on
  ([Chrome 148 beta announcement](https://developer.chrome.com/blog/chrome-148-beta),
  [release notes](https://developer.chrome.com/release-notes/148)). The
  store-registry's "Chromium 148+" `extendedLifetime` note corroborates in-repo.
- **Safari on iOS**: `SharedWorker` restored in Safari 16.
- **Firefox for Android**: long-standing `SharedWorker` support.

> **Citation hygiene:** caniuse's mobile rows for `SharedWorker` are wrong (it
> claims Chrome Android 150 and a recent Firefox Android version, contradicting
> the Chrome announcement above). Cite the vendor sources, not caniuse, for this
> feature.

### Out of scope

- **Browsers without `SharedWorker`** (notably Samsung Internet). The in-process
  tab-side PGlite fallback remains in the code and keeps whatever behavior it has,
  but it is **not a supported mobile mode**: no mobile work targets it, no lane
  asserts it, no UX messaging references it. (In main-thread fallback the OPFS
  backend is structurally unavailable anyway — `FileSystemSyncAccessHandle` is
  dedicated-worker-only.)
- **Touch drag** — deliberately not built; see below.

## Design decisions

One shared touch heuristic gates every touch-specific behavior:
`(hover: none) and (pointer: coarse)` — capability-based, never viewport-width,
so a narrow desktop window keeps desktop behavior. Desktop UX is unchanged by
everything below.

### Shell

- **Navbar**: the canonical Mantine recipe — `collapsed: { mobile: !opened }` with
  a Burger in the header, full-width overlay below the breakpoint, auto-close on
  navigation. The team list stays verbatim: the sidebar IS the read-path scoping
  made visible, so it must not be abbreviated into a dropdown.
- **Header (mobile)**: Burger + brand + SyncBadge + "Inspector (n)". The Offline
  switch demotes into the Inspector drawer (which already contains its own copy) —
  glanceables stay at zero taps, controls nest at one. The identity + sign-out move
  to the bottom of the navbar overlay. MutationBadge is dropped on mobile: the
  Inspector button's owed count already carries it.

### Board

- **Columns**: viewport-relative (~80vw) snap-scrolled columns
  (`scroll-snap-type: x mandatory`) with the next column peeking at the edge as the
  swipe affordance. Pure CSS on the existing structure; kanban stays kanban, and a
  remote cross-column move stays at least partially visible.
- **No touch drag.** Drag's only capability is changing Status (columns are status
  filters; there is no within-column ordering), and the actions menu is already its
  documented twin. Cross-column touch drag under snap scrolling requires
  auto-scrolling the snap container mid-drag — the most fragile corner of touch
  DnD — and the resulting code would be the largest non-toolkit code in a demo
  that exists to be read as toolkit usage. Instead, on touch devices **tapping a
  card opens a bottom sheet** (Drawer, position bottom) with flat Status /
  Assignee / Move-to-team sections reusing `IssueActions` verbatim. Flat, because
  Mantine `Menu.Sub` opens on hover — nested submenus are precisely what fails on
  touch.

### Chat

- The 200px channel rail carries exactly two entries on a team page (global + own
  team), so on mobile it becomes a full-width SegmentedControl above the thread —
  the same idiom as the Board/Chat switch in `TeamPageShell`. Thread + composer
  take the full width; thread height moves to `dvh`-based sizing so the soft
  keyboard doesn't eat the composer. Enter-to-send already matches mobile chat
  convention.

### Sync Inspector

- Full-width drawer below `sm`; both diagnostic tables wrapped in
  `Table.ScrollContainer` with a `minWidth` so they scroll horizontally rather
  than crush. No columns are dropped on mobile — it is an inspection surface, and
  scrolling truthful data beats hiding it.

### Database route

- On touch devices the CodeMirror REPL is replaced by a short notice ("the
  interactive SQL REPL needs a desktop browser"); `SchemaOverview` stays, with the
  same scroll-container treatment. The nav entry stays. Gated on the touch
  heuristic, not width: the REPL's problem is typing SQL on a soft keyboard, not
  pixels.

### Remaining routes

Login, Members, and `/all` need only width-audit fixes; `/all` inherits the column
and bottom-sheet decisions through `BoardColumns`.

## Verification

- **CI (Playwright)**: two added projects — `chromium-mobile` (Pixel-class
  descriptor: real Chromium, `isMobile` + touch) and `webkit-mobile` (iPhone
  descriptor: desktop WebKit approximating iOS Safari). **One dedicated mobile
  smoke spec runs in these projects, and nothing else does** — the engine/worker
  suites would re-test the same engines for no new information. The smoke: login →
  burger nav → snap columns render → tap card → bottom sheet → change status →
  Inspector: offline → write queues pending → online → converges → chat via
  SegmentedControl → send message → database route shows notice + schema.
- **Emulation honesty**: Playwright's "mobile Safari" is desktop WebKit with an
  iPhone viewport/UA. Real iOS storage and eviction behavior only shows up on a
  physical device.
- **Lane findings (implemented — `tests/e2e/board-mobile.e2e.test.ts`, projects
  `chromium-mobile` = Pixel 7 and `webkit-mobile` = iPhone 17)**: both emulations
  DO match the board's `(hover: none) and (pointer: coarse)` gate, and the spec
  asserts that by name so an emulation regression fails loudly instead of
  silently downgrading the touch assertions into a desktop run. Second finding:
  **Playwright's WebKitGTK build has no OPFS at all** (`navigator.storage.getDirectory`
  is undefined), so the webkit-mobile project exercises the declared-`idbfs` path
  — one more reason its storage values say nothing about real iOS Safari, whose
  expected shared-worker OPFS grant only hardware can confirm.
- **Manual checklist** (Firefox Android — Playwright's Firefox has no
  `isMobile`/touch emulation — and real-device iOS): the same smoke flows,
  walked by hand, on current stable, before a release that touches the board.

## Staging

**Stage A — layout and interaction** (all of "Design decisions" above): the
navbar/header shell, snap columns, bottom sheet, chat SegmentedControl, inspector
and database treatments, remaining-route audit.

**Stage B — first-class assurance**: the CI lane and manual checklist, plus two
open investigation items:

1. Confirm which storage backend actually engages on each matrix browser on real
   devices — `FileSystemSyncAccessHandle` is dedicated-worker-only, so the OPFS
   backend's behavior under the per-store SharedWorker topology needs verifying
   per browser, not assuming.
2. Confirm the login page's storage-preference controls (durability + backend)
   tell the truth on mobile — an offered preference that silently can't engage on
   the device is a falsehood in the demo's own UI.

### Device-verified results

**Chrome for Android 150 (Android 16, real device) — both items answered; full
desktop-Chromium parity.** Method: the local Vite client against the cloud
backend, driven over adb (`adb reverse` for the dev server, DevTools protocol for
the reads — driver kept at `tmp/agents/cdp-eval.ts`), reading each boot's
`__boardBootReport`.

- **Default (`opfs`) preference**: `mode: "worker"`, `engineHome:
"elected-worker"` — the placement probe refuses sync-access handles in the
  SharedWorker scope and elects a tab-spawned dedicated worker, exactly as on
  desktop Chromium. The opfs-repacked VFS verifiably engaged: the store directory
  under `pgxsinkit/stores/` carries the ADR-0048 whole-directory layout
  (`arena.bin`, `metadata-a/b.bin`, `activation.bin`), and the only IndexedDB
  database is the store-meta binding.
- **Forced `idbfs` preference**: `storageBackend: "idbfs"`, `engineHome:
"shared-worker"` — the forced engine runs in the SharedWorker with no
  probe/election, as declared. Applied and reverted through the login page's real
  Apply-&-reload flow, which behaved correctly both ways.
- **Item 2 verdict**: the login copy is already truthful ("…probe for an Origin
  Private File System home…, falling back to IndexedDB where the browser
  cannot"), and on this browser both offered lanes genuinely engage. The
  _post-boot_ half is now shipped too: the Sync Inspector's **Storage readout**
  shows the engaged engine home, backend, and boot kind/duration straight off
  each boot's report. Where the report omits `storageBackend` (the board's
  BYO-PGlite mint — the client can't derive a backend it didn't mint), the
  readout derives `opfs-repacked` from the engine home and labels it `(derived)`:
  an elected home exists only to hold the OPFS handles, and a shared-worker home
  without a declared backend means the probe granted them there. Deriving it
  properly for BYO mints remains a toolkit-side nicety.

**Still to verify on hardware**: Safari on iOS (WebKit is expected to _grant_
sync-access handles in the SharedWorker itself — `engineHome: "shared-worker"`
with the opfs backend — the inverse placement of Chromium) and Firefox for
Android (expected to match Chromium's elected-worker placement; its DevTools
lane is manual).
