"""Minimal stdio MCP server used to verify Yuanpu's managed Python path."""

import asyncio
import os
import subprocess
import sys

from typing import Annotated, TypedDict

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field


class EchoResult(TypedDict):
    text: str
    length: int


mcp = FastMCP("yuanpu_echo_mcp", log_level="ERROR")


@mcp.tool(
    name="yuanpu_echo_text",
    annotations=ToolAnnotations(
        title="Echo text",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    ),
    structured_output=True,
)
async def yuanpu_echo_text(
    text: Annotated[
        str,
        Field(description="Text to return unchanged.", min_length=1, max_length=4096),
    ],
) -> EchoResult:
    """Return text unchanged with its Unicode code-point length."""

    return {"text": text, "length": len(text)}


@mcp.tool(
    name="yuanpu_diagnostic_error",
    annotations=ToolAnnotations(
        title="Return a diagnostic error",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    ),
)
async def yuanpu_diagnostic_error() -> str:
    """Return a controlled tool error for transport and UI diagnostics."""

    raise ValueError("Yuanpu managed Python diagnostic error")


@mcp.tool(
    name="yuanpu_wait",
    annotations=ToolAnnotations(
        title="Wait for cancellation diagnostics",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    ),
)
async def yuanpu_wait(
    seconds: Annotated[
        float,
        Field(description="Seconds to wait before returning.", ge=0.0, le=10.0),
    ] = 1.0,
) -> str:
    """Wait for a bounded interval so clients can verify cancellation."""

    await asyncio.sleep(seconds)
    return f"waited {seconds:g} seconds"


async def yuanpu_spawn_child() -> dict[str, int]:
    """Spawn a sleeping descendant used only to verify process-tree cleanup."""

    child = subprocess.Popen(  # noqa: S603 - fixed interpreter and fixed test program
        [sys.executable, "-c", "import time; time.sleep(60)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"pid": child.pid}


async def yuanpu_spawn_child_and_exit() -> dict[str, int]:
    """Spawn a descendant, then crash the MCP root for lifecycle testing."""

    result = await yuanpu_spawn_child()
    asyncio.get_running_loop().call_later(0.1, os._exit, 17)
    return result


if os.environ.get("YUANPU_MCP_TEST_FIXTURES") == "1":
    mcp.tool(
        name="yuanpu_spawn_child",
        annotations=ToolAnnotations(
            title="Spawn a lifecycle-test child",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
        structured_output=True,
    )(yuanpu_spawn_child)
    mcp.tool(
        name="yuanpu_spawn_child_and_exit",
        annotations=ToolAnnotations(
            title="Spawn a child and exit the test server",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        ),
        structured_output=True,
    )(yuanpu_spawn_child_and_exit)


def main() -> None:
    """Run the local MCP server over stdio; stdout is reserved for MCP frames."""

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
