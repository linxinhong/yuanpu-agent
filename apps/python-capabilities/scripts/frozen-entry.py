"""PyInstaller entrypoint for the bundled Yuanpu MCP capability."""

import sys

from yuanpu_echo_mcp.server import main


if "--version" in sys.argv:
    print("0.1.0")
else:
    main()
