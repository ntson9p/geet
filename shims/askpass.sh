#!/bin/sh
# Geet askpass launcher. VSCODE_GEET_NODE points at the VS Code Electron
# binary; ELECTRON_RUN_AS_NODE=1 (set by the executor's spawn env) makes it
# behave as plain node. Used on every platform — git invokes askpass through
# its own sh, including Git for Windows.
ELECTRON_RUN_AS_NODE=1 exec "$VSCODE_GEET_NODE" "$(dirname "$0")/askpass.cjs" "$@"
