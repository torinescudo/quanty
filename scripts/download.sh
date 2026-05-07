#!/usr/bin/env bash
# Download OHLCV data from Coinbase for the configured pair_whitelist.
#
# Usage:
#   ./scripts/download.sh                       # uses default TIMERANGE
#   TIMERANGE=20230101-20240101 ./scripts/download.sh
#
# The trailing dash in the default TIMERANGE means "until now".
set -euo pipefail
cd "$(dirname "$0")/.."

freqtrade download-data \
  --exchange coinbase \
  --pairs BTC/USD ETH/USD SOL/USD AVAX/USD LINK/USD DOT/USD ADA/USD MATIC/USD ARB/USD OP/USD UNI/USD ATOM/USD DOGE/USD LDO/USD \
  --timeframes 5m 1h 1d \
  --timerange "${TIMERANGE:-20220101-}" \
  --userdir user_data
