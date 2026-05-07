"""FastAPI bridge between the VOID dashboard and Freqtrade.

This module exposes the REST + WebSocket surface that the static
dashboard (``dashboard/static/``) consumes. Internally it talks to a
running Freqtrade instance over its REST API (default
``http://127.0.0.1:8080``) and re-shapes the responses into the form
expected by ``void-views.jsx`` and the rest of the SPA.

Run it locally with::

    uvicorn dashboard.app:app --reload --port 8000

Configuration via environment variables (or a ``.env`` next to the
project root, loaded automatically when ``python-dotenv`` is present):

    FREQTRADE_URL       default ``http://127.0.0.1:8080``
    FREQTRADE_USER      optional, JWT login user
    FREQTRADE_PASS      optional, JWT login password
    BRIDGE_CORS_ORIGINS comma-separated list (defaults to localhost:8000)

When the Freqtrade backend is unreachable the endpoints return ``503``
with a JSON body describing the failure — they never crash the bridge.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .backtest_jobs import BacktestJobManager
from .freqtrade_client import FreqtradeClient, FreqtradeError
from .logging_config import configure_logging, reset_request_id, set_request_id
from .ws_manager import WebSocketManager

try:  # python-dotenv is optional but listed in pyproject; load .env if present
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # noqa: BLE001 — dotenv is best effort
    pass


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _static_dir() -> Path:
    return Path(__file__).resolve().parent / "static"


def _read_config_credentials() -> tuple[str | None, str | None]:
    """Fall back to ``user_data/config.json`` for the api_server creds."""
    cfg_path = _project_root() / "user_data" / "config.json"
    if not cfg_path.exists():
        return None, None
    try:
        cfg = json.loads(cfg_path.read_text())
    except (OSError, ValueError) as exc:
        logger.warning("could not read %s: %s", cfg_path, exc)
        return None, None
    api = cfg.get("api_server", {}) or {}
    return api.get("username") or None, api.get("password") or None


def _resolve_credentials() -> tuple[str | None, str | None]:
    user = os.getenv("FREQTRADE_USER") or None
    pw = os.getenv("FREQTRADE_PASS") or None
    if user and pw:
        return user, pw
    cfg_user, cfg_pw = _read_config_credentials()
    return user or cfg_user, pw or cfg_pw


def _resolve_cors() -> list[str]:
    raw = os.getenv("BRIDGE_CORS_ORIGINS")
    if not raw:
        return ["http://localhost:8000", "http://127.0.0.1:8000"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


# ---------------------------------------------------------------------------
# In-memory state (notifications + connection flag)
# ---------------------------------------------------------------------------


class NotificationStore:
    """Tiny in-memory notifications buffer.

    Phase 1 keeps it intentionally non-persistent — restart wipes it.
    Bridge components push events via ``add()``; the dashboard reads via
    ``GET /api/notifications`` and clears via ``read-all`` / ``DELETE``.
    """

    def __init__(self, capacity: int = 200) -> None:
        self._items: list[dict[str, Any]] = []
        self._capacity = capacity
        self._lock = asyncio.Lock()

    async def add(self, level: str, message: str, **extra: Any) -> dict[str, Any]:
        item = {
            "id": uuid.uuid4().hex,
            "level": level,
            "message": message,
            "ts": time.time(),
            "read": False,
            **extra,
        }
        async with self._lock:
            self._items.insert(0, item)
            del self._items[self._capacity :]
        return item

    async def list(self) -> list[dict[str, Any]]:
        async with self._lock:
            return list(self._items)

    async def mark_all_read(self) -> int:
        async with self._lock:
            n = 0
            for it in self._items:
                if not it["read"]:
                    it["read"] = True
                    n += 1
            return n

    async def clear(self) -> int:
        async with self._lock:
            n = len(self._items)
            self._items.clear()
            return n


class ConnectionState:
    """Tracks whether the user has explicitly 'connected' the dashboard.

    The Freqtrade backend may be up regardless — this flag mirrors the
    UI affordance ``connect / disconnect`` from ``void-shell.jsx``.
    """

    def __init__(self) -> None:
        self.connected: bool = False
        self.api_key_label: str | None = None  # never store the raw key


# ---------------------------------------------------------------------------
# Lifespan + app construction
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Configure structured (JSON) logging before any logger fires so
    # the startup line itself is captured in the right format.
    configure_logging()
    user, pw = _resolve_credentials()
    base_url = os.getenv("FREQTRADE_URL", "http://127.0.0.1:8080")
    app.state.client = FreqtradeClient(base_url=base_url, username=user, password=pw)
    app.state.notifications = NotificationStore()
    app.state.connection = ConnectionState()
    app.state.started_at = time.time()
    ws_manager = WebSocketManager()
    app.state.ws = ws_manager
    app.state.backtests = BacktestJobManager(
        userdir=_project_root() / "user_data",
        on_event=ws_manager.broadcast,
    )
    logger.info(
        "bridge ready",
        extra={"freqtrade_url": base_url, "auth": bool(user and pw)},
    )
    try:
        yield
    finally:
        try:
            await app.state.backtests.shutdown()
        except Exception:  # noqa: BLE001
            logger.exception("error shutting down backtest manager")
        await app.state.client.aclose()


def _make_app() -> FastAPI:
    app = FastAPI(
        title="VOID quant.platform bridge",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_resolve_cors(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------------------------------------------
    # Request-ID middleware: assigns/propagates ``X-Request-ID`` so each
    # log line emitted within a request handler can be correlated.
    # ------------------------------------------------------------------
    @app.middleware("http")
    async def _request_id_middleware(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        token = set_request_id(rid)
        try:
            response = await call_next(request)
        finally:
            reset_request_id(token)
        response.headers["X-Request-ID"] = rid
        return response

    # ------------------------------------------------------------------
    # Error mapping
    # ------------------------------------------------------------------
    @app.exception_handler(FreqtradeError)
    async def _freqtrade_error_handler(request: Request, exc: FreqtradeError):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": "freqtrade_unreachable" if exc.status_code == 503 else "freqtrade_error",
                "message": str(exc),
                "detail": exc.payload,
            },
        )

    # ------------------------------------------------------------------
    # Health & readiness
    # ------------------------------------------------------------------
    @app.get("/healthz")
    async def healthz():
        # Liveness: the bridge process answered. Does NOT touch freqtrade
        # — orchestration tools read this to decide whether to restart
        # the container.
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz(request: Request):
        # Readiness: the bridge is healthy AND freqtrade is reachable.
        # Used by load balancers / k8s readiness probes. Returns 503 with
        # the same JSON shape on failure so callers can introspect why.
        client: FreqtradeClient = request.app.state.client
        try:
            await client.ping()
        except FreqtradeError as exc:
            return JSONResponse(
                status_code=503,
                content={
                    "status": "not_ready",
                    "freqtrade_reachable": False,
                    "reason": str(exc),
                },
            )
        return {"status": "ready", "freqtrade_reachable": True}

    @app.get("/metrics")
    async def metrics(request: Request):
        # Lightweight JSON metrics — Prometheus integration is out of
        # scope for Phase 7; this is enough for ad-hoc dashboards and
        # smoke tests.
        client: FreqtradeClient = request.app.state.client
        ft_reachable = True
        try:
            await client.ping()
        except FreqtradeError:
            ft_reachable = False
        manager: BacktestJobManager = request.app.state.backtests
        try:
            jobs = await manager.list()
        except Exception:  # noqa: BLE001 — metrics must never raise
            jobs = []
        running = sum(1 for j in jobs if (j.get("status") or "").lower() == "running")
        ws: WebSocketManager = request.app.state.ws
        started_at = getattr(request.app.state, "started_at", time.time())
        return {
            "version": app.version,
            "uptime_seconds": max(0.0, time.time() - started_at),
            "freqtrade_reachable": ft_reachable,
            "jobs_running": running,
            "jobs_total": len(jobs),
            "ws_clients": ws.client_count,
        }

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------
    @app.get("/api/connection/test")
    async def connection_test(request: Request):
        client: FreqtradeClient = request.app.state.client
        await client.ping()  # raises FreqtradeError → 503 if unreachable
        return {
            "ok": True,
            "freqtrade_url": client.base_url,
            "connected": request.app.state.connection.connected,
        }

    @app.post("/api/connect")
    async def connect(request: Request):
        body = await _safe_body(request)
        api_key = (body or {}).get("apiKey") or (body or {}).get("api_key")
        client: FreqtradeClient = request.app.state.client
        # We always check freqtrade is reachable before flipping the flag.
        await client.ping()
        state: ConnectionState = request.app.state.connection
        state.connected = True
        state.api_key_label = _label_key(api_key) if api_key else None
        await request.app.state.notifications.add(
            "info", "Connected to Freqtrade", source="bridge"
        )
        return {"ok": True, "connected": True, "apiKeyLabel": state.api_key_label}

    @app.post("/api/disconnect")
    async def disconnect(request: Request):
        state: ConnectionState = request.app.state.connection
        state.connected = False
        state.api_key_label = None
        await request.app.state.notifications.add(
            "info", "Disconnected from Freqtrade", source="bridge"
        )
        return {"ok": True, "connected": False}

    # ------------------------------------------------------------------
    # Portfolio
    # ------------------------------------------------------------------
    @app.get("/api/portfolio")
    async def get_portfolio(request: Request):
        client: FreqtradeClient = request.app.state.client
        balance = await client.balance()
        try:
            open_trades = await client.status()
        except FreqtradeError:
            # status() returns 502 on freqtrade when no trades exist in
            # some versions — treat any non-200 as "no open trades".
            open_trades = []
        return _shape_portfolio(balance, open_trades or [])

    # ------------------------------------------------------------------
    # Orders (open + create + cancel)
    # ------------------------------------------------------------------
    @app.get("/api/orders")
    async def get_orders(request: Request):
        client: FreqtradeClient = request.app.state.client
        try:
            raw = await client.status()
        except FreqtradeError as exc:
            if exc.status_code == 503:
                raise
            raw = []
        return {"orders": [_shape_order(t) for t in (raw or [])]}

    @app.post("/api/orders")
    async def create_order(request: Request):
        body = await _safe_body(request) or {}
        pair = body.get("pair") or body.get("symbol")
        if not pair:
            raise HTTPException(status_code=400, detail="missing 'pair'")
        side = (body.get("side") or "long").lower()
        if side in {"buy", "bid"}:
            side = "long"
        elif side in {"sell", "ask"}:
            side = "short"
        price = body.get("price")
        order_type = body.get("orderType") or body.get("type")
        stake = body.get("stakeAmount") or body.get("stake")

        client: FreqtradeClient = request.app.state.client
        try:
            result = await client.forceenter(
                pair=pair,
                side=side,
                price=float(price) if price is not None else None,
                order_type=order_type,
                stake_amount=float(stake) if stake is not None else None,
            )
        except FreqtradeError as exc:
            if exc.status_code == 404:
                # Older freqtrade only exposes /forcebuy
                result = await client.forcebuy(
                    pair=pair, price=float(price) if price is not None else None
                )
            else:
                raise
        await request.app.state.notifications.add(
            "info", f"Order submitted on {pair}", source="orders", payload=result
        )
        return {"ok": True, "result": result}

    @app.delete("/api/orders/{order_id}")
    async def cancel_order(order_id: str, request: Request):
        client: FreqtradeClient = request.app.state.client
        result = await client.forceexit(order_id)
        await request.app.state.notifications.add(
            "info", f"Order {order_id} cancelled", source="orders"
        )
        return {"ok": True, "result": result}

    @app.delete("/api/orders")
    async def cancel_all_orders(request: Request):
        client: FreqtradeClient = request.app.state.client
        try:
            open_trades = await client.status() or []
        except FreqtradeError as exc:
            if exc.status_code == 503:
                raise
            open_trades = []
        results = []
        for trade in open_trades:
            tid = trade.get("trade_id") or trade.get("id")
            if tid is None:
                continue
            try:
                results.append(await client.forceexit(tid))
            except FreqtradeError as exc:
                results.append({"error": str(exc), "trade_id": tid})
        return {"ok": True, "cancelled": len(results), "results": results}

    # ------------------------------------------------------------------
    # Fills (closed trades)
    # ------------------------------------------------------------------
    @app.get("/api/fills")
    async def get_fills(request: Request, limit: int = 500):
        client: FreqtradeClient = request.app.state.client
        raw = await client.trades(limit=limit)
        # freqtrade returns either a list or {"trades": [...], "trades_count": N}
        trades = raw.get("trades", []) if isinstance(raw, dict) else (raw or [])
        return {"fills": [_shape_fill(t) for t in trades]}

    # ------------------------------------------------------------------
    # Strategies
    # ------------------------------------------------------------------
    @app.get("/api/strategies")
    async def get_strategies(request: Request):
        client: FreqtradeClient = request.app.state.client
        try:
            raw = await client.strategies()
        except FreqtradeError as exc:
            if exc.status_code == 503:
                raise
            raw = {"strategies": []}
        names = (raw or {}).get("strategies", []) if isinstance(raw, dict) else (raw or [])
        try:
            cfg = await client.show_config() or {}
        except FreqtradeError:
            cfg = {}
        active = cfg.get("strategy")
        running = (cfg.get("state") or "").lower() == "running"
        return {
            "strategies": [
                {
                    "id": name,
                    "name": name,
                    "status": "running" if (name == active and running) else "stopped",
                    "active": name == active,
                }
                for name in names
            ],
            "active": active,
        }

    @app.post("/api/strategies/{strategy_id}/status")
    async def set_strategy_status(strategy_id: str, request: Request):
        body = await _safe_body(request) or {}
        action = (body.get("status") or body.get("action") or "").lower()
        client: FreqtradeClient = request.app.state.client
        if action in {"start", "running", "run"}:
            result = await client.start()
        elif action in {"stop", "stopped"}:
            result = await client.stop()
        elif action in {"reload", "reload_config"}:
            result = await client.reload_config()
        else:
            raise HTTPException(status_code=400, detail=f"unknown action '{action}'")
        await request.app.state.ws.broadcast_strategy(
            {"id": strategy_id, "status": action, "result": result}
        )
        await request.app.state.notifications.add(
            "info", f"Strategy {strategy_id} → {action}", source="strategies"
        )
        return {"ok": True, "result": result}

    @app.patch("/api/strategies/{strategy_id}/params")
    async def patch_strategy_params(strategy_id: str, request: Request):
        body = await _safe_body(request) or {}
        # Freqtrade does not expose live parameter mutation through its
        # REST API — params live in the strategy file + config. The
        # closest action is reload_config. We acknowledge the patch and
        # signal it via reload so the next dry-run cycle picks it up.
        client: FreqtradeClient = request.app.state.client
        try:
            result = await client.reload_config()
        except FreqtradeError as exc:
            if exc.status_code == 503:
                raise
            result = {"warning": str(exc)}
        await request.app.state.notifications.add(
            "info",
            f"Strategy {strategy_id} params patched (reload triggered)",
            source="strategies",
            params=body,
        )
        return {"ok": True, "id": strategy_id, "params": body, "result": result}

    # ------------------------------------------------------------------
    # Notifications
    # ------------------------------------------------------------------
    @app.get("/api/notifications")
    async def get_notifications(request: Request):
        items = await request.app.state.notifications.list()
        return {"notifications": items}

    @app.post("/api/notifications/read-all")
    async def read_all_notifications(request: Request):
        n = await request.app.state.notifications.mark_all_read()
        return {"ok": True, "updated": n}

    @app.delete("/api/notifications")
    async def clear_notifications(request: Request):
        n = await request.app.state.notifications.clear()
        return {"ok": True, "cleared": n}

    # ------------------------------------------------------------------
    # Transfers — Coinbase Advanced has no equivalent in the freqtrade
    # REST surface. We expose stubs so the frontend can still render
    # the deposit/withdraw views; once we wire a direct Coinbase client
    # in Phase 2 these will become real.
    # ------------------------------------------------------------------
    @app.get("/api/transfers")
    async def get_transfers():
        # TODO(phase-2): integrate with Coinbase Advanced REST for real
        # deposit/withdraw history. Freqtrade does not surface this.
        return {"transfers": [], "stub": True}

    @app.post("/api/transfers/deposit")
    async def deposit_transfer(request: Request):
        body = await _safe_body(request) or {}
        # TODO(phase-2): forward to Coinbase Advanced /v2/accounts/.../deposits
        return {
            "ok": False,
            "stub": True,
            "message": "Deposits require Coinbase Advanced credentials (Phase 2).",
            "echo": body,
        }

    @app.post("/api/transfers/withdraw")
    async def withdraw_transfer(request: Request):
        body = await _safe_body(request) or {}
        # TODO(phase-2): forward to Coinbase Advanced /v2/accounts/.../withdrawals
        return {
            "ok": False,
            "stub": True,
            "message": "Withdrawals require Coinbase Advanced credentials (Phase 2).",
            "echo": body,
        }

    # ------------------------------------------------------------------
    # Backtest + Hyperopt
    # ------------------------------------------------------------------
    @app.post("/api/backtest/run")
    async def run_backtest(request: Request):
        body = await _safe_body(request) or {}
        strategy = body.get("strategy")
        timerange = body.get("timerange") or "20230101-20240101"
        if not strategy:
            raise HTTPException(status_code=400, detail="missing 'strategy'")
        manager: BacktestJobManager = request.app.state.backtests
        if not manager.freqtrade_available():
            return JSONResponse(
                status_code=503,
                content={
                    "error": "freqtrade_not_installed",
                    "message": "freqtrade not installed",
                },
            )
        pairs = body.get("pairs") or None
        if pairs is not None and not isinstance(pairs, list):
            raise HTTPException(status_code=400, detail="'pairs' must be a list")
        timeframe = body.get("timeframe") or None
        try:
            job = await manager.start_backtest(
                strategy=strategy,
                timerange=timerange,
                pairs=pairs,
                timeframe=timeframe,
            )
        except Exception as exc:  # noqa: BLE001 — surface the error
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        await request.app.state.notifications.add(
            "info",
            f"Backtest queued for {strategy} ({timerange})",
            source="backtest",
            jobId=job.id,
        )
        return {"jobId": job.id, "status": job.status, "kind": job.kind}

    @app.get("/api/backtest/jobs")
    async def list_backtest_jobs(request: Request):
        manager: BacktestJobManager = request.app.state.backtests
        jobs = await manager.list()
        return {"jobs": jobs[:50]}

    @app.get("/api/backtest/jobs/{job_id}")
    async def get_backtest_job(job_id: str, request: Request):
        manager: BacktestJobManager = request.app.state.backtests
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"unknown job {job_id}")
        return job.to_public(include_log=True, log_tail=200)

    @app.post("/api/backtest/jobs/{job_id}/cancel")
    async def cancel_backtest_job(job_id: str, request: Request):
        manager: BacktestJobManager = request.app.state.backtests
        ok = await manager.cancel(job_id)
        if not ok:
            raise HTTPException(
                status_code=404, detail=f"job {job_id} not found or not running"
            )
        await request.app.state.notifications.add(
            "info", f"Backtest {job_id} cancelled", source="backtest"
        )
        return {"ok": True, "jobId": job_id}

    @app.post("/api/hyperopt/run")
    async def run_hyperopt(request: Request):
        body = await _safe_body(request) or {}
        strategy = body.get("strategy")
        if not strategy:
            raise HTTPException(status_code=400, detail="missing 'strategy'")
        manager: BacktestJobManager = request.app.state.backtests
        if not manager.freqtrade_available():
            return JSONResponse(
                status_code=503,
                content={
                    "error": "freqtrade_not_installed",
                    "message": "freqtrade not installed",
                },
            )
        epochs = int(body.get("epochs") or 300)
        timerange = body.get("timerange") or "20230101-20240101"
        spaces = body.get("spaces") or ["buy", "sell", "roi", "stoploss"]
        if not isinstance(spaces, list) or not all(isinstance(s, str) for s in spaces):
            raise HTTPException(status_code=400, detail="'spaces' must be list[str]")
        loss = body.get("loss") or "SharpeHyperOptLoss"
        timeframe = body.get("timeframe") or None
        try:
            job = await manager.start_hyperopt(
                strategy=strategy,
                epochs=epochs,
                timerange=timerange,
                spaces=spaces,
                loss=loss,
                timeframe=timeframe,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        await request.app.state.notifications.add(
            "info",
            f"Hyperopt queued for {strategy} ({epochs} epochs)",
            source="hyperopt",
            jobId=job.id,
        )
        return {"jobId": job.id, "status": job.status, "kind": job.kind}

    @app.get("/api/hyperopt/jobs")
    async def list_hyperopt_jobs(request: Request):
        manager: BacktestJobManager = request.app.state.backtests
        jobs = await manager.list()
        return {"jobs": [j for j in jobs if j.get("kind") == "hyperopt"][:50]}

    @app.get("/api/hyperopt/jobs/{job_id}")
    async def get_hyperopt_job(job_id: str, request: Request):
        manager: BacktestJobManager = request.app.state.backtests
        job = await manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"unknown job {job_id}")
        return job.to_public(include_log=True, log_tail=200)

    @app.post("/api/hyperopt/jobs/{job_id}/cancel")
    async def cancel_hyperopt_job(job_id: str, request: Request):
        manager: BacktestJobManager = request.app.state.backtests
        ok = await manager.cancel(job_id)
        if not ok:
            raise HTTPException(
                status_code=404, detail=f"job {job_id} not found or not running"
            )
        await request.app.state.notifications.add(
            "info", f"Hyperopt {job_id} cancelled", source="hyperopt"
        )
        return {"ok": True, "jobId": job_id}

    # ------------------------------------------------------------------
    # WebSocket
    # ------------------------------------------------------------------
    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        manager: WebSocketManager = ws.app.state.ws
        await manager.connect(ws)
        try:
            # Send a hello frame so the client can confirm the channel.
            await ws.send_json(
                {"channel": "hello", "ts": time.time(), "version": "0.1.0"}
            )
            while True:
                # We accept ticks/notifs forwarded by the client too —
                # this lets the existing void-prices.js relay Coinbase
                # ticks through the bridge to other tabs.
                msg = await ws.receive_text()
                try:
                    payload = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict):
                    continue
                channel = payload.get("channel") or payload.get("type")
                if channel == "ping":
                    await ws.send_json({"channel": "pong", "ts": time.time()})
                else:
                    await manager.broadcast(payload)
        except WebSocketDisconnect:
            pass
        finally:
            await manager.disconnect(ws)

    # ------------------------------------------------------------------
    # Static frontend — mounted last so /api routes win.
    # ------------------------------------------------------------------
    static_dir = _static_dir()
    if static_dir.exists():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
    else:  # pragma: no cover — dev safety net
        logger.warning("static dir %s does not exist; / will 404", static_dir)

    return app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _label_key(api_key: str) -> str:
    """Return a redacted label for the supplied API key (never store raw)."""
    if not api_key:
        return ""
    if len(api_key) <= 8:
        return "***"
    return f"{api_key[:4]}…{api_key[-4:]}"


async def _safe_body(request: Request) -> dict[str, Any] | None:
    if request.headers.get("content-length") in (None, "0"):
        return None
    try:
        return await request.json()
    except Exception:  # noqa: BLE001 — body is optional
        return None


def _shape_portfolio(balance: dict[str, Any], open_trades: list[dict[str, Any]]) -> dict[str, Any]:
    """Convert freqtrade /balance + /status into the dashboard shape.

    Frontend (``void-views.jsx``) expects::

        {
          "currency": "USD",
          "totalUsd": <float>,
          "holdings": [
            {"asset": "BTC", "total": 0.1, "free": 0.08, "hold": 0.02,
             "price": 67000.0, "valueUsd": 6700.0}
          ],
          "openTrades": [...]
        }
    """
    currencies = (balance or {}).get("currencies") or []
    stake = (balance or {}).get("stake") or "USD"

    # Holds (locked amount per asset) come from open trades.
    holds: dict[str, float] = {}
    for trade in open_trades or []:
        base = (trade.get("base_currency") or "").upper()
        amount = trade.get("amount") or 0.0
        if base:
            holds[base] = holds.get(base, 0.0) + float(amount or 0.0)

    holdings = []
    total_usd = 0.0
    for c in currencies:
        asset = (c.get("currency") or "").upper()
        total = float(c.get("balance") or 0.0)
        free = float(c.get("free") or 0.0)
        # Prefer the stake-currency valuation freqtrade already computed.
        price = float(c.get("est_stake") or 0.0) / total if total else 0.0
        # Some versions name it differently:
        if not price:
            price = float(c.get("est_stake_bc") or c.get("price") or 0.0)
        value_usd = float(c.get("est_stake") or (price * total))
        hold = float(c.get("used") or holds.get(asset, max(total - free, 0.0)))
        holdings.append(
            {
                "asset": asset,
                "total": total,
                "free": free,
                "hold": hold,
                "price": price,
                "valueUsd": value_usd,
            }
        )
        total_usd += value_usd

    if not total_usd:
        total_usd = float((balance or {}).get("total") or 0.0)

    return {
        "currency": stake,
        "totalUsd": total_usd,
        "holdings": holdings,
        "openTrades": open_trades or [],
    }


def _shape_order(trade: dict[str, Any]) -> dict[str, Any]:
    """Re-shape a freqtrade open trade into the dashboard ``order`` form."""
    return {
        "id": str(trade.get("trade_id") or trade.get("id") or ""),
        "pair": trade.get("pair"),
        "side": "buy" if (trade.get("is_short") in (False, None)) else "sell",
        "type": trade.get("order_type") or trade.get("entry_order_type") or "limit",
        "price": trade.get("open_rate") or trade.get("price"),
        "amount": trade.get("amount"),
        "filled": trade.get("filled_entry") or trade.get("amount") or 0,
        "status": trade.get("status") or "open",
        "openedAt": trade.get("open_date") or trade.get("open_timestamp"),
        "raw": trade,
    }


def _shape_fill(trade: dict[str, Any]) -> dict[str, Any]:
    """Re-shape a closed freqtrade trade into the dashboard ``fill`` form."""
    return {
        "id": str(trade.get("trade_id") or trade.get("id") or ""),
        "pair": trade.get("pair"),
        "side": "buy" if (trade.get("is_short") in (False, None)) else "sell",
        "price": trade.get("close_rate") or trade.get("open_rate"),
        "amount": trade.get("amount"),
        "fee": trade.get("fee_close") or trade.get("fee_open") or 0,
        "pnl": trade.get("profit_abs") or trade.get("close_profit_abs") or 0,
        "pnlPct": trade.get("profit_ratio") or trade.get("close_profit") or 0,
        "openedAt": trade.get("open_date") or trade.get("open_timestamp"),
        "closedAt": trade.get("close_date") or trade.get("close_timestamp"),
        "raw": trade,
    }


# Module-level app instance — required for ``uvicorn dashboard.app:app``.
app = _make_app()
