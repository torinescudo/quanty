"""Health and readiness probes.

``/healthz`` is a pure liveness check — it must respond 200 even when
freqtrade is unavailable. ``/readyz`` actively probes freqtrade and is
the signal that orchestrators (compose ``depends_on: healthy``, k8s
readiness probes) should use to decide whether to route traffic.
"""

from __future__ import annotations

import os

import httpx
import pytest
from fastapi.testclient import TestClient


os.environ.pop("FREQTRADE_USER", None)
os.environ.pop("FREQTRADE_PASS", None)
os.environ.setdefault("FREQTRADE_URL", "http://test-freqtrade")


from dashboard import freqtrade_client as ft_client_mod  # noqa: E402
from dashboard.app import app  # noqa: E402
from dashboard.freqtrade_client import FreqtradeClient  # noqa: E402


@pytest.fixture(autouse=True)
def _fast_retry(monkeypatch):
    # Keep readyz / metrics fast on the down path — three full backoffs
    # (0.5+1+2s) per call quickly add up across tests.
    monkeypatch.setattr(ft_client_mod, "RETRY_BACKOFFS", (0.0, 0.0, 0.0))


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _install_transport(transport: httpx.MockTransport):
    """Replace the FreqtradeClient httpx.AsyncClient with one bound to ``transport``."""
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
    return original


def _restore(original):
    FreqtradeClient._get_client = original  # type: ignore[assignment]


def test_healthz_does_not_touch_freqtrade(client):
    """/healthz must answer 200 regardless of freqtrade state."""

    def _refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope", request=request)

    transport = httpx.MockTransport(_refuse)
    original = _install_transport(transport)
    try:
        resp = client.get("/healthz")
    finally:
        _restore(original)

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_readyz_ok_when_freqtrade_reachable(client):
    def _ok(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/ping"
        return httpx.Response(200, json={"status": "pong"})

    transport = httpx.MockTransport(_ok)
    original = _install_transport(transport)
    try:
        resp = client.get("/readyz")
    finally:
        _restore(original)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["freqtrade_reachable"] is True


def test_readyz_503_when_freqtrade_down(client):
    def _refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    transport = httpx.MockTransport(_refuse)
    original = _install_transport(transport)
    try:
        resp = client.get("/readyz")
    finally:
        _restore(original)

    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "not_ready"
    assert body["freqtrade_reachable"] is False
    assert "reason" in body


def test_metrics_shape(client):
    def _ok(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "pong"})

    transport = httpx.MockTransport(_ok)
    original = _install_transport(transport)
    try:
        resp = client.get("/metrics")
    finally:
        _restore(original)

    assert resp.status_code == 200
    body = resp.json()
    for key in ("version", "uptime_seconds", "freqtrade_reachable", "jobs_running", "jobs_total", "ws_clients"):
        assert key in body
    assert body["freqtrade_reachable"] is True
    assert isinstance(body["uptime_seconds"], (int, float))
    assert body["uptime_seconds"] >= 0


def test_request_id_header_round_trip(client):
    """The request-ID middleware echoes a supplied header and synthesises one otherwise."""
    resp = client.get("/healthz", headers={"X-Request-ID": "abc-123"})
    assert resp.status_code == 200
    assert resp.headers.get("X-Request-ID") == "abc-123"

    resp2 = client.get("/healthz")
    assert resp2.status_code == 200
    rid = resp2.headers.get("X-Request-ID")
    assert rid and rid != "abc-123" and len(rid) >= 8
