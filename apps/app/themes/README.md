# Yuanpu renderer theme

`tokens.css` defines the built-in light palette. `dark.css` supplies the built-in dark palette, and `mindlink.css` supplies the optional MindLink test theme. The test theme uses the MindLink seal and xuan-paper tile from the local `yuanpu2.0/hermes-agent` desktop project. Import the palette overrides after component CSS:

```ts
import '../themes/tokens.css';
import './muse-theme.css';
import '../themes/mindlink.css';
import '../themes/dark.css';
```

Use `var(--yp-…)` in renderer CSS. The renderer's Settings page saves the selected theme in local storage and restores it on launch.

## Typography tokens

`tokens.css` also declares the palette-independent typography defaults shared by all three themes: `--yp-font-family` (UI and content font stack), `--yp-font-scale-ui` (interface text scale factor applied to the root font size), and `--yp-font-size-content` (chat content text size). Component CSS must consume these tokens instead of hardcoding `px` font sizes; interface chrome text uses `rem` so it follows the root scale, while chat content rules derive from `--yp-font-size-content` with `calc()` ratios so content and interface scale independently. The Settings page persists the user's font preference in local storage and re-applies it on launch as inline custom properties on `<html>`, which override these defaults for all themes. `theme-contract.test.mjs` guards both the token declarations and the no-hardcoded-px rule.

Run `pnpm --filter @yuanpu-agent/app theme:export` to copy this disposable test theme into `~/.yuanpu/themes/mindlink-test/`. An optional path argument exports elsewhere. The directory contains `theme.json`, `tokens.css`, `theme.css`, `logo.png`, and `xuan-paper-tile.jpg`. The running renderer uses the bundled files in `apps/app/themes`; this exported snapshot is for inspection and future theme loading work. Delete the directory after testing without affecting the app.
