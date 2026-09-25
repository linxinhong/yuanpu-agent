# Yuanpu renderer theme

`tokens.css` defines the built-in light palette. `dark.css` supplies the built-in dark palette, and `mindlink.css` supplies the optional MindLink test theme. The test theme uses the MindLink seal and xuan-paper tile from the local `yuanpu2.0/hermes-agent` desktop project. Import the palette overrides after component CSS:

```ts
import '../themes/tokens.css';
import './muse-theme.css';
import '../themes/mindlink.css';
import '../themes/dark.css';
```

Use `var(--yp-…)` in renderer CSS. The renderer's Settings page saves the selected theme in local storage and restores it on launch.

Run `pnpm --filter @yuanpu-agent/app theme:export` to copy this disposable test theme into `~/.yuanpu/themes/mindlink-test/`. An optional path argument exports elsewhere. The directory contains `theme.json`, `tokens.css`, `theme.css`, `logo.png`, and `xuan-paper-tile.jpg`. The running renderer uses the bundled files in `apps/app/themes`; this exported snapshot is for inspection and future theme loading work. Delete the directory after testing without affecting the app.
