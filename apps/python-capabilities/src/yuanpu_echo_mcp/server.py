"""Minimal stdio MCP server used to verify Yuanpu's managed Python path."""

import asyncio

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


def main() -> None:
    """Run the local MCP server over stdio; stdout is reserved for MCP frames."""

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
