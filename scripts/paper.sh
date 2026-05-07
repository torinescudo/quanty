#!/usr/bin/env bash
# Start Freqtrade in paper-trading (dry-run) mode plus the FastAPI bridge.
#
# Usage:
#   ./scripts/paper.sh
#   STRATEGY=BollingerRevert ./scripts/paper.sh
#
# Freqtrade runs in the background on :8080 (REST + WS); the bridge runs
# in the foreground on :8000 and is what the dashboard talks to. Killing
# the foreground process (Ctrl-C) also stops freqtrade via the EXIT trap.
set -euo pipefail
cd "$(dirname "$0")/.."

STRATEGY="${STRATEGY:-SmaCross}"

# Spawn freqtrade in dry-run mode (config.json must have dry_run: true).
freqtrade trade --strategy "$STRATEGY" --userdir user_data &
FT_PID=$!
trap "kill $FT_PID 2>/dev/null || true" EXIT

# Give the freqtrade REST API a moment to come up before the bridge
# starts proxying calls to it.
sleep 5

uvicorn dashboard.app:app --host 127.0.0.1 --port 8000 --reload
