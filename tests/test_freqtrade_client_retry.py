"""Retry behaviour of the FreqtradeClient.

The client retries transient transport errors and 5xx responses with a
short exponential backoff. The behaviour is bounded — after the last
attempt we surface a :class:`FreqtradeError` with status 503 so the
bridge can return ``freqtrade_unreachable``.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from dashboard import freqtrade_client as ft_client_mod
from dashboard.freqtrade_client import FreqtradeClient, FreqtradeError


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Replace the backoff schedule with zeros so tests don't actually sleep."""
    monkeypatch.setattr(ft_client_mod, "RETRY_BACKOFFS", (0.0, 0.0, 0.0))


def test_retries_on_connect_error_then_gives_up():
    calls = {"n": 0}

    def _refuse(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("nope", request=request)

    transport = httpx.MockTransport(_refuse)

    async def _go():
        client = FreqtradeClient(base_url="http://test")
        client._client = httpx.AsyncClient(
            base_url="http://test", transport=transport, timeout=1.0
        )
        try:
            with pytest.raises(FreqtradeError) as excinfo:
                await client.ping()
            assert excinfo.value.status_code == 503
        finally:
            await client.aclose()

    asyncio.run(_go())
    # 1 initial + 3 retries = 4 attempts total
    assert calls["n"] == 4


def test_retries_on_5xx_then_succeeds():
    calls = {"n": 0}

    def _flaky(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, json={"err": "warming up"})
        return httpx.Response(200, json={"status": "pong"})

    transport = httpx.MockTransport(_flaky)

    async def _go():
        client = FreqtradeClient(base_url="http://test")
        client._client = httpx.AsyncClient(
            base_url="http://test", transport=transport, timeout=1.0
        )
        try:
            result = await client.ping()
            assert result == {"status": "pong"}
        finally:
            await client.aclose()

    asyncio.run(_go())
    assert calls["n"] == 3  # two 503s, then a 200


def test_no_retry_on_4xx():
    calls = {"n": 0}

    def _bad_request(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"err": "bad input"})

    transport = httpx.MockTransport(_bad_request)

    async def _go():
        client = FreqtradeClient(base_url="http://test")
        client._client = httpx.AsyncClient(
            base_url="http://test", transport=transport, timeout=1.0
        )
        try:
            with pytest.raises(FreqtradeError) as excinfo:
                await client.ping()
            assert excinfo.value.status_code == 400
        finally:
            await client.aclose()

    asyncio.run(_go())
    assert calls["n"] == 1  # 4xx flows through without retry


def test_aclose_disposes_session():
    """Sessions should be cleanly closeable and reusable."""

    async def _go():
        client = FreqtradeClient(base_url="http://test")
        client._client = httpx.AsyncClient(base_url="http://test", timeout=1.0)
        await client.aclose()
        assert client._client is None
        # Re-aclose must be a no-op
        await client.aclose()

    asyncio.run(_go())
