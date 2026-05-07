"""DonchianBreak — channel-breakout strategy.

Goes long when price breaks above the rolling N-bar high (Donchian upper)
and exits when it breaks back below the rolling N-bar low (Donchian lower).
"""

from __future__ import annotations

import pandas as pd
from freqtrade.strategy import IStrategy, IntParameter


class DonchianBreak(IStrategy):
    """Donchian channel breakout."""

    INTERFACE_VERSION = 3

    timeframe = "1h"
    stoploss = -0.06
    # Take 10 % quickly if we get a clean break, otherwise let the trade
    # run for up to a day before forcing an exit.
    minimal_roi = {"0": 0.10, "1440": 0}

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False,
    }

    process_only_new_candles = True
    startup_candle_count: int = 200

    # Hyperopt-tunable parameters.
    dc_lookback = IntParameter(20, 100, default=55, space="buy")

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        lookback = int(self.dc_lookback.value)

        # Use the previous N bars (shift(1)) so the current bar's high/low
        # cannot leak into the channel — otherwise a new high would always
        # equal the upper band and never break it.
        prior_high = dataframe["high"].shift(1).rolling(window=lookback, min_periods=lookback).max()
        prior_low = dataframe["low"].shift(1).rolling(window=lookback, min_periods=lookback).min()

        dataframe["dc_upper"] = prior_high
        dataframe["dc_lower"] = prior_low
        dataframe["dc_mid"] = (prior_high + prior_low) / 2.0
        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        breakout = (
            (dataframe["close"] > dataframe["dc_upper"])
            & dataframe["dc_upper"].notna()
        )

        dataframe.loc[breakout, "enter_long"] = 1
        dataframe.loc[breakout, "enter_tag"] = "dc_breakout_up"
        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        breakdown = (
            (dataframe["close"] < dataframe["dc_lower"])
            & dataframe["dc_lower"].notna()
        )

        dataframe.loc[breakdown, "exit_long"] = 1
        dataframe.loc[breakdown, "exit_tag"] = "dc_breakout_down"
        return dataframe
