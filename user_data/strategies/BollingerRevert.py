"""BollingerRevert — mean-reversion strategy using Bollinger Bands + RSI.

Enters long when price tags the lower band while RSI(14) is oversold,
and exits when price reverts to the middle band (or stoploss/ROI hits).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from freqtrade.strategy import DecimalParameter, IntParameter, IStrategy


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder's RSI implementation in pure pandas (no TA-Lib dependency)."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)

    # Wilder's smoothing == EMA with alpha = 1/period.
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    # When avg_loss is 0 (no losses) RSI saturates at 100.
    rsi = rsi.where(avg_loss != 0.0, 100.0)
    return rsi


class BollingerRevert(IStrategy):
    """Buy the lower Bollinger band on oversold RSI, sell at the mean."""

    INTERFACE_VERSION = 3

    timeframe = "1h"
    stoploss = -0.04
    minimal_roi = {"0": 0.03, "60": 0.015, "240": 0}

    order_types = {
        "entry": "limit",
        "exit": "limit",
        "stoploss": "market",
        "stoploss_on_exchange": False,
    }

    process_only_new_candles = True
    startup_candle_count: int = 100

    # Hyperopt-tunable parameters.
    bb_window = IntParameter(15, 30, default=20, space="buy")
    bb_std = DecimalParameter(1.5, 2.5, default=2.0, decimals=1, space="buy")
    rsi_oversold = IntParameter(20, 40, default=30, space="buy")

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        window = int(self.bb_window.value)
        std_mult = float(self.bb_std.value)

        rolling = dataframe["close"].rolling(window=window, min_periods=window)
        mid = rolling.mean()
        std = rolling.std(ddof=0)

        dataframe["bb_mid"] = mid
        dataframe["bb_upper"] = mid + std_mult * std
        dataframe["bb_lower"] = mid - std_mult * std
        dataframe["rsi"] = _rsi(dataframe["close"], period=14)
        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        threshold = int(self.rsi_oversold.value)

        long_cond = (
            (dataframe["close"] <= dataframe["bb_lower"])
            & (dataframe["rsi"] < threshold)
            & dataframe["bb_lower"].notna()
            & dataframe["rsi"].notna()
        )

        dataframe.loc[long_cond, "enter_long"] = 1
        dataframe.loc[long_cond, "enter_tag"] = "bb_lower_oversold"
        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        exit_cond = (
            (dataframe["close"] >= dataframe["bb_mid"])
            & dataframe["bb_mid"].notna()
        )

        dataframe.loc[exit_cond, "exit_long"] = 1
        dataframe.loc[exit_cond, "exit_tag"] = "bb_mean_revert"
        return dataframe
