# Pi integration

YuanpuAgent vendors the tracked package sources from the official Pi repository. The exact source revision is recorded in `docs/pi-upstream.json`.

## Ownership boundary

The following directories are upstream mirrors and must not contain Yuanpu-specific changes:

- `packages/agent`
- `packages/ai`
- `packages/chord`
- `packages/client`
- `packages/coding-agent`
- `packages/durable`
- `packages/evals`
- `packages/protocol`
- `packages/server`
- `packages/session-backends`
- `packages/telemetry`
- `packages/tui`

Yuanpu-specific behavior belongs in:

- `packages/yuanpu-protocol`
- `packages/yuanpu-runtime`

`apps/runtime` is only the composition and Node SEA entry point. Pi and MCP implementation files do not live under that app.

The full tracked Pi package set is retained even when a package is not in today's runtime dependency closure. This keeps future remote sessions, protocol transport, server, persistence, and evaluation work aligned with one upstream revision. The requested upstream `packages/storage` directory is absent from the recorded Pi commit; only ignored local build output existed under that name, so it is not mirrored.

## MCP surface

Pi keeps its local workspace tools. Yuanpu-managed external capabilities are exposed through exactly two Yuanpu tools:

- `search_capabilities`
- `execute_capability`

`packages/yuanpu-runtime/src/capabilities` owns capability discovery and execution. `packages/yuanpu-runtime/src/pi` adapts those two calls to Pi custom tools. Trusted Pi extensions can register tools separately; the two-tool interface is not a sandbox or a security boundary around Pi's local tools.

Execution re-resolves the capability, validates arguments against JSON Schema 2020-12 and consumes a host-signed, one-time authorization for sensitive calls. A managed Python MCP source is available for development and SEA smoke testing; frozen cross-platform Python artifacts and desktop installation remain follow-up work. See [Python capability design](python-capabilities.md) and [task registry](../.tasks/tasks.yaml).

## Updating Pi

Update and verify the clean sibling checkout, then synchronize its committed package snapshot:

```bash
git -C ../pi status --short
git -C ../pi pull --ff-only origin main
pnpm sync:pi
pnpm check
pnpm build:native
pnpm smoke:native
```

The sync command reads committed files from Pi `HEAD`, replaces only the named upstream mirror directories, refreshes Pi's shared TypeScript configuration and coding-agent bundle helper, and updates `docs/pi-upstream.json`. It never writes to the Pi checkout or any `packages/yuanpu-*` directory.

Pi intentionally excludes `packages/ai/src/providers/data` from Git. YuanpuAgent hydrates that upstream-generated model data on the first build and keeps it ignored; subsequent offline builds reuse the hydrated snapshot without rewriting Pi's tracked `models.generated.ts`.
