#!/usr/bin/env bash
# Start Freqtrade in LIVE trading mode plus the FastAPI bridge.
#
# Real money on Coinbase Advanced. Requires:
#   - user_data/config.json with `"dry_run": false`
#   - exchange.key / exchange.secret populated (or via environment)
#
# Usage:
#   ./scripts/live.sh
#   STRATEGY=DonchianBreak ./scripts/live.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "WARNING: LIVE MODE — real money on Coinbase Advanced."
echo "         Verify user_data/config.json has dry_run: false and valid API keys."
read -r -p "Type 'I UNDERSTAND' to continue: " CONFIRM
if [ "$CONFIRM" != "I UNDERSTAND" ]; then
  echo "Aborted."
  exit 1
fi

STRATEGY="${STRATEGY:-SmaCross}"

freqtrade trade --strategy "$STRATEGY" --userdir user_data &
FT_PID=$!
trap "kill $FT_PID 2>/dev/null || true" EXIT

sleep 5

uvicorn dashboard.app:app --host 127.0.0.1 --port 8000
