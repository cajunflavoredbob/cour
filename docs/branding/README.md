# cour branding

The authoritative design reference is **cour-style-guide.html** (open in
a browser): principles, tokens, typography, the mark, components,
spacing, motion, voice. Where anything else disagrees with it, the
guide wins -- except where the owner has explicitly overridden it since
(e.g. media rotation runs 7s with a progress bar, not 3s; the global
sound toggle was rescoped to autoplay-only).

- `APP_MARK.md` -- the "Dotted answer" mark: canonical SVG + size rules.
  Implemented in `web/app/src/components/atoms/CourMark.tsx` and the
  static icons under `web/app/static/icons/`.
- `AUTH_BACKGROUND.md` -- the kanji-watermark auth background.
  Implemented in `web/app/src/components/atoms/AuthBackground.tsx`.

reely's logo assets were retired with the 0.13.1 mark.
