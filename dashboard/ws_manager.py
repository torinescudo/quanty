"""WebSocket fan-out for the bridge.

The dashboard subscribes to a single ``/ws`` endpoint. The bridge
multiplexes three event families onto it:

    {"channel": "tick",        "pair": "BTC/USD", "price": 67123.4, "ts": ...}
    {"channel": "fill",        "trade_id": 42, "pair": "BTC/USD", ...}
    {"channel": "strategy",    "id": "SmaCross", "status": "running", ...}
    {"channel": "notification","level": "info", "message": "..."}

Phase 1 wires the broadcast plumbing and the relay surface; the real
Coinbase tick relay and Freqtrade event polling are filled in by the
caller in ``app.py`` (and refined in Phase 2).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketManager:
    """Tracks connected websocket clients and broadcasts JSON messages."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)
        logger.info("ws client connected (%d total)", len(self._clients))

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)
        logger.info("ws client disconnected (%d total)", len(self._clients))

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Send ``message`` (as JSON) to every connected client.

        Dead clients are silently dropped.
        """
        if not self._clients:
            return
        payload = json.dumps(message, default=str)
        # Snapshot the set so we can mutate it during iteration.
        async with self._lock:
            targets = list(self._clients)
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_text(payload)
            except Exception as exc:  # noqa: BLE001 — broadcast must be tolerant
                logger.debug("dropping dead ws client: %s", exc)
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    # Convenience helpers — keep call-sites readable.
    async def broadcast_tick(self, pair: str, price: float, ts: float | None = None) -> None:
        await self.broadcast({"channel": "tick", "pair": pair, "price": price, "ts": ts})

    async def broadcast_fill(self, fill: dict[str, Any]) -> None:
        await self.broadcast({"channel": "fill", **fill})

    async def broadcast_strategy(self, strategy: dict[str, Any]) -> None:
        await self.broadcast({"channel": "strategy", **strategy})

    async def broadcast_notification(self, notification: dict[str, Any]) -> None:
        await self.broadcast({"channel": "notification", **notification})
