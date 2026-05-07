"""Thin async client for the Freqtrade REST API.

Freqtrade exposes its REST API under ``/api/v1/`` on (by default)
``http://127.0.0.1:8080``. When ``api_server.username`` and
``api_server.password`` are set in ``user_data/config.json``, the client
must authenticate via HTTP Basic against ``/api/v1/token/login`` to get
a JWT ``access_token`` and then send it as ``Authorization: Bearer ...``
on every subsequent call. When credentials are empty, calls go
through unauthenticated.

The client is intentionally tiny — it forwards JSON payloads and lets
the bridge do all the shape-massaging on top.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class FreqtradeError(Exception):
    """Raised when the Freqtrade REST API is unreachable or returns an error."""

    def __init__(self, message: str, status_code: int = 503, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


@dataclass
class FreqtradeClient:
    base_url: str = "http://127.0.0.1:8080"
    username: str | None = None
    password: str | None = None
    timeout: float = 10.0
    _access_token: str | None = field(default=None, init=False, repr=False)
    _refresh_token: str | None = field(default=None, init=False, repr=False)
    _auth_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    @property
    def auth_enabled(self) -> bool:
        return bool(self.username and self.password)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url.rstrip("/"),
                timeout=self.timeout,
            )
        return self._client

    async def _login(self) -> None:
        """Acquire an access + refresh token using HTTP Basic."""
        if not self.auth_enabled:
            return
        client = self._get_client()
        try:
            resp = await client.post(
                "/api/v1/token/login",
                auth=(self.username or "", self.password or ""),
            )
        except httpx.HTTPError as exc:
            raise FreqtradeError(
                f"freqtrade unreachable at {self.base_url}: {exc}",
                status_code=503,
            ) from exc
        if resp.status_code != 200:
            raise FreqtradeError(
                f"freqtrade login failed ({resp.status_code})",
                status_code=resp.status_code,
                payload=_safe_json(resp),
            )
        data = resp.json()
        self._access_token = data.get("access_token")
        self._refresh_token = data.get("refresh_token")

    async def _refresh(self) -> bool:
        """Try to refresh the access token using the refresh token."""
        if not self._refresh_token:
            return False
        client = self._get_client()
        try:
            resp = await client.post(
                "/api/v1/token/refresh",
                headers={"Authorization": f"Bearer {self._refresh_token}"},
            )
        except httpx.HTTPError:
            return False
        if resp.status_code != 200:
            return False
        self._access_token = resp.json().get("access_token")
        return bool(self._access_token)

    async def _ensure_token(self) -> None:
        if not self.auth_enabled:
            return
        async with self._auth_lock:
            if self._access_token is None:
                await self._login()

    def _auth_headers(self) -> dict[str, str]:
        if self._access_token:
            return {"Authorization": f"Bearer {self._access_token}"}
        return {}

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json: Any = None,
    ) -> Any:
        """Generic JSON request. Re-auths on 401 once.

        ``path`` is appended after the configured ``/api/v1`` prefix —
        callers pass e.g. ``"balance"`` or ``"forcebuy"``.
        """
        await self._ensure_token()
        client = self._get_client()
        url = f"/api/v1/{path.lstrip('/')}"

        async def _do_request() -> httpx.Response:
            return await client.request(
                method,
                url,
                params=params,
                json=json,
                headers=self._auth_headers(),
            )

        try:
            resp = await _do_request()
        except httpx.HTTPError as exc:
            raise FreqtradeError(
                f"freqtrade unreachable at {self.base_url}: {exc}",
                status_code=503,
            ) from exc

        if resp.status_code == 401 and self.auth_enabled:
            # token expired — try refresh, then full login
            refreshed = await self._refresh()
            if not refreshed:
                async with self._auth_lock:
                    self._access_token = None
                    await self._login()
            try:
                resp = await _do_request()
            except httpx.HTTPError as exc:
                raise FreqtradeError(
                    f"freqtrade unreachable at {self.base_url}: {exc}",
                    status_code=503,
                ) from exc

        if resp.status_code >= 400:
            raise FreqtradeError(
                f"freqtrade {method} {path} failed ({resp.status_code})",
                status_code=resp.status_code,
                payload=_safe_json(resp),
            )
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    # ------------------------------------------------------------------
    # Convenience wrappers for the endpoints the bridge actually uses.
    # ------------------------------------------------------------------

    async def ping(self) -> Any:
        return await self.request("GET", "ping")

    async def balance(self) -> Any:
        return await self.request("GET", "balance")

    async def status(self) -> Any:
        """Open trades."""
        return await self.request("GET", "status")

    async def trades(self, limit: int = 500) -> Any:
        """Closed trades."""
        return await self.request("GET", "trades", params={"limit": limit})

    async def forcebuy(self, pair: str, price: float | None = None) -> Any:
        payload: dict[str, Any] = {"pair": pair}
        if price is not None:
            payload["price"] = price
        return await self.request("POST", "forcebuy", json=payload)

    async def forceenter(
        self,
        pair: str,
        side: str = "long",
        price: float | None = None,
        order_type: str | None = None,
        stake_amount: float | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"pair": pair, "side": side}
        if price is not None:
            payload["price"] = price
        if order_type is not None:
            payload["ordertype"] = order_type
        if stake_amount is not None:
            payload["stakeamount"] = stake_amount
        return await self.request("POST", "forceenter", json=payload)

    async def forceexit(self, trade_id: str | int) -> Any:
        return await self.request("POST", "forceexit", json={"tradeid": str(trade_id)})

    async def stop(self) -> Any:
        return await self.request("POST", "stop")

    async def start(self) -> Any:
        return await self.request("POST", "start")

    async def reload_config(self) -> Any:
        return await self.request("POST", "reload_config")

    async def show_config(self) -> Any:
        return await self.request("GET", "show_config")

    async def strategies(self) -> Any:
        return await self.request("GET", "strategies")

    async def strategy(self, name: str) -> Any:
        return await self.request("GET", f"strategy/{name}")


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return resp.text
