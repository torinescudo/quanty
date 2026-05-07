#!/usr/bin/env bash
# Run hyperopt to search optimal parameters for a strategy.
#
# Usage:
#   ./scripts/hyperopt.sh STRATEGY [EPOCHS] [TIMERANGE]
#
# Example:
#   ./scripts/hyperopt.sh SmaCross 500 20220101-20230101
#
# Hyperopt is overfitting industrialized — keep splits strict and validate
# out-of-sample with backtest.sh before promoting any params to live.
set -euo pipefail
cd "$(dirname "$0")/.."

STRATEGY="${1:?Usage: $0 STRATEGY [EPOCHS] [TIMERANGE]}"
EPOCHS="${2:-300}"
TIMERANGE="${3:-20220101-20230101}"

freqtrade hyperopt \
  --strategy "$STRATEGY" \
  --hyperopt-loss SharpeHyperOptLoss \
  --spaces buy sell roi stoploss \
  --epochs "$EPOCHS" \
  --timerange "$TIMERANGE" \
  --userdir user_data
