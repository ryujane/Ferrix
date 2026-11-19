# Bundled workspace assets

Downloaded on 2026-11-11. The workspace loads these local assets; there are no
runtime CDN or Google Fonts requests.

- Icons: [Lucide 0.468.0](https://github.com/lucide-icons/lucide/tree/0.468.0/icons).
  Source: `https://raw.githubusercontent.com/lucide-icons/lucide/0.468.0/icons/{name}.svg`.
  The upstream [license](icons/LICENSE) is retained.
- Inter: [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/inter),
  `Inter[opsz,wght].ttf`, saved as `fonts/Inter.ttf`.
  [SIL Open Font License](fonts/Inter-OFL.txt).
- JetBrains Mono: [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono),
  `JetBrainsMono[wght].ttf`, saved as `fonts/JetBrainsMono.ttf`.
  [SIL Open Font License](fonts/JetBrainsMono-OFL.txt).

The downloaded Stitch reference image and HTML are separately retained under
`docs/design/stitch/redis-json-folding/`. They are design references and are not
loaded by the application.
