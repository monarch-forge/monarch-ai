# Monarch design direction: "calm study"

Monarch used to look like a dense control room: sharp corner brackets, panel codes such as `CFG.21`,
uppercase mono labels everywhere, outlines on every box, telemetry on the home screen. It worked, but it
felt crowded. The new direction keeps the identity (near-black, one red accent, Geist) and makes it feel
like a quiet, well-lit study: fewer things on screen, more air, softer edges, and one obvious thing to do.

## Principles

1. **One focus per screen.** Each page has one primary area and at most one supporting column. Secondary
   information goes behind a disclosure ("More", a drawer, a collapsed section, a hover) instead of
   competing for attention.
2. **Space instead of lines.** Separate groups with spacing and a slightly lighter surface, not borders.
   Borders are for inputs, and for selected or focused states.
3. **Quiet chrome, loud content.** Titles are sentence case, in sans, set by weight. Mono and uppercase
   are only for tiny metadata: timestamps, ids, counts. No panel codes, no corner brackets, and no
   blueprint grid (if any background texture stays, it is barely visible).
4. **Red means "act" or "attention", and is rare.** At most one red primary button per view, plus red
   for real alerts such as errors, an approval waiting or a recording mic. Everything else uses the greys.
5. **Progressive disclosure.** Show the 20% people use daily; tuck advanced settings, raw ids, logs and
   telemetry behind "Advanced", "Details" or a hover.
6. **Gentle motion.** Fades and soft transitions of 120–180 ms. Nothing blinks unless something is live
   (recording, an approval waiting).
7. **Friendly copy.** Short, warm, human: "Nothing waiting on you", not "NO ITEMS FLAGGED".

## Tokens (CSS variables in apps/ui/src/index.css)

| Token | Value | Use |
|---|---|---|
| `--bg-primary` | `#121213` | app background |
| `--bg-surface` | `#1a1a1c` | cards, sidebars |
| `--bg-raised` | `#202023` | hover, selected rows, inputs |
| `--bg-subtle` | `#262629` | pressed, chips |
| `--border-default` | `#2c2c30` | inputs, rare dividers |
| text | `#f4f4f6` / `#a3a3a9` / `#6a6a70` | primary / secondary / muted (muted is a touch lighter than before so it stays readable) |
| accent | `#d71921` (hover `#b8141b`, dim `rgb(215 25 33 / .12)`) | primary action, alerts |
| radius | 6px controls, 10px cards, 14px modals and large surfaces | |
| spacing | 4 / 8 / 12 / 16 / 24 / 32 | cards get 16–20px padding; pages get a 24px gutter on desktop and 16px on narrow screens |
| type | body 14px/1.55; small 12.5px; meta 11px; card title 14.5px semibold; page title 18–20px semibold | |
| shadow | none at rest; modals and popovers `0 12px 32px rgb(0 0 0 / .45)` | |

## Primitives (apps/ui/src/components/ui.tsx), keeping their prop APIs

- `Panel`: a soft card (surface background, 10px radius, no outline, no corner brackets). `code` props
  are accepted but ignored (no longer rendered). The title is sentence-case sans; `right` holds quiet
  actions.
- `Tag`: a small pill (999px radius, 11px, subtle background). Tones are tinted text with a faint
  background, never red outlines.
- `Btn`:
  - primary: red fill, 6px radius;
  - ghost/outline: grey;
  - sentence-case labels; no uppercase tracking.
- `Empty`: a friendly sentence in secondary text, not uppercase mono.

## Page layout

- The top bar is slim: brand, the nav (icons with a tooltip; labels on wide screens), the model badge, the
  bell and the clock. No status line under the brand.
- The footer status bar is hidden by default (the core-offline state shows as a small toast or banner instead).
- Lists use comfortable rows: 10–12px vertical padding, hover `--bg-raised`, the selected row gets the
  raised background plus a 2px red bar on the left (the only red in lists).
- Respect narrow widths: stack columns below `lg`, no horizontal page scroll; scrollbars stay hidden.
