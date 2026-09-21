"""PyInstaller entrypoint for the bundled Yuanpu MCP capability."""

import sys

from yuanpu_echo_mcp.server import main

VERSION = "__YUANPU_CAPABILITY_VERSION__"

if "--version" in sys.argv:
    print(VERSION)
else:
    main()
