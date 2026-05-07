"""Smoke tests for the bundled strategies.

These tests run without freqtrade installed by:
  1. Always parsing the strategy files (AST) so syntax errors are caught.
  2. If freqtrade is importable, also instantiating the classes and
     running ``populate_indicators`` / entry / exit on a synthetic OHLCV
     frame to make sure no NaN-related crash slips through.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
from pathlib import Path

import pytest


STRATEGY_DIR = Path(__file__).resolve().parent.parent / "user_data" / "strategies"
STRATEGIES = ["SmaCross", "BollingerRevert", "DonchianBreak"]


@pytest.mark.parametrize("name", STRATEGIES)
def test_strategy_file_parses(name: str) -> None:
    """Every strategy file must be syntactically valid Python."""
    path = STRATEGY_DIR / f"{name}.py"
    assert path.exists(), f"Missing strategy file: {path}"
    source = path.read_text()
    ast.parse(source)  # raises SyntaxError on bad syntax


def _freqtrade_available() -> bool:
    return importlib.util.find_spec("freqtrade") is not None


def _make_ohlcv(rows: int = 300):
    """Synthetic OHLCV frame deterministic enough for indicator math."""
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(42)
    # Random walk in log space, scaled to plausible BTC prices.
    steps = rng.normal(0, 0.005, size=rows)
    close = 30_000.0 * np.exp(np.cumsum(steps))
    high = close * (1.0 + rng.uniform(0.0, 0.01, size=rows))
    low = close * (1.0 - rng.uniform(0.0, 0.01, size=rows))
    open_ = np.concatenate([[close[0]], close[:-1]])
    volume = rng.uniform(1.0, 10.0, size=rows)
    idx = pd.date_range("2024-01-01", periods=rows, freq="1h")
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=idx,
    )


@pytest.mark.skipif(not _freqtrade_available(), reason="freqtrade not installed")
@pytest.mark.parametrize("name", STRATEGIES)
def test_strategy_runs_on_synthetic_data(name: str) -> None:
    """If freqtrade is available, indicator/entry/exit pipelines must run."""
    module = importlib.import_module(f"user_data.strategies.{name}")
    cls = getattr(module, name)

    config: dict = {"runmode": "backtest", "stake_currency": "USD"}
    strategy = cls(config)

    df = _make_ohlcv(rows=300)
    metadata = {"pair": "BTC/USD"}

    df = strategy.populate_indicators(df, metadata)
    df = strategy.populate_entry_trend(df, metadata)
    df = strategy.populate_exit_trend(df, metadata)

    # The pipelines should add at least one signal column.
    assert "enter_long" in df.columns or df.get("enter_long") is not None
    assert "exit_long" in df.columns or df.get("exit_long") is not None
