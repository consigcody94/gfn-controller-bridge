#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Starting PowerA Controller Bridge for GeForce NOW..."
python3 "$DIR/bridge_daemon.py" "$@"
