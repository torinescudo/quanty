"""Bridge unit tests (mocking the Freqtrade REST API with httpx)."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient


# Ensure the bridge does not pick up real env-based credentials.
os.environ.pop("FREQTRADE_USER", None)
os.environ.pop("FREQTRADE_PASS", None)
os.environ.setdefault("FREQTRADE_URL", "http://test-freqtrade")


from dashboard.app import app  # noqa: E402 — imported after env setup
from dashboard.freqtrade_client import FreqtradeClient  # noqa: E402


# ---------------------------------------------------------------------------
# httpx mock plumbing — we patch the AsyncClient inside the FreqtradeClient.
# ---------------------------------------------------------------------------


class _Router:
    """Minimal request router for httpx.MockTransport."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], httpx.Response] = {}
        self.calls: list[tuple[str, str, Any]] = []

    def add(self, method: str, path: str, *, status: int = 200, json: Any = None) -> None:
        self.routes[(method.upper(), path)] = httpx.Response(status, json=json)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body: Any = None
        if request.content:
            try:
                body = request.content.decode()
            except UnicodeDecodeError:
                body = request.content
        self.calls.append((request.method, request.url.path, body))
        key = (request.method, request.url.path)
        if key in self.routes:
            return self.routes[key]
        return httpx.Response(404, json={"error": f"no mock for {key}"})


@contextmanager
def _patched_client(router: _Router):
    """Replace the FreqtradeClient httpx.AsyncClient with a MockTransport one."""
    transport = httpx.MockTransport(router)
    original = FreqtradeClient._get_client

    def _patched(self: FreqtradeClient) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url.rstrip("/"),
                timeout=self.timeout,
                transport=transport,
            )
        return self._client

    FreqtradeClient._get_client = _patched  # type: ignore[assignment]
    try:
        yield
    finally:
        FreqtradeClient._get_client = original  # type: ignore[assignment]


@contextmanager
def _unreachable_client():
    """Simulate freqtrade being down: every request raises ConnectError."""

    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    transport = httpx.MockTransport(_raise)
    original = FreqtradeClient._get_client

    def _patched(self: FreqtradeClient) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url.rstrip("/"),
                timeout=self.timeout,
                transport=transport,
            )
        return self._client

    FreqtradeClient._get_client = _patched  # type: ignore[assignment]
    try:
        yield
    finally:
        FreqtradeClient._get_client = original  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_healthz(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_portfolio_shape(client):
    router = _Router()
    router.add(
        "GET",
        "/api/v1/balance",
        json={
            "stake": "USD",
            "currencies": [
                {
                    "currency": "BTC",
                    "balance": 0.5,
                    "free": 0.4,
                    "used": 0.1,
                    "est_stake": 33500.0,
                },
                {
                    "currency": "USD",
                    "balance": 1000.0,
                    "free": 1000.0,
                    "used": 0.0,
                    "est_stake": 1000.0,
                },
            ],
            "total": 34500.0,
        },
    )
    router.add("GET", "/api/v1/status", json=[])

    with _patched_client(router):
        resp = client.get("/api/portfolio")

    assert resp.status_code == 200
    body = resp.json()
    assert body["currency"] == "USD"
    assert body["totalUsd"] == pytest.approx(34500.0)
    assets = {h["asset"]: h for h in body["holdings"]}
    assert set(assets) == {"BTC", "USD"}
    assert assets["BTC"]["valueUsd"] == pytest.approx(33500.0)
    assert assets["BTC"]["price"] == pytest.approx(67000.0)
    assert assets["BTC"]["hold"] == pytest.approx(0.1)
    assert body["openTrades"] == []


def test_post_orders_forwards_to_forceenter(client):
    router = _Router()
    router.add(
        "POST",
        "/api/v1/forceenter",
        json={"status": "Order signal for BTC/USD created", "trade_id": 7},
    )

    with _patched_client(router):
        resp = client.post(
            "/api/orders",
            json={"pair": "BTC/USD", "side": "buy", "price": 67000.0, "stakeAmount": 100.0},
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["result"]["trade_id"] == 7

    # Verify the request actually hit forceenter with the expected payload.
    call = next(c for c in router.calls if c[1] == "/api/v1/forceenter")
    assert call[0] == "POST"
    assert "BTC/USD" in call[2]
    assert "long" in call[2]


def test_orders_get_returns_open_trades(client):
    router = _Router()
    router.add(
        "GET",
        "/api/v1/status",
        json=[
            {
                "trade_id": 11,
                "pair": "ETH/USD",
                "is_short": False,
                "open_rate": 3500.0,
                "amount": 0.05,
                "status": "open",
                "open_date": "2026-05-01T12:00:00Z",
            }
        ],
    )

    with _patched_client(router):
        resp = client.get("/api/orders")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["orders"]) == 1
    o = body["orders"][0]
    assert o["pair"] == "ETH/USD"
    assert o["id"] == "11"
    assert o["side"] == "buy"
    assert o["price"] == 3500.0


def test_fills_unwraps_trades_envelope(client):
    router = _Router()
    router.add(
        "GET",
        "/api/v1/trades",
        json={
            "trades": [
                {
                    "trade_id": 3,
                    "pair": "BTC/USD",
                    "is_short": False,
                    "open_rate": 65000.0,
                    "close_rate": 67000.0,
                    "amount": 0.01,
                    "profit_abs": 20.0,
                    "profit_ratio": 0.0307,
                    "open_date": "2026-04-30T10:00:00Z",
                    "close_date": "2026-05-01T11:00:00Z",
                }
            ],
            "trades_count": 1,
        },
    )

    with _patched_client(router):
        resp = client.get("/api/fills")

    assert resp.status_code == 200
    fills = resp.json()["fills"]
    assert len(fills) == 1
    f = fills[0]
    assert f["pair"] == "BTC/USD"
    assert f["price"] == 67000.0
    assert f["pnl"] == 20.0


def test_connection_test_503_when_freqtrade_down(client):
    with _unreachable_client():
        resp = client.get("/api/connection/test")
    assert resp.status_code == 503
    body = resp.json()
    assert body["error"] == "freqtrade_unreachable"
    assert "unreachable" in body["message"].lower()


def test_portfolio_503_when_freqtrade_down(client):
    with _unreachable_client():
        resp = client.get("/api/portfolio")
    assert resp.status_code == 503
    assert resp.json()["error"] == "freqtrade_unreachable"


def test_notifications_lifecycle(client):
    # Trigger one notification by hitting /api/connect (which adds one).
    router = _Router()
    router.add("GET", "/api/v1/ping", json={"status": "pong"})
    with _patched_client(router):
        connect_resp = client.post("/api/connect", json={"apiKey": "abcd1234efgh5678"})
    assert connect_resp.status_code == 200

    listed = client.get("/api/notifications")
    assert listed.status_code == 200
    items = listed.json()["notifications"]
    assert any("Connected" in i["message"] for i in items)
    assert all(not i["read"] for i in items)

    read_all = client.post("/api/notifications/read-all")
    assert read_all.status_code == 200
    assert read_all.json()["updated"] >= 1

    cleared = client.delete("/api/notifications")
    assert cleared.status_code == 200
    assert cleared.json()["cleared"] >= 1

    after = client.get("/api/notifications").json()["notifications"]
    assert after == []


def test_strategies_listing(client):
    router = _Router()
    router.add("GET", "/api/v1/strategies", json={"strategies": ["SmaCross", "BollingerRevert"]})
    router.add(
        "GET",
        "/api/v1/show_config",
        json={"strategy": "SmaCross", "state": "running"},
    )

    with _patched_client(router):
        resp = client.get("/api/strategies")

    assert resp.status_code == 200
    body = resp.json()
    assert body["active"] == "SmaCross"
    by_id = {s["id"]: s for s in body["strategies"]}
    assert by_id["SmaCross"]["status"] == "running"
    assert by_id["BollingerRevert"]["status"] == "stopped"


def test_strategy_status_action(client):
    router = _Router()
    router.add("POST", "/api/v1/stop", json={"status": "stopping..."})

    with _patched_client(router):
        resp = client.post("/api/strategies/SmaCross/status", json={"status": "stop"})

    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_transfers_stub(client):
    resp = client.get("/api/transfers")
    assert resp.status_code == 200
    body = resp.json()
    assert body["transfers"] == []
    assert body["stub"] is True

    deposit = client.post("/api/transfers/deposit", json={"amount": 100, "asset": "USD"})
    assert deposit.status_code == 200
    assert deposit.json()["stub"] is True
    assert deposit.json()["ok"] is False


def test_static_index_served(client):
    resp = client.get("/")
    assert resp.status_code == 200
    # The frontend bootstraps via index.html which references void-mount.jsx.
    assert "void-mount" in resp.text or "<html" in resp.text.lower()
