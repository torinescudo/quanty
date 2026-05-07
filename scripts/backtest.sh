#!/usr/bin/env bash
# Run a backtest on a single strategy.
#
# Usage:
#   ./scripts/backtest.sh STRATEGY [TIMERANGE]
#
# Example:
#   ./scripts/backtest.sh SmaCross 20230101-20240101
set -euo pipefail
cd "$(dirname "$0")/.."

STRATEGY="${1:?Usage: $0 STRATEGY [TIMERANGE]}"
TIMERANGE="${2:-20230101-20240101}"

freqtrade backtesting \
  --strategy "$STRATEGY" \
  --timerange "$TIMERANGE" \
  --export trades \
  --userdir user_data
