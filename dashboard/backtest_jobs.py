"""Backtest + Hyperopt job runner.

Freqtrade does not expose backtesting/hyperopt over its REST API. The
bridge therefore runs them as subprocesses and tracks their state in
memory. Status is fanned out to dashboard clients over the existing
``/ws`` channel as ``{"channel": "backtest"|"hyperopt", ...}`` events.

A "job" looks like::

    {
      "id": "bt_abc123",
      "kind": "backtest" | "hyperopt",
      "status": "running" | "completed" | "failed" | "cancelled",
      "strategy": "SmaCross",
      "timerange": "20230101-20240101",
      "started_at": 1700000000.0,
      "finished_at": 1700000123.4,
      "log": [<last 500 lines>],
      "result": {...}      # parsed metrics when status == completed
    }

The manager is intentionally process-local — restarting the bridge wipes
the in-memory list, which is fine for a single-user dev tool. Persisted
results live in ``user_data/backtest_results/`` and ``user_data/hyperopt_results/``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Job model
# ---------------------------------------------------------------------------


JobStatus = Literal["running", "completed", "failed", "cancelled"]
JobKind = Literal["backtest", "hyperopt"]
EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class BacktestJob:
    """In-memory representation of a single backtest or hyperopt run."""

    id: str
    kind: JobKind
    strategy: str
    timerange: str
    pairs: list[str] | None = None
    timeframe: str | None = None
    spaces: list[str] | None = None
    epochs: int | None = None
    loss: str | None = None
    status: JobStatus = "running"
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    return_code: int | None = None
    cmd: list[str] = field(default_factory=list)
    export_filename: str | None = None
    log: list[str] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    current_epoch: int | None = None
    best_params: dict[str, Any] | None = None

    process: asyncio.subprocess.Process | None = field(default=None, repr=False)
    _watcher_task: asyncio.Task | None = field(default=None, repr=False)
    _stdout_task: asyncio.Task | None = field(default=None, repr=False)
    _stderr_task: asyncio.Task | None = field(default=None, repr=False)

    def to_public(self, *, include_log: bool = True, log_tail: int = 200) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "jobId": self.id,  # alias used by the frontend
            "kind": self.kind,
            "strategy": self.strategy,
            "timerange": self.timerange,
            "pairs": self.pairs,
            "timeframe": self.timeframe,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "return_code": self.return_code,
            "error": self.error,
        }
        if self.kind == "hyperopt":
            out["epochs"] = self.epochs
            out["spaces"] = self.spaces
            out["loss"] = self.loss
            out["current_epoch"] = self.current_epoch
            out["best_params"] = self.best_params
        if include_log:
            out["log"] = self.log[-log_tail:]
        if self.result is not None:
            out["result"] = self.result
        return out


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------


class FreqtradeNotInstalled(RuntimeError):
    """Raised when ``freqtrade`` is not available on PATH."""


class BacktestJobManager:
    """Owns the in-memory job table and the subprocess lifecycle."""

    def __init__(
        self,
        userdir: Path,
        on_event: EventCallback | None = None,
        max_jobs: int = 50,
        log_capacity: int = 500,
    ) -> None:
        self._userdir = userdir
        self._jobs: dict[str, BacktestJob] = {}
        self._lock = asyncio.Lock()
        self._on_event = on_event
        self._max_jobs = max_jobs
        self._log_capacity = log_capacity

    # -- introspection --

    @staticmethod
    def freqtrade_available() -> bool:
        return shutil.which("freqtrade") is not None

    async def list(self) -> list[dict[str, Any]]:
        async with self._lock:
            jobs = sorted(
                self._jobs.values(),
                key=lambda j: j.started_at,
                reverse=True,
            )
        return [j.to_public(include_log=False) for j in jobs]

    async def get(self, job_id: str) -> BacktestJob | None:
        async with self._lock:
            return self._jobs.get(job_id)

    # -- start --

    async def start_backtest(
        self,
        *,
        strategy: str,
        timerange: str,
        pairs: list[str] | None = None,
        timeframe: str | None = None,
    ) -> BacktestJob:
        if not self.freqtrade_available():
            raise FreqtradeNotInstalled("freqtrade not installed")

        job_id = "bt_" + uuid.uuid4().hex[:10]
        export_filename = f"job_{job_id}"
        results_dir = self._userdir / "backtest_results"
        results_dir.mkdir(parents=True, exist_ok=True)

        cmd: list[str] = [
            "freqtrade",
            "backtesting",
            "--strategy",
            strategy,
            "--timerange",
            timerange,
            "--userdir",
            str(self._userdir),
            "--export",
            "trades",
            "--export-filename",
            str(results_dir / export_filename),
        ]
        if timeframe:
            cmd.extend(["--timeframe", timeframe])
        if pairs:
            cmd.extend(["--pairs", *pairs])

        job = BacktestJob(
            id=job_id,
            kind="backtest",
            strategy=strategy,
            timerange=timerange,
            pairs=pairs,
            timeframe=timeframe,
            cmd=cmd,
            export_filename=export_filename,
        )
        await self._spawn(job)
        return job

    async def start_hyperopt(
        self,
        *,
        strategy: str,
        epochs: int = 300,
        timerange: str,
        spaces: list[str] | None = None,
        loss: str = "SharpeHyperOptLoss",
        timeframe: str | None = None,
    ) -> BacktestJob:
        if not self.freqtrade_available():
            raise FreqtradeNotInstalled("freqtrade not installed")

        spaces = spaces or ["buy", "sell", "roi", "stoploss"]
        job_id = "ho_" + uuid.uuid4().hex[:10]

        cmd: list[str] = [
            "freqtrade",
            "hyperopt",
            "--strategy",
            strategy,
            "--hyperopt-loss",
            loss,
            "--spaces",
            *spaces,
            "--epochs",
            str(epochs),
            "--timerange",
            timerange,
            "--userdir",
            str(self._userdir),
        ]
        if timeframe:
            cmd.extend(["--timeframe", timeframe])

        job = BacktestJob(
            id=job_id,
            kind="hyperopt",
            strategy=strategy,
            timerange=timerange,
            epochs=epochs,
            spaces=spaces,
            loss=loss,
            timeframe=timeframe,
            cmd=cmd,
        )
        await self._spawn(job)
        return job

    async def _spawn(self, job: BacktestJob) -> None:
        # Trim oldest finished jobs once we exceed the cap. Active jobs
        # are never evicted.
        async with self._lock:
            self._jobs[job.id] = job
            if len(self._jobs) > self._max_jobs:
                done = sorted(
                    (j for j in self._jobs.values() if j.status != "running"),
                    key=lambda j: j.finished_at or j.started_at,
                )
                excess = len(self._jobs) - self._max_jobs
                for old in done[:excess]:
                    self._jobs.pop(old.id, None)

        try:
            proc = await asyncio.create_subprocess_exec(
                *job.cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            job.status = "failed"
            job.error = f"could not spawn freqtrade: {exc}"
            job.finished_at = time.time()
            await self._emit(job, "failed")
            return

        job.process = proc

        await self._emit(
            job,
            "started",
            extra={
                "strategy": job.strategy,
                "timerange": job.timerange,
                "kind": job.kind,
            },
        )

        job._stdout_task = asyncio.create_task(self._pump(job, proc.stdout, "stdout"))
        job._stderr_task = asyncio.create_task(self._pump(job, proc.stderr, "stderr"))
        job._watcher_task = asyncio.create_task(self._watch(job))

    # -- background workers --

    async def _pump(
        self,
        job: BacktestJob,
        stream: asyncio.StreamReader | None,
        label: str,
    ) -> None:
        if stream is None:
            return
        last_flush = time.monotonic()
        pending: list[str] = []
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip("\n")
                job.log.append(text)
                if len(job.log) > self._log_capacity:
                    del job.log[: len(job.log) - self._log_capacity]
                pending.append(text)

                # Hyperopt prints "Epoch N/M" lines we can use for progress.
                if job.kind == "hyperopt":
                    self._update_hyperopt_progress(job, text)

                now = time.monotonic()
                # flush every ~12 lines or every 2 seconds, whichever first
                if len(pending) >= 12 or (now - last_flush) >= 2.0:
                    await self._emit(job, "progress", extra={"log": pending[:]})
                    pending.clear()
                    last_flush = now
        except Exception as exc:  # noqa: BLE001 — pump must be tolerant
            logger.debug("job %s %s pump error: %s", job.id, label, exc)
        finally:
            if pending:
                await self._emit(job, "progress", extra={"log": pending[:]})

    @staticmethod
    def _update_hyperopt_progress(job: BacktestJob, line: str) -> None:
        # Looking for things like "Epoch  17/300" or "Epoch 17 / 300".
        import re

        m = re.search(r"Epoch\s+(\d+)\s*/\s*(\d+)", line)
        if m:
            try:
                job.current_epoch = int(m.group(1))
            except ValueError:
                pass

    async def _watch(self, job: BacktestJob) -> None:
        proc = job.process
        if proc is None:
            return
        try:
            return_code = await proc.wait()
        except asyncio.CancelledError:
            return_code = proc.returncode
        # let the pump tasks drain so we do not lose the tail of the log
        for t in (job._stdout_task, job._stderr_task):
            if t is not None:
                try:
                    await t
                except Exception:  # noqa: BLE001
                    pass

        job.return_code = return_code
        job.finished_at = time.time()
        if job.status == "cancelled":
            await self._emit(job, "cancelled")
            return
        if return_code == 0:
            job.status = "completed"
            try:
                if job.kind == "backtest":
                    job.result = self._parse_backtest_result(job)
                else:
                    job.result = self._parse_hyperopt_result(job)
            except Exception as exc:  # noqa: BLE001
                logger.exception("failed parsing job %s result", job.id)
                job.error = f"result parser failed: {exc}"
            await self._emit(job, "completed", extra={"result": job.result})
        else:
            job.status = "failed"
            tail = "\n".join(job.log[-20:])
            job.error = f"exit {return_code}: {tail[-500:]}"
            await self._emit(job, "failed")

    # -- cancel --

    async def cancel(self, job_id: str) -> bool:
        async with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        if job.status != "running":
            return False
        proc = job.process
        job.status = "cancelled"
        if proc is None:
            job.finished_at = time.time()
            await self._emit(job, "cancelled")
            return True
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        return True

    # -- shutdown --

    async def shutdown(self) -> None:
        async with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            if job.status != "running" or job.process is None:
                continue
            try:
                job.process.terminate()
            except ProcessLookupError:
                pass

    # -- result parsing --

    def _parse_backtest_result(self, job: BacktestJob) -> dict[str, Any]:
        path = self._find_backtest_result_file(job)
        if path is None:
            raise FileNotFoundError("no backtest result file produced by freqtrade")
        return parse_backtest_json(path.read_text())

    def _find_backtest_result_file(self, job: BacktestJob) -> Path | None:
        # glob silently returns [] for non-existent dirs — no need to pre-check.
        results_dir = self._userdir / "backtest_results"
        candidates: list[Path] = []
        if job.export_filename:
            candidates.extend(p for p in results_dir.glob(f"{job.export_filename}*.json") if p.is_file())
        if not candidates:
            candidates = [p for p in results_dir.glob("*.json") if p.is_file()]
        if not candidates:
            return None
        # Prefer files NOT named like "*meta.json"; otherwise newest mtime.
        non_meta = [p for p in candidates if not p.name.endswith(".meta.json")]
        pool = non_meta or candidates
        pool.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return pool[0]

    def _parse_hyperopt_result(self, job: BacktestJob) -> dict[str, Any]:
        # Hyperopt writes a per-strategy fthypt file; we surface the log
        # tail and the "Best result" block since freqtrade does not emit
        # a single canonical JSON for it.
        import re

        text = "\n".join(job.log)
        params: dict[str, Any] = {}
        # Common pattern: "Best result: ... Buy hyperspace params: { ... }"
        m = re.search(r"Best result:\s*(.+?)(?:\n\n|\Z)", text, re.DOTALL)
        best_block = m.group(1).strip() if m else None
        # Try to grab any json-like {...} blocks following "params:"
        for label, key in [
            ("Buy hyperspace params:", "buy"),
            ("Sell hyperspace params:", "sell"),
            ("ROI table:", "roi"),
            ("Stoploss:", "stoploss"),
        ]:
            mm = re.search(re.escape(label) + r"\s*(.+?)(?:\n\s*\n|\Z)", text, re.DOTALL)
            if mm:
                params[key] = mm.group(1).strip()
        job.best_params = params or job.best_params
        return {
            "best_block": best_block,
            "best_params": params,
            "current_epoch": job.current_epoch,
            "epochs": job.epochs,
        }

    # -- ws emission --

    async def _emit(
        self,
        job: BacktestJob,
        event: str,
        *,
        extra: dict[str, Any] | None = None,
    ) -> None:
        if self._on_event is None:
            return
        msg: dict[str, Any] = {
            "type": job.kind,  # "backtest" or "hyperopt"
            "channel": job.kind,
            "event": event,
            "jobId": job.id,
            "status": job.status,
            "ts": time.time(),
        }
        if extra:
            msg.update(extra)
        if event in {"completed", "failed", "cancelled"}:
            msg.setdefault("return_code", job.return_code)
            msg.setdefault("error", job.error)
        try:
            await self._on_event(msg)
        except Exception as exc:  # noqa: BLE001
            logger.debug("ws emit failed for %s: %s", job.id, exc)


# ---------------------------------------------------------------------------
# JSON parser (exposed for tests)
# ---------------------------------------------------------------------------


def parse_backtest_json(raw: str | dict[str, Any]) -> dict[str, Any]:
    """Extract the metrics the dashboard needs from a freqtrade result file.

    Freqtrade's ``--export trades`` writes a JSON of the form::

        {
          "strategy": {
            "<StrategyName>": {
              "trades": [...],
              "results_per_pair": [...],
              "total_trades": 42,
              "profit_total": 0.12,
              "profit_total_abs": 1234.56,
              "max_drawdown_account": 0.07,
              "max_drawdown_abs": 89.0,
              "sharpe": 1.4, "sortino": 1.8, "calmar": 0.9,
              "winrate": 0.55, "profit_factor": 1.6,
              "holding_avg": "1 day, 4:00:00",
              ...
            }
          },
          "strategy_comparison": [...],
        }

    Older versions nest things slightly differently — we are tolerant of
    both the top-level shape and the per-strategy shape.
    """
    if isinstance(raw, str):
        data = json.loads(raw)
    else:
        data = raw

    block = data
    if isinstance(data.get("strategy"), dict):
        # pick the first strategy block
        strategies = data["strategy"]
        if strategies:
            first_key = next(iter(strategies))
            block = strategies[first_key]
            block = {**block, "_strategy_name": first_key}

    def _g(*keys: str, default: Any = None) -> Any:
        for k in keys:
            if k in block and block[k] is not None:
                return block[k]
        return default

    pct = lambda v: float(v) * 100 if isinstance(v, (int, float)) and abs(v) <= 1.0 else (
        float(v) if v is not None else None
    )

    profit_total = _g("profit_total_abs", "profit_total", default=0.0)
    profit_total_pct = _g("profit_total", default=None)
    if isinstance(profit_total_pct, (int, float)) and abs(profit_total_pct) <= 1.0:
        profit_total_pct = float(profit_total_pct) * 100
    elif profit_total_pct is not None:
        profit_total_pct = float(profit_total_pct)

    max_dd_acct = _g("max_drawdown_account", "max_drawdown", default=0.0)
    if isinstance(max_dd_acct, (int, float)) and abs(max_dd_acct) <= 1.0:
        max_dd_pct = float(max_dd_acct) * 100
    else:
        max_dd_pct = float(max_dd_acct) if max_dd_acct is not None else 0.0

    win_rate = _g("winrate", "wins_ratio", default=None)
    if isinstance(win_rate, (int, float)) and win_rate > 1.0:
        win_rate = float(win_rate) / 100

    trades_raw = _g("trades", default=[]) or []
    trades = []
    for t in trades_raw:
        trades.append(
            {
                "pair": t.get("pair"),
                "side": "short" if t.get("is_short") else "long",
                "open_date": t.get("open_date") or t.get("open_timestamp"),
                "close_date": t.get("close_date") or t.get("close_timestamp"),
                "profit_pct": (
                    float(t.get("profit_ratio", 0.0)) * 100
                    if isinstance(t.get("profit_ratio"), (int, float))
                    else t.get("profit_pct")
                ),
                "profit_abs": t.get("profit_abs"),
                "duration": t.get("trade_duration") or t.get("duration"),
            }
        )

    # equity curve: freqtrade emits per-trade balance points; we synthesise
    # one from the running profit when an explicit curve is not present.
    equity_curve: list[list[float]] = []
    if isinstance(_g("equity_curve"), list):
        for pt in block["equity_curve"]:
            if isinstance(pt, dict):
                equity_curve.append([pt.get("date") or pt.get("ts"), pt.get("balance")])
            elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                equity_curve.append([pt[0], pt[1]])
    elif trades_raw:
        running = 0.0
        for t in trades_raw:
            running += float(t.get("profit_abs") or 0.0)
            ts = t.get("close_timestamp") or t.get("close_date")
            equity_curve.append([ts, running])

    # best/worst pair from the per-pair table when available
    per_pair = _g("results_per_pair", default=[]) or []
    best_pair = None
    worst_pair = None
    if per_pair:
        ranked = [
            p
            for p in per_pair
            if (p.get("key") or p.get("pair"))
            and (p.get("key") or p.get("pair")) != "TOTAL"
        ]
        ranked.sort(
            key=lambda p: float(p.get("profit_total_abs") or p.get("profit_sum") or 0.0),
            reverse=True,
        )
        if ranked:
            best_pair = ranked[0].get("key") or ranked[0].get("pair")
            worst_pair = ranked[-1].get("key") or ranked[-1].get("pair")

    return {
        "strategy": block.get("_strategy_name"),
        "total_trades": int(_g("total_trades", default=len(trades_raw)) or 0),
        "profit_total": float(profit_total or 0.0),
        "profit_total_pct": float(profit_total_pct or 0.0),
        "max_drawdown_account": float(max_dd_acct or 0.0),
        "max_drawdown_pct": float(max_dd_pct or 0.0),
        "max_drawdown_abs": float(_g("max_drawdown_abs", default=0.0) or 0.0),
        "sharpe": float(_g("sharpe", default=0.0) or 0.0),
        "sortino": float(_g("sortino", default=0.0) or 0.0),
        "calmar": float(_g("calmar", default=0.0) or 0.0),
        "win_rate": float(win_rate or 0.0),
        "profit_factor": float(_g("profit_factor", default=0.0) or 0.0),
        "avg_duration": _g("holding_avg", "avg_duration", default=None),
        "best_pair": best_pair,
        "worst_pair": worst_pair,
        "trades": trades,
        "equity_curve": equity_curve,
    }
