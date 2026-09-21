"""PyInstaller entrypoint for the bundled Yuanpu MCP capability."""

import sys

VERSION = "__YUANPU_CAPABILITY_VERSION__"

if "--version" in sys.argv:
    print(VERSION)
else:
    from yuanpu_echo_mcp.server import main

    main()
