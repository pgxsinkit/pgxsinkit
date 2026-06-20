# pgxsinkit brand kit

The logotype is the mark: **`pgxsinkit`**, all lowercase, set in monospace. It's
coloured in three parts — `pg` in Postgres blue, the `x` in Supabase green, and
`sinkit` in ink. The green `x` is the pivot: it reads as the sync / cross point
between Postgres and the edge ("pg × sink-it"), and it's the one place colour is
spent.

The palette deliberately pairs the two ecosystems this sits between: Postgres
blue and Supabase green.

This kit is built around the wordmark and a small **sync mark** — paired up/down
arrows (green up, blue down) standing for the offline-first round trip between
the edge and Postgres. The sync mark is the functional bug for favicons and
small slots; your elephant mascot is the pictorial mark for larger contexts —
see "Locking up with your mascot" below.

## Files

```
svg/        pgxsinkit-wordmark.svg, -dark        — the logotype (primary mark)
            pgxsinkit-symbol.svg, -dark, -mono   — the sync mark for small slots
avatar/     square sync-mark icons (SVG + PNG) for app icons / GitHub org
favicon/    favicon.svg, favicon.ico, sized PNGs, apple-touch-icon
opengraph/  pgxsinkit-og-a/b.svg + .png — 1200×630 social cards
banner/     pgxsinkit-readme-banner.svg + .png (+@2x)
animated/   pgxsinkit-hero.svg, -dark — wordmark assembles, x pops, rule sweeps
```

## Colour

| Token        | Hex       | Use                                            |
| ------------ | --------- | ---------------------------------------------- |
| ink          | `#11181C` | `sinkit`, wordmark base, dark backgrounds      |
| paper        | `#F8F9FA` | marks on dark surfaces                         |
| pg           | `#336791` | Postgres blue — `pg` on light backgrounds      |
| pg-light     | `#008BB9` | Postgres light blue — `pg` on dark backgrounds |
| green        | `#249361` | Supabase green (deep) — the `x` on light       |
| green-bright | `#3ECF8E` | Supabase green — the `x` on dark               |
| mute         | `#8A94A0` | secondary text / captions                      |

Postgres blue from the PostgreSQL palette (`#336791`); green from Supabase
(`#3ECF8E`). Tokens are in `brand-tokens.ts` and `brand-tokens.css`.

## Type

The wordmark is **JetBrains Mono SemiBold**, outlined to paths in the SVGs so it
renders identically without the font installed. Keep monospace for UI/body to
hold the register.

## Locking up with your mascot

The wordmark is the horizontal logo on its own. To pair it with your elephant:

- **Horizontal lockup:** mascot to the left of the wordmark. Set the mascot
  height to roughly 1.6× the wordmark's cap height, and put a gap of about one
  `x`-width between them. Vertically centre the mascot on the wordmark.
- **Stacked lockup:** mascot centred above the wordmark; gap ≈ 0.4× mascot height.
- **Clear space:** keep free space equal to the mascot's height around the whole
  lockup.
- A detailed mascot won't survive small sizes — use the sync mark (or favicon)
  below ~32px, and reserve the elephant for ≥48px.

## Usage

- **GitHub org avatar:** upload your mascot at large size, or `avatar/avatar-dark-512.png`
  for the sync-mark icon. GitHub masks the corners (full-bleed squares).
- **Favicon / docs head:**

  ```html
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  ```

- **Header logo:** the wordmark; switch to `-dark` via `prefers-color-scheme`.
- **OpenGraph (1200×630):** set `og:image` / `twitter:image` to an `opengraph/` card.
  Taglines — a: "Offline-first, RLS-aware Postgres sync";
  b: "Local-first sync for Supabase and Postgres".
- **README banner:** embed the PNG (GitHub sanitises SVG); the SVG is the source.
- **Animated hero:** CSS keyframes, respects `prefers-reduced-motion`, resting
  state is the finished logo. For the self-hosted docs site, not the README
  (GitHub strips SVG animation in markdown).

## Don't

- Recolour the `x` to anything but the Supabase green (deep on light, bright on dark).
- Recolour `pg` away from the Postgres blue.
- Capitalise any part of the name — it's `pgxsinkit`, always lowercase.
- Add shadows, gradients, or outlines to the marks.
- Re-typeset the wordmark in another font; use the outlined SVGs.
