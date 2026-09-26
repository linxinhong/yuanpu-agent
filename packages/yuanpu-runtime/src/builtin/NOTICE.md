# Upstream provenance

These are Yuanpu-native adaptations of the following MIT projects. They are
compiled into Runtime, not installed as Pi plugins. Upstream UI and runtime
contracts are not claimed to be drop-in compatible.

| Module | Reference | Version | Pinned commit |
| --- | --- | --- | --- |
| web | https://github.com/nicobailon/pi-web-access | 0.31.0 | 610a52033f1e9705c0023ff9e0fac399319310a3 |
| goals | https://github.com/tmonk/pi-goal-x | 0.31.9 | 2e8ad767a8341586e7c5776879cce3684ac95707 |
| workflows | https://github.com/QuintinShaw/pi-dynamic-workflows | 3.13.0 | 4b3027b39c7fa8a2f0c00e7652afef23a2fca426 |

Each module preserves its upstream LICENSE. Web access adapts the Exa MCP
request/response protocol and provider design; goal management adapts persistent
objectives, ordered tasks, bounded continuation and independent review;
workflows adapts the code-mode agent/parallel/pipeline/phase/checkpoint API and
journal replay design. Implementations and desktop integration are Yuanpu-owned.

See docs/builtin-agent-tools.md for the supported subset and operational limits.
