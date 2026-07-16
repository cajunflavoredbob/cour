# Handoff addendum: Auth background — "Kanji watermark" (adopted)

Replaces the leftover reely warm pink/amber radial glow on auth screens (login, create-admin first run). See `Anime Picker Explorations.html` section 08, frame "Auth BG C: Kanji watermark".

## What it is
A huge season kanji in Shippori Mincho, tinted with the seasonal accent at very low opacity, bleeding off the top-right corner — backed by a faint accent bloom. The base surface stays flat `--bg-0`.

## Implementation
Background layer behind the auth form (absolutely positioned, `overflow: hidden` on the screen container, `pointer-events: none`):

```html
<div class="auth-bg" aria-hidden="true">
  <span class="auth-kanji">夏</span>
</div>
```

```css
.auth-bg {
  position: absolute; inset: 0;
  overflow: hidden; pointer-events: none;
  /* faint bloom behind the glyph */
  background: radial-gradient(70% 50% at 85% 0%,
    oklch(0.64 0.15 278 / 0.08) 0%, transparent 60%);
}
.auth-kanji {
  position: absolute; top: -60px; right: -85px;
  font-family: "Shippori Mincho", serif;
  font-weight: 500;
  font-size: 460px; line-height: 1;
  color: oklch(0.64 0.15 278 / 0.07);
  user-select: none;
}
```

(Values tuned for a 390px-wide viewport; scale font-size/offsets proportionally for larger screens. The old reely gradient blobs are deleted, not layered under.)

## Rules
- **Opacity is the whole design.** Glyph ≤ 8% (0.07 shipped), bloom ≤ 8%. Any stronger and it fights the form fields.
- **Rotates per cour**, glyph + accent color together:
  - Spring: 春 · `oklch(0.75 0.12 350)` (sakura)
  - Summer: 夏 · `oklch(0.64 0.15 278)` (indigo) ← current
  - Fall: 秋 · `oklch(0.68 0.15 55)` (persimmon)
  - Winter: 冬 · `oklch(0.78 0.09 220)` (ice)
- Glyph bleeds off top-right; never fully inside the frame, never behind the headline/fields' left column.
- The small season chip next to the wordmark stays — the watermark is set dressing, the chip is the label.
- Scope: auth/first-run screens. Don't apply behind the deck (poster art owns those screens); the seasonal review screen MAY adopt it later — not decided.
