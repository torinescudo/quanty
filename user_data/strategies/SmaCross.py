"""SmaCross — trend-following strategy based on simple moving averages.

A long position is opened when the fast SMA crosses above the slow SMA
and closed when it crosses back below. Hyperopt-friendly: both window
lengths are exposed via ``IntParameter``.
"""

from __future__ import annotations

import pandas as pd
from freqtrade.strategy import IStrategy, IntParameter


class SmaCross(IStrategy):
    """Classic moving-average crossover."""

    # ------------------------------------------------------------------
    # Static configuration
    # ------------------------------------------------------------------
    INTERFACE_VERSION = 3

    timeframe = "1h"
    stoploss = -0.05
    minimal_roi = {"0": 0.04}

    # Order types: prefer maker (limit) on Coinbase Advanced, takers are
    # twice as expensive. Stop-losses fall back to market for safety.
    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False,
    }

    process_only_new_candles = True
    startup_candle_count: int = 200

    # ------------------------------------------------------------------
    # Hyperopt-tunable parameters
    # ------------------------------------------------------------------
    fast = IntParameter(5, 30, default=12, space="buy")
    slow = IntParameter(40, 200, default=50, space="buy")

    # ------------------------------------------------------------------
    # Indicators
    # ------------------------------------------------------------------
    def populate_indicators(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        fast = int(self.fast.value)
        slow = int(self.slow.value)
        dataframe["sma_fast"] = dataframe["close"].rolling(window=fast, min_periods=fast).mean()
        dataframe["sma_slow"] = dataframe["close"].rolling(window=slow, min_periods=slow).mean()
        return dataframe

    # ------------------------------------------------------------------
    # Entry / exit signals
    # ------------------------------------------------------------------
    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        prev_fast = dataframe["sma_fast"].shift(1)
        prev_slow = dataframe["sma_slow"].shift(1)

        cross_up = (
            (dataframe["sma_fast"] > dataframe["sma_slow"])
            & (prev_fast <= prev_slow)
            & dataframe["sma_fast"].notna()
            & dataframe["sma_slow"].notna()
        )

        dataframe.loc[cross_up, "enter_long"] = 1
        dataframe.loc[cross_up, "enter_tag"] = "sma_cross_up"
        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        prev_fast = dataframe["sma_fast"].shift(1)
        prev_slow = dataframe["sma_slow"].shift(1)

        cross_down = (
            (dataframe["sma_fast"] < dataframe["sma_slow"])
            & (prev_fast >= prev_slow)
            & dataframe["sma_fast"].notna()
            & dataframe["sma_slow"].notna()
        )

        dataframe.loc[cross_down, "exit_long"] = 1
        dataframe.loc[cross_down, "exit_tag"] = "sma_cross_down"
        return dataframe
