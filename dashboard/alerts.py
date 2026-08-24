"""Alert Engine — user-defined metric rules with cooldown + channels.

The engine keeps a small SQLite database in ``user_data/alerts.db`` that
holds two tables:

    alerts       — the rules themselves (see :class:`AlertRule`)
    alert_events — history of triggers (capped at 500 rows, oldest trimmed)

Three collaborators own the moving parts:

* :class:`AlertStore` — async wrapper over the SQLite CRUD surface.
* :class:`AlertEvaluator` — given a snapshot of metric values, returns the
  subset of *enabled* rules that fired, honouring cooldown windows and
  crossings (which need the previously observed value per rule).
* :class:`AlertDispatcher` — fans a fired rule out to its configured
  channels: in-app (WebSocket ``{"channel":"alert",…}``), Discord webhook,
  Telegram bot API. All external HTTP is best-effort — a missing env var
  or a network failure never breaks the loop.

The bridge wires them together in a 5s background task; see
``dashboard/app.py``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rule model + supported vocabulary
# ---------------------------------------------------------------------------


VALID_OPS: tuple[str, ...] = (
    "<",
    "<=",
    ">",
    ">=",
    "==",
    "crosses_above",
    "crosses_below",
)

VALID_CHANNELS: tuple[str, ...] = ("inapp", "discord", "telegram")


@dataclass
class AlertRule:
    """One user-defined alert rule."""

    id: str
    name: str
    metric: str  # e.g. "price.BTC-USD", "portfolio.drawdown", "ratio.SOL-USD/ETH-USD"
    op: str  # one of VALID_OPS
    threshold: float
    channels: list[str] = field(default_factory=lambda: ["inapp"])
    enabled: bool = True
    cooldown_seconds: int = 3600
    created_at: float = field(default_factory=time.time)
    last_triggered_at: float | None = None
    trigger_count: int = 0
    last_value: float | None = None  # for crosses_above/below

    def to_public(self) -> dict[str, Any]:
        d = asdict(self)
        # Ensure list is a fresh copy for the caller.
        d["channels"] = list(self.channels)
        return d


# ---------------------------------------------------------------------------
# Metric validation
# ---------------------------------------------------------------------------


def is_valid_metric(name: str) -> bool:
    """Structural validation only — checks the metric name shape.

    The runtime evaluator ignores unknown metrics (they simply do not
    fire), so validation exists to reject typos at rule-creation time.
    """
    if not isinstance(name, str) or not name:
        return False
    if name in {"portfolio.drawdown", "portfolio.equity"}:
        return True
    if name.startswith("price."):
        sym = name[len("price.") :]
        return _is_pair(sym)
    if name.startswith("ratio."):
        rest = name[len("ratio.") :]
        if "/" not in rest:
            return False
        a, b = rest.split("/", 1)
        return _is_pair(a) and _is_pair(b)
    return False


def _is_pair(sym: str) -> bool:
    # accept BTC-USD, ETH/USD, and generic UPPER-only symbols.
    if not sym:
        return False
    for ch in sym:
        if not (ch.isalnum() or ch in "-/"):
            return False
    return True


# ---------------------------------------------------------------------------
# SQLite store
# ---------------------------------------------------------------------------


_SCHEMA = """
CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    metric TEXT NOT NULL,
    op TEXT NOT NULL,
    threshold REAL NOT NULL,
    channels TEXT NOT NULL,          -- comma-separated
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_seconds INTEGER NOT NULL DEFAULT 3600,
    created_at REAL NOT NULL,
    last_triggered_at REAL,
    trigger_count INTEGER NOT NULL DEFAULT 0,
    last_value REAL
);
CREATE TABLE IF NOT EXISTS alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    ts REAL NOT NULL,
    metric_value REAL,
    message TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_ts ON alert_events(ts);
"""


class AlertStore:
    """Async CRUD wrapper around SQLite.

    The stdlib ``sqlite3`` module is synchronous; we wrap every method in
    ``asyncio.to_thread`` so the event loop is never blocked. All work is
    serialised through an internal :class:`asyncio.Lock` — SQLite can
    handle concurrent readers but we keep it simple.
    """

    EVENT_CAP = 500

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = str(db_path)
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        # Initialise schema synchronously — cheap, and callers can await
        # ``list_rules`` immediately after constructing the store.
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    # ------------------------------------------------------------------
    # Rules
    # ------------------------------------------------------------------
    async def list_rules(self) -> list[AlertRule]:
        async with self._lock:
            return await asyncio.to_thread(self._list_rules_sync)

    def _list_rules_sync(self) -> list[AlertRule]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM alerts ORDER BY created_at DESC"
            ).fetchall()
        return [self._row_to_rule(r) for r in rows]

    async def get_rule(self, rule_id: str) -> AlertRule | None:
        async with self._lock:
            return await asyncio.to_thread(self._get_rule_sync, rule_id)

    def _get_rule_sync(self, rule_id: str) -> AlertRule | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM alerts WHERE id = ?", (rule_id,)
            ).fetchone()
        return self._row_to_rule(row) if row else None

    async def create_rule(
        self,
        *,
        name: str,
        metric: str,
        op: str,
        threshold: float,
        channels: Iterable[str] | None = None,
        enabled: bool = True,
        cooldown_seconds: int = 3600,
    ) -> AlertRule:
        rule = AlertRule(
            id="al_" + uuid.uuid4().hex[:10],
            name=name.strip() or "unnamed",
            metric=metric,
            op=op,
            threshold=float(threshold),
            channels=list(channels or ["inapp"]),
            enabled=bool(enabled),
            cooldown_seconds=int(cooldown_seconds),
            created_at=time.time(),
        )
        async with self._lock:
            await asyncio.to_thread(self._insert_rule_sync, rule)
        return rule

    def _insert_rule_sync(self, rule: AlertRule) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO alerts
                    (id, name, metric, op, threshold, channels, enabled,
                     cooldown_seconds, created_at, last_triggered_at,
                     trigger_count, last_value)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rule.id,
                    rule.name,
                    rule.metric,
                    rule.op,
                    rule.threshold,
                    ",".join(rule.channels),
                    1 if rule.enabled else 0,
                    rule.cooldown_seconds,
                    rule.created_at,
                    rule.last_triggered_at,
                    rule.trigger_count,
                    rule.last_value,
                ),
            )
            conn.commit()

    async def update_rule(self, rule_id: str, **patch: Any) -> AlertRule | None:
        """Update a subset of fields. Unknown keys are ignored."""
        allowed = {
            "name",
            "metric",
            "op",
            "threshold",
            "channels",
            "enabled",
            "cooldown_seconds",
            "last_triggered_at",
            "trigger_count",
            "last_value",
        }
        clean: dict[str, Any] = {}
        for k, v in patch.items():
            if k not in allowed:
                continue
            if k == "channels":
                if isinstance(v, str):
                    v = [c.strip() for c in v.split(",") if c.strip()]
                clean[k] = ",".join(v)
            elif k == "enabled":
                clean[k] = 1 if v else 0
            else:
                clean[k] = v
        if not clean:
            return await self.get_rule(rule_id)
        async with self._lock:
            await asyncio.to_thread(self._update_rule_sync, rule_id, clean)
            return await asyncio.to_thread(self._get_rule_sync, rule_id)

    def _update_rule_sync(self, rule_id: str, clean: dict[str, Any]) -> None:
        cols = ", ".join(f"{k} = ?" for k in clean)
        values = list(clean.values()) + [rule_id]
        with self._connect() as conn:
            conn.execute(f"UPDATE alerts SET {cols} WHERE id = ?", values)
            conn.commit()

    async def delete_rule(self, rule_id: str) -> bool:
        async with self._lock:
            return await asyncio.to_thread(self._delete_rule_sync, rule_id)

    def _delete_rule_sync(self, rule_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM alerts WHERE id = ?", (rule_id,))
            conn.commit()
            return cur.rowcount > 0

    @staticmethod
    def _row_to_rule(row: sqlite3.Row) -> AlertRule:
        channels_raw = row["channels"] or ""
        channels = [c.strip() for c in channels_raw.split(",") if c.strip()]
        return AlertRule(
            id=row["id"],
            name=row["name"],
            metric=row["metric"],
            op=row["op"],
            threshold=float(row["threshold"]),
            channels=channels,
            enabled=bool(row["enabled"]),
            cooldown_seconds=int(row["cooldown_seconds"]),
            created_at=float(row["created_at"]),
            last_triggered_at=(
                float(row["last_triggered_at"])
                if row["last_triggered_at"] is not None
                else None
            ),
            trigger_count=int(row["trigger_count"]),
            last_value=(
                float(row["last_value"]) if row["last_value"] is not None else None
            ),
        )

    # ------------------------------------------------------------------
    # Events
    # ------------------------------------------------------------------
    async def record_event(
        self,
        *,
        rule_id: str,
        ts: float,
        metric_value: float | None,
        message: str,
    ) -> dict[str, Any]:
        async with self._lock:
            return await asyncio.to_thread(
                self._record_event_sync,
                rule_id,
                ts,
                metric_value,
                message,
            )

    def _record_event_sync(
        self,
        rule_id: str,
        ts: float,
        metric_value: float | None,
        message: str,
    ) -> dict[str, Any]:
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO alert_events (rule_id, ts, metric_value, message)"
                " VALUES (?, ?, ?, ?)",
                (rule_id, ts, metric_value, message),
            )
            event_id = cur.lastrowid
            # Trim to EVENT_CAP rows — keep the newest.
            conn.execute(
                """
                DELETE FROM alert_events WHERE id IN (
                    SELECT id FROM alert_events
                    ORDER BY ts DESC LIMIT -1 OFFSET ?
                )
                """,
                (self.EVENT_CAP,),
            )
            conn.commit()
        return {
            "id": event_id,
            "rule_id": rule_id,
            "ts": ts,
            "metric_value": metric_value,
            "message": message,
        }

    async def list_events(self, limit: int = 50) -> list[dict[str, Any]]:
        async with self._lock:
            return await asyncio.to_thread(self._list_events_sync, limit)

    def _list_events_sync(self, limit: int) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM alert_events ORDER BY ts DESC LIMIT ?",
                (max(1, int(limit)),),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "rule_id": r["rule_id"],
                "ts": float(r["ts"]),
                "metric_value": (
                    float(r["metric_value"]) if r["metric_value"] is not None else None
                ),
                "message": r["message"],
            }
            for r in rows
        ]


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


@dataclass
class TriggeredEvent:
    """A rule that just fired (before the dispatcher sends it)."""

    rule: AlertRule
    value: float
    previous_value: float | None
    ts: float
    message: str


class AlertEvaluator:
    """Pure evaluation logic — does not touch I/O beyond the store.

    ``evaluate(metric_values)`` returns the subset of enabled rules that
    should fire *now*, applying the cooldown window and — for
    crossings — the previously observed metric value. Callers that want
    persistence should await :meth:`mark_triggered` for each returned
    event before invoking the dispatcher.
    """

    def __init__(self, store: AlertStore) -> None:
        self._store = store

    async def evaluate(
        self,
        metric_values: dict[str, float],
        *,
        now: float | None = None,
    ) -> list[TriggeredEvent]:
        now = now if now is not None else time.time()
        rules = await self._store.list_rules()
        fired: list[TriggeredEvent] = []
        for rule in rules:
            if not rule.enabled:
                continue
            if rule.metric not in metric_values:
                continue
            value = metric_values[rule.metric]
            previous = rule.last_value
            triggered = _rule_hit(rule, value, previous)
            if not triggered:
                # Still refresh last_value so future crossings work.
                if previous != value:
                    await self._store.update_rule(rule.id, last_value=value)
                continue
            # Cooldown check
            if (
                rule.last_triggered_at is not None
                and rule.cooldown_seconds > 0
                and (now - rule.last_triggered_at) < rule.cooldown_seconds
            ):
                # cooldown active — do not fire, but still update last_value
                # so we don't re-detect the same crossing forever.
                await self._store.update_rule(rule.id, last_value=value)
                continue
            fired.append(
                TriggeredEvent(
                    rule=rule,
                    value=value,
                    previous_value=previous,
                    ts=now,
                    message=_format_message(rule, value),
                )
            )
        return fired

    async def mark_triggered(self, event: TriggeredEvent) -> None:
        """Persist the trigger: bump counters + record the event row."""
        await self._store.update_rule(
            event.rule.id,
            last_triggered_at=event.ts,
            trigger_count=event.rule.trigger_count + 1,
            last_value=event.value,
        )
        await self._store.record_event(
            rule_id=event.rule.id,
            ts=event.ts,
            metric_value=event.value,
            message=event.message,
        )


def _rule_hit(rule: AlertRule, value: float, previous: float | None) -> bool:
    op = rule.op
    thr = rule.threshold
    if op == "<":
        return value < thr
    if op == "<=":
        return value <= thr
    if op == ">":
        return value > thr
    if op == ">=":
        return value >= thr
    if op == "==":
        return value == thr
    if op == "crosses_above":
        return previous is not None and previous <= thr < value
    if op == "crosses_below":
        return previous is not None and previous >= thr > value
    return False


def _format_message(rule: AlertRule, value: float) -> str:
    return (
        f"{rule.name}: {rule.metric} {rule.op} {rule.threshold} "
        f"(current {_fmt_num(value)})"
    )


def _fmt_num(v: float) -> str:
    if abs(v) >= 1000:
        return f"{v:,.2f}"
    if abs(v) >= 1:
        return f"{v:.4f}"
    return f"{v:.6f}"


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


DISCORD_WEBHOOK_ENV = "DISCORD_WEBHOOK_URL"
TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN"
TELEGRAM_CHAT_ENV = "TELEGRAM_CHAT_ID"


class AlertDispatcher:
    """Fan a triggered event out to each configured channel.

    * ``inapp``    — broadcast on the shared :class:`WebSocketManager`
    * ``discord``  — POST to the ``DISCORD_WEBHOOK_URL`` webhook
    * ``telegram`` — POST to the Telegram Bot API's ``sendMessage``

    Missing env vars silently short-circuit the external channels so a
    fresh install has working in-app alerts with no configuration.

    ``http_client`` and ``notification_sink`` are injected to keep tests
    tidy — production wiring lives in ``dashboard/app.py``.
    """

    def __init__(
        self,
        *,
        ws_manager: Any,
        http_client: Any | None = None,
        notification_sink: Any | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self._ws = ws_manager
        self._http = http_client
        self._notif = notification_sink
        self._env = env if env is not None else os.environ

    async def dispatch(self, event: TriggeredEvent) -> dict[str, Any]:
        rule = event.rule
        payload = {
            "channel": "alert",
            "rule_id": rule.id,
            "name": rule.name,
            "metric": rule.metric,
            "op": rule.op,
            "threshold": rule.threshold,
            "value": event.value,
            "message": event.message,
            "ts": event.ts,
            "channels": list(rule.channels),
        }
        results: dict[str, Any] = {}
        for ch in rule.channels:
            ch = (ch or "").lower().strip()
            try:
                if ch == "inapp":
                    results["inapp"] = await self._send_inapp(payload)
                elif ch == "discord":
                    results["discord"] = await self._send_discord(event)
                elif ch == "telegram":
                    results["telegram"] = await self._send_telegram(event)
                else:
                    results[ch] = {"skipped": True, "reason": "unknown_channel"}
            except Exception as exc:  # noqa: BLE001 — never break the loop
                logger.warning(
                    "alert dispatch failed on channel %s for rule %s: %s",
                    ch,
                    rule.id,
                    exc,
                )
                results[ch] = {"error": str(exc)}
        return results

    async def _send_inapp(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._ws is None:
            return {"skipped": True, "reason": "no_ws_manager"}
        await self._ws.broadcast(payload)
        if self._notif is not None:
            try:
                await self._notif.add(
                    "warn",
                    payload["message"],
                    source="alerts",
                    kind="alert",
                    rule_id=payload["rule_id"],
                )
            except Exception:  # noqa: BLE001
                logger.debug("failed adding notification for alert %s", payload["rule_id"])
        return {"ok": True}

    async def _send_discord(self, event: TriggeredEvent) -> dict[str, Any]:
        webhook = self._env.get(DISCORD_WEBHOOK_ENV)
        if not webhook:
            return {"skipped": True, "reason": "no_webhook_configured"}
        if self._http is None:
            return {"skipped": True, "reason": "no_http_client"}
        content = f":rotating_light: **{event.rule.name}** — {event.message}"
        resp = await self._http.post(
            webhook,
            json={"content": content},
            timeout=5.0,
        )
        return {"status": getattr(resp, "status_code", None), "ok": True}

    async def _send_telegram(self, event: TriggeredEvent) -> dict[str, Any]:
        token = self._env.get(TELEGRAM_TOKEN_ENV)
        chat = self._env.get(TELEGRAM_CHAT_ENV)
        if not token or not chat:
            return {"skipped": True, "reason": "no_credentials_configured"}
        if self._http is None:
            return {"skipped": True, "reason": "no_http_client"}
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        text = f"[ALERT] {event.rule.name}\n{event.message}"
        resp = await self._http.post(
            url,
            json={"chat_id": chat, "text": text},
            timeout=5.0,
        )
        return {"status": getattr(resp, "status_code", None), "ok": True}


# ---------------------------------------------------------------------------
# Metric collector
# ---------------------------------------------------------------------------


class MetricCache:
    """Thread-safe cache of the latest metric values.

    * Prices are fed by the WebSocket relay in ``dashboard/app.py`` — the
      frontend forwards Coinbase ticks over ``/ws`` and the receiver
      updates this cache.
    * Portfolio equity + drawdown come from freqtrade's ``/balance``
      response; the background task recomputes them each tick.
    """

    def __init__(self) -> None:
        self._prices: dict[str, float] = {}
        self._equity_hwm: float | None = None
        self._equity: float | None = None
        self._lock = asyncio.Lock()

    async def set_price(self, pair: str, price: float) -> None:
        async with self._lock:
            self._prices[pair] = float(price)

    async def set_equity(self, equity: float) -> None:
        async with self._lock:
            self._equity = float(equity)
            if self._equity_hwm is None or equity > self._equity_hwm:
                self._equity_hwm = float(equity)

    async def snapshot(self) -> dict[str, float]:
        """Return a metric-values dict shaped like the evaluator expects."""
        async with self._lock:
            values: dict[str, float] = {}
            for pair, price in self._prices.items():
                values[f"price.{pair}"] = price
            if self._equity is not None:
                values["portfolio.equity"] = self._equity
                if self._equity_hwm and self._equity_hwm > 0:
                    dd = (self._equity_hwm - self._equity) / self._equity_hwm * 100.0
                    values["portfolio.drawdown"] = dd
                else:
                    values["portfolio.drawdown"] = 0.0
            # Ratios of the shape ``ratio.A/B`` are computed on demand
            # rather than stored — every price pair in the cache could
            # combine with every other, so it would be O(n²) to precompute.
            # See :meth:`ratio` for the helper used by the collector.
            return values

    async def ratio(self, num: str, den: str) -> float | None:
        async with self._lock:
            a = self._prices.get(num)
            b = self._prices.get(den)
        if a is None or b is None or b == 0:
            return None
        return a / b


async def snapshot_with_ratios(
    cache: MetricCache,
    rule_metrics: Iterable[str],
) -> dict[str, float]:
    """Return a snapshot plus any ``ratio.A/B`` values referenced by rules."""
    values = await cache.snapshot()
    for m in rule_metrics:
        if not m.startswith("ratio.") or m in values:
            continue
        rest = m[len("ratio.") :]
        if "/" not in rest:
            continue
        num, den = rest.split("/", 1)
        r = await cache.ratio(num, den)
        if r is not None:
            values[m] = r
    return values
