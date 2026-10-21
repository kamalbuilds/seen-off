# Outbox design system

Theme: Hallmark catalog theme Grid (Swiss neo-grotesque, exposed hairline column grid, one grotesk, one signal ink).
Signal ink: yellow, logistics register. Yellow is surface-only: it floods fills and bars and always carries ink text.
Screen kind: one app screen, a seller console. Macrostructure: index rail plus detail column on the ruled grid.

## Tokens

| Token | Value |
|---|---|
| --paper | oklch(99% 0.003 255) |
| --paper-2 | oklch(97.2% 0.004 255) |
| --paper-3 | oklch(94.5% 0.005 255) |
| --ink | oklch(16% 0.010 255) |
| --muted | oklch(44% 0.012 255) |
| --rule | oklch(88% 0.006 255) |
| --accent | oklch(82% 0.17 95) |
| --accent-ink | var(--ink) |
| --danger | none: verdicts are carried by words, never by a second colour |
| radius | 0 everywhere |
| shadow | none |
| font | Archivo 400 500 600 700 800, one family. Display is 800 lowercase, tracking -0.045em, line-height 0.9 |

## Type scale

12 label (600, uppercase, +0.09em) / 14 small / 16 body / 20 row title / 28 section / clamp(44px, 8vw, 104px) verdict plate.

## Spacing

4 8 12 16 24 32 48 64. Hairlines and 2px ink rules do all structure. No cards.

## Provenance badges

LIVE: solid ink, paper text. REPLAY: 1px ink outline on paper. SIMULATED: yellow fill, ink text, dashed ink outline.
Every external input shows one. A verdict shows the least live of its inputs.

## Motion

Hover shifts a row to --paper-2 over 0.18s. Nothing else moves. prefers-reduced-motion removes transitions.
