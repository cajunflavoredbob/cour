# Handoff addendum: App mark — "Dotted answer" (adopted)

Replaces the reely card-stack mark everywhere: app icon, favicon, PWA icons, auth header, any splash. See `Cour Mark.html` frame "Mark I4: Dotted answer" for the visual reference at 120/64/40px.

## Concept
Two arcs in conversation. The large ivory arc is the letter **c** (cour); the answer comes back as **four dots** — the four seasons — tracing the path of a smaller facing arc. Static: never needs a seasonal update. All four season colors present = belongs to no single season, even as the in-app accent rotates.

## Geometry (canonical SVG)
72×72 viewBox. Large arc: circle center (34,36) r=27, drawn from (52,14) to (52,58) opening right. Dots: r=4.5 on the path of a facing arc (center ~(43,36) r=13), season order spring→winter top-to-bottom.

```svg
<svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label="cour">
  <path d="M 52 14 A 27 27 0 1 0 52 58"
        fill="none" stroke="oklch(0.97 0.008 85)"
        stroke-width="7" stroke-linecap="round"/>
  <circle cx="50"   cy="25"   r="4.5" fill="oklch(0.75 0.12 350)"/> <!-- spring -->
  <circle cx="56.5" cy="31.5" r="4.5" fill="oklch(0.64 0.15 278)"/> <!-- summer -->
  <circle cx="56.5" cy="40.5" r="4.5" fill="oklch(0.68 0.15 55)"/>  <!-- fall -->
  <circle cx="50"   cy="47"   r="4.5" fill="oklch(0.78 0.09 220)"/> <!-- winter -->
</svg>
```

## Size behavior (important)
- **≥48px rendered size:** full mark (arc + four dots) as above. Scale stroke-width up modestly at display sizes if it looks thin (8 at ~64px is right).
- **<48px (favicon, tab, 40px chrome):** the dots fuse into a single gray arc — swap to this small variant; do NOT just scale the dots down:

```svg
<svg width="40" height="40" viewBox="0 0 72 72" role="img" aria-label="cour">
  <path d="M 52 14 A 27 27 0 1 0 52 58"
        fill="none" stroke="oklch(0.97 0.008 85)"
        stroke-width="10" stroke-linecap="round"/>
  <path d="M 50 26 A 13 13 0 1 1 50 46"
        fill="none" stroke="oklch(0.55 0.012 85)"
        stroke-width="10" stroke-linecap="round"/>
</svg>
```

## Colors
- Arc ivory: `oklch(0.97 0.008 85)` (= `--text-0`)
- Small-variant answer arc: `oklch(0.55 0.012 85)`
- Dots (fixed, never re-tinted by the current season):
  spring `oklch(0.75 0.12 350)` · summer `oklch(0.64 0.15 278)` · fall `oklch(0.68 0.15 55)` · winter `oklch(0.78 0.09 220)`
- One-color contexts (print, monochrome favicon): use the small variant with both strokes in a single color.

## Dual-surface variant (adopted 1.3.4)
The bare mark's ivory arc vanishes on light surfaces. Wherever the mark
renders WITHOUT the tile — in-app chrome, the tab favicon, docs/README
lockups, external icons (Docker UIs, dashboards) — it carries a
translucent warm-dark **contour** so one transparent file reads on any
background:

- Arc: under-stroke `oklch(0.24 0.014 85 / 0.55)` at arc-width + 3
  (11 under the full mark's 8; 13 under the small variant's 10),
  drawn beneath the ivory/gray stroke, same path and linecap.
- Small variant: BOTH arcs get the under-stroke.
- Dots: hairline `oklch(0.24 0.014 85 / 0.35)` at stroke-width 1.

On dark surfaces the contour reads as subtle edge weight; on light ones
it becomes the mark's outline. `CourMark.tsx`, `static/icons/icon.svg`,
`favicon.ico`/`icon-32.png`, `docs/icon.svg` + its PNG renders, and the
`docs/logo-*.svg` lockup marks all carry it — the lockups flip only the
WORDTYPE ink per theme; the mark itself is identical everywhere.

## Icon tile
For app-icon duty — contexts that require an opaque background: the PWA
`icon-192/512`, `icon-maskable-*` (maskable REQUIRES full bleed), and
`apple-touch-icon` (iOS composites transparency onto arbitrary fills) —
set the mark on a rounded square of `--bg-2` `oklch(0.24 0.014 85)` with
subtle 1px `oklch(1 0 0 / 0.16)` inner border; mark occupies ~60% of
tile width, optically centered (nudge left ~2% because the c opens
right). Tile radius ≈ 23% of tile size (28px at 120px). The tile mark
needs no contour — the tile IS its background.

## Lockup
Horizontal lockup = tile + wordmark `cour` in Shippori Mincho 600 (see `Cour Mark.html` "Lockups" frame; drop I4 into the tile slot). The small in-app season chip (夏 etc.) is unchanged and remains separate from the mark.

## PNG/ICO export note
oklch() in SVG rasterizes fine in modern browsers; if the icon build pipeline chokes, sRGB fallbacks:
ivory `#F5F2ED` · gray `#8A857D` · spring `#E88FB4` · summer `#7A7EE3` · fall `#D98A47` · winter `#8FC3E8` (approximations — verify against the oklch originals).
