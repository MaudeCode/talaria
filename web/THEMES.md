# Talaria Web themes

Appearance has two independent axes:

- **Theme**: the mode, `Light`, `Dark` (default), or `System`. It toggles the
  `.dark` class on `<html>`; System follows `prefers-color-scheme` live.
- **Skin**: a named palette. It overrides any subset of the design tokens for
  both modes and is applied as `data-skin="<key>"` on `<html>` (the `default`
  skin clears the attribute).

They combine, so a skin keeps its look in both modes.

---

## Switching appearance

**Settings → Appearance** has the Theme toggle, the Skin grid (built-in skins
plus any extension skins), and the font size. Changes apply instantly.

**Slash command:** `/theme light|dark|system` switches the theme and leaves
the skin alone.

**Persistence:** choices live in `localStorage` (`hermes-theme`,
`hermes-skin`, `hermes-font-size`). `theme/prepaint.js` is a blocking `<head>`
script that applies the theme and skin before first paint; `theme/boot.ts`
then validates and applies the full appearance.

---

## Built-in skins

The built-in skins are the `SKINS` array in
`packages/frontend/src/theme/skins.ts`: Codex, Terracotta, Default, Ares,
Mono, Graphite, GitHub, Slate, Poseidon, Sisyphus, Charizard, Sienna,
Catppuccin, Hepburn, Nous, Geist Contrast, Neon, Neon Soft, Neon Paint, Zeus,
and Verdigris. The picker, `SkinSchema`, and the rendered stylesheet all derive
from that array.

The brandmark uses Talaria's winged sandal paths in
`static/brand/brandmark.svg`. The title bar and shared-chat header colour it
with a CSS mask from the active skin's `--accent`; the login page uses its own
gold accent. The main app favicon follows the resolved light/dark theme,
including system changes and extension skins. The standalone SVG favicon
follows the browser's colour scheme. Install and notification icons use a
fixed dark tile; install icons include maskable safe-area padding.

After editing the source SVG, regenerate the derived SVG, PNG and ICO assets
with `uv run --no-project --with playwright python ../scripts/generate-brand-icons.py`
(from `web/`). It renders with an installed Playwright Chromium and is an
asset maintenance command, not a build step.

---

## How skins work

All tokens live in `packages/frontend/src/theme/skins.ts`:

- `TOKEN_NAMES` is the vocabulary: palette tokens (`--bg`, `--surface`,
  `--text`, `--accent`, ...), semantic roles (`--accent-fg`, `--link-color`,
  ...), and component knobs (`--composer-bg`, `--session-active-fg`, ...).
- `BASE` holds every token's light value plus the dark overrides.
- Each `SkinSpec` in `SKINS` overrides a subset in `tokens` (both modes) and
  `dark` (dark mode only). `traits` opts into structural variants
  (`square-controls`, `card-sessions`) whose rules live in `theme/theme.css`.

`renderThemeCss` turns this into the `virtual:hermes-theme.css` stylesheet the
Vite plugin serves, and `theme/tailwind.css` maps the same names into
utilities. Component CSS in `theme/components/` reads tokens only; no rule
names a skin.

### Adding a built-in skin

1. Append a `SkinSpec` to `SKINS` in `skins.ts` with a `key`, a display
   `name`, up to three swatch `colors`, and the `tokens`/`dark` overrides.
2. Check both modes on desktop and mobile. A skin that works in Dark can be
   illegible in Light; keep `--accent-text` readable on `--accent-bg`.
3. `skins.test.ts` covers the rendered stylesheet; run the frontend unit tests.

### Extension skins

An extension can ship a skin without changing Talaria Web: declare a `theme`
block in its manifest (see `docs/architecture/extension-protocol-v1.md`). The
host applies the allowlisted tokens as CSS custom properties when the user
selects the skin; no stylesheet or script is injected. A manifest skin may set
`scheme: "light"` or `scheme: "dark"`; while it is selected the host applies
that mode without changing the saved Theme preference.

---

## Font size

Settings → Appearance offers `Small`, `Default`, `Large`, and `XLarge`. The
choice is applied as `data-font-size` on `<html>` and scales the root and
message font sizes (`theme/theme.css`).

---

## Typography tokens

- `--font-ui`: interface chrome, controls, labels, and ordinary UI text
- `--font-conversation`: user and assistant message prose
- `--font-mono`: code, tool details, logs, identifiers, and terminal text

`--font-conversation` defaults to `var(--font-ui)`; override it in a skin only
when a different reading face is needed. Prefer these tokens over
selector-level font declarations.
