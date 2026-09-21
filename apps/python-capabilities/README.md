# Yuanpu Python capabilities

Development and frozen artifact commands are documented in
[`docs/python-artifact-delivery.md`](../../docs/python-artifact-delivery.md).

This app is the source for the managed Python MCP fixture. During development it runs with a
locked Python environment. Production packaging is owned by TASK-006 and must ship the interpreter
and dependencies together; target machines must not run pip.

```bash
uv sync --frozen
uv run python -m yuanpu_echo_mcp
```

The server uses stdio. Standard output is reserved for MCP protocol messages.
