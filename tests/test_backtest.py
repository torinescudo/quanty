"""Tests for the backtest + hyperopt subsystem.

Covers:
- Result JSON parsing (the freqtrade-on-disk shape → dashboard shape).
- HTTP endpoints when freqtrade is not available on PATH (503).
- The job manager spawning / cancellation flow with subprocess mocked.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

# Match test_bridge.py — keep the bridge's auth disabled in tests.
os.environ.pop("FREQTRADE_USER", None)
os.environ.pop("FREQTRADE_PASS", None)
os.environ.setdefault("FREQTRADE_URL", "http://test-freqtrade")


from dashboard.app import app  # noqa: E402
from dashboard.backtest_jobs import (  # noqa: E402
    BacktestJob,
    BacktestJobManager,
    FreqtradeNotInstalled,
    parse_backtest_json,
)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# parse_backtest_json
# ---------------------------------------------------------------------------


SAMPLE_FREQTRADE_RESULT = {
    "strategy": {
        "SmaCross": {
            "total_trades": 12,
            "profit_total": 0.184,  # ratio → 18.4%
            "profit_total_abs": 184.32,
            "max_drawdown_account": 0.072,  # ratio → 7.2%
            "max_drawdown_abs": 72.5,
            "sharpe": 1.42,
            "sortino": 1.81,
            "calmar": 0.93,
            "winrate": 0.58,
            "profit_factor": 1.65,
            "holding_avg": "1 day, 4:00:00",
            "trades": [
                {
                    "pair": "BTC/USD",
                    "is_short": False,
                    "open_date": "2023-03-01T10:00:00Z",
                    "close_date": "2023-03-02T14:00:00Z",
                    "profit_ratio": 0.034,
                    "profit_abs": 34.0,
                    "trade_duration": 1680,
                    "close_timestamp": 1677766800,
                },
                {
                    "pair": "ETH/USD",
                    "is_short": False,
                    "open_date": "2023-04-12T08:00:00Z",
                    "close_date": "2023-04-13T20:00:00Z",
                    "profit_ratio": -0.012,
                    "profit_abs": -12.5,
                    "trade_duration": 2160,
                    "close_timestamp": 1681416000,
                },
            ],
            "results_per_pair": [
                {"key": "BTC/USD", "profit_total_abs": 102.4},
                {"key": "ETH/USD", "profit_total_abs": -12.5},
                {"key": "SOL/USD", "profit_total_abs": 50.1},
                {"key": "TOTAL", "profit_total_abs": 184.32},
            ],
        }
    }
}


def test_parser_extracts_top_level_metrics():
    out = parse_backtest_json(json.dumps(SAMPLE_FREQTRADE_RESULT))
    assert out["strategy"] == "SmaCross"
    assert out["total_trades"] == 12
    assert out["profit_total"] == pytest.approx(184.32)
    assert out["profit_total_pct"] == pytest.approx(18.4)
    assert out["max_drawdown_pct"] == pytest.approx(7.2)
    assert out["sharpe"] == pytest.approx(1.42)
    assert out["sortino"] == pytest.approx(1.81)
    assert out["win_rate"] == pytest.approx(0.58)
    assert out["profit_factor"] == pytest.approx(1.65)
    assert out["avg_duration"] == "1 day, 4:00:00"


def test_parser_normalises_trades():
    out = parse_backtest_json(SAMPLE_FREQTRADE_RESULT)
    assert len(out["trades"]) == 2
    btc = out["trades"][0]
    assert btc["pair"] == "BTC/USD"
    assert btc["side"] == "long"
    assert btc["profit_pct"] == pytest.approx(3.4)
    assert btc["duration"] == 1680


def test_parser_picks_best_and_worst_pair():
    out = parse_backtest_json(SAMPLE_FREQTRADE_RESULT)
    # TOTAL must be excluded; BTC has the largest, ETH the smallest profit.
    assert out["best_pair"] == "BTC/USD"
    assert out["worst_pair"] == "ETH/USD"


def test_parser_synthesises_equity_curve():
    out = parse_backtest_json(SAMPLE_FREQTRADE_RESULT)
    # No explicit equity_curve in the sample — should be derived from trades.
    assert len(out["equity_curve"]) == 2
    # Running cumulative profit_abs: 34.0, then 34.0 + (-12.5) = 21.5
    assert out["equity_curve"][0][1] == pytest.approx(34.0)
    assert out["equity_curve"][1][1] == pytest.approx(21.5)


def test_parser_handles_empty_strategy_block():
    out = parse_backtest_json({"strategy": {}})
    assert out["total_trades"] == 0
    assert out["trades"] == []
    assert out["equity_curve"] == []


# ---------------------------------------------------------------------------
# HTTP endpoints — freqtrade not installed (default in CI)
# ---------------------------------------------------------------------------


def test_backtest_run_503_when_freqtrade_missing(client, monkeypatch):
    monkeypatch.setattr(BacktestJobManager, "freqtrade_available", staticmethod(lambda: False))
    resp = client.post("/api/backtest/run", json={"strategy": "SmaCross"})
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"] == "freqtrade_not_installed"


def test_backtest_run_400_when_strategy_missing(client):
    resp = client.post("/api/backtest/run", json={})
    assert resp.status_code == 400


def test_hyperopt_run_503_when_freqtrade_missing(client, monkeypatch):
    monkeypatch.setattr(BacktestJobManager, "freqtrade_available", staticmethod(lambda: False))
    resp = client.post("/api/hyperopt/run", json={"strategy": "SmaCross", "epochs": 10})
    assert resp.status_code == 503


def test_backtest_jobs_list_empty(client):
    resp = client.get("/api/backtest/jobs")
    assert resp.status_code == 200
    body = resp.json()
    assert "jobs" in body
    assert isinstance(body["jobs"], list)


def test_backtest_get_unknown_job_404(client):
    resp = client.get("/api/backtest/jobs/bt_doesnotexist")
    assert resp.status_code == 404


def test_backtest_cancel_unknown_job_404(client):
    resp = client.post("/api/backtest/jobs/bt_nope/cancel")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Job manager — subprocess lifecycle with mock
# ---------------------------------------------------------------------------


class _FakeProcess:
    """Minimal asyncio.subprocess.Process stand-in for tests."""

    def __init__(self, return_code: int = 0, stdout_lines: list[str] | None = None):
        self._rc = return_code
        self._lines = stdout_lines or []
        self.returncode = None
        self._terminate_called = False
        self._kill_called = False
        self._wait_event = asyncio.Event()
        self.stdout = self._reader(self._lines)
        self.stderr = self._reader([])

    @staticmethod
    def _reader(lines: list[str]) -> asyncio.StreamReader:
        reader = asyncio.StreamReader()
        for line in lines:
            reader.feed_data((line + "\n").encode())
        reader.feed_eof()
        return reader

    async def wait(self) -> int:
        await self._wait_event.wait()
        self.returncode = self._rc
        return self._rc

    def terminate(self) -> None:
        self._terminate_called = True
        self._wait_event.set()

    def kill(self) -> None:
        self._kill_called = True
        self._wait_event.set()

    def finish(self) -> None:
        self._wait_event.set()


@pytest.mark.asyncio
async def test_manager_raises_when_freqtrade_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(BacktestJobManager, "freqtrade_available", staticmethod(lambda: False))
    mgr = BacktestJobManager(userdir=tmp_path)
    with pytest.raises(FreqtradeNotInstalled):
        await mgr.start_backtest(strategy="SmaCross", timerange="20230101-20240101")


@pytest.mark.asyncio
async def test_manager_cancel_terminates_process(tmp_path, monkeypatch):
    monkeypatch.setattr(BacktestJobManager, "freqtrade_available", staticmethod(lambda: True))

    fake = _FakeProcess(return_code=-15, stdout_lines=["starting backtest"])

    async def fake_create(*args: Any, **kwargs: Any):
        return fake

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)

    mgr = BacktestJobManager(userdir=tmp_path)
    job = await mgr.start_backtest(strategy="SmaCross", timerange="20230101-20240101")
    assert job.status == "running"
    assert job.process is fake

    # Allow the watcher and pumps to enqueue at least one event loop turn.
    await asyncio.sleep(0)

    ok = await mgr.cancel(job.id)
    assert ok is True
    assert fake._terminate_called is True
    assert job.status == "cancelled"


@pytest.mark.asyncio
async def test_manager_completes_and_emits_event(tmp_path, monkeypatch):
    monkeypatch.setattr(BacktestJobManager, "freqtrade_available", staticmethod(lambda: True))

    # Drop a fake result file in the expected location so the parser succeeds.
    results_dir = tmp_path / "backtest_results"
    results_dir.mkdir(parents=True, exist_ok=True)

    captured: list[dict[str, Any]] = []

    async def on_event(msg: dict[str, Any]) -> None:
        captured.append(msg)

    fake = _FakeProcess(return_code=0, stdout_lines=["done"])

    async def fake_create(*args: Any, **kwargs: Any):
        return fake

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)

    mgr = BacktestJobManager(userdir=tmp_path, on_event=on_event)
    job = await mgr.start_backtest(strategy="SmaCross", timerange="20230101-20240101")

    # Place a result file matching the export filename pattern that the manager picks up.
    result_path = results_dir / f"{job.export_filename}-2024.json"
    result_path.write_text(json.dumps(SAMPLE_FREQTRADE_RESULT))

    fake.finish()
    # Wait until the watcher task records completion.
    for _ in range(50):
        await asyncio.sleep(0.02)
        if job.status != "running":
            break
    assert job.status == "completed"
    assert job.result is not None
    assert job.result["total_trades"] == 12

    events = [e["event"] for e in captured]
    assert "started" in events
    assert "completed" in events


@pytest.mark.asyncio
async def test_manager_list_returns_newest_first(tmp_path, monkeypatch):
    mgr = BacktestJobManager(userdir=tmp_path)
    # Inject two finished jobs directly to test ordering.
    j1 = BacktestJob(id="bt_a", kind="backtest", strategy="X", timerange="t", started_at=10.0)
    j1.status = "completed"
    j2 = BacktestJob(id="bt_b", kind="backtest", strategy="Y", timerange="t", started_at=20.0)
    j2.status = "completed"
    async with mgr._lock:
        mgr._jobs[j1.id] = j1
        mgr._jobs[j2.id] = j2
    listed = await mgr.list()
    assert [j["id"] for j in listed] == ["bt_b", "bt_a"]
