# Renderer architecture

The renderer follows the Shell/Module boundary from the `xingding-one-cli` Web template, scaled to this desktop app.

- `src/main.tsx` mounts the root Router and QueryClient once.
- `src/shell/` owns global navigation, window layout, route selection, and recovery notices.
- `src/composition/catalog.tsx` is the fixed, reviewed catalog of built-in pages. Runtime or connector data cannot become an import path or executable UI contribution.
- `src/modules/` owns page behavior and its bridge calls. Work and Assistant share the chat implementation but retain separate Runtime conversations and draft state.
- `src/shared/` holds presentation code that carries no business or host state.
- `src/ui-registry.ts` provides ordered registration and reversible withdrawal for local contributions. Registration does not grant backend access; Runtime authorizes every request independently.
- `window.yuanpu` is the only renderer-to-host seam. Electron and Runtime implementation details stay behind the typed preload bridge.
- `themes/` owns the renderer's built-in color tokens and the opt-in MindLink test palette. Settings selects a bundled palette through `data-yuanpu-theme`; the app can export a disposable snapshot to `~/.yuanpu/themes/mindlink-test`.

When adding a built-in page, place its behavior in `modules/`, declare a fixed entry in `composition/catalog.tsx`, and add its route ID and icon. Keep one root Router, QueryClient, and theme. Use module-specific query keys and invalidate them after mutations. Page modules must not import `shell/` or `composition/` or install root providers.

The template's generated catalog, server-controlled registration, entitlement intersection, and rolling-release recovery are not required for the current local, built-in page set. Add them only if trusted separately shipped UI modules become a product requirement. Skill and MCP packages currently extend Agent capability, not renderer code.
