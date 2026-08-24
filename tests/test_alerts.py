"""Tests for the Alert Engine.

Covers the SQLite CRUD layer, the evaluator's operator and cooldown
semantics, the dispatcher's channel plumbing (with mocked httpx +
WebSocket manager), and the REST validation surface exposed by the
bridge.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


# Ensure the bridge does not pick up real env-based credentials or
# outbound webhooks during tests.
os.environ.pop("FREQTRADE_USER", None)
os.environ.pop("FREQTRADE_PASS", None)
os.environ.pop("DISCORD_WEBHOOK_URL", None)
os.environ.pop("TELEGRAM_BOT_TOKEN", None)
os.environ.pop("TELEGRAM_CHAT_ID", None)
os.environ.setdefault("FREQTRADE_URL", "http://test-freqtrade")


from dashboard.alerts import (  # noqa: E402
    AlertDispatcher,
    AlertEvaluator,
    AlertStore,
    TriggeredEvent,
)


# ---------------------------------------------------------------------------
# CRUD tests
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> AlertStore:
    return AlertStore(tmp_path / "alerts.db")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_store_create_and_list(store: AlertStore) -> None:
    assert _run(store.list_rules()) == []
    rule = _run(
        store.create_rule(
            name="BTC low",
            metric="price.BTC-USD",
            op="<",
            threshold=50_000,
            channels=["inapp"],
        )
    )
    assert rule.id.startswith("al_")
    listed = _run(store.list_rules())
    assert len(listed) == 1
    assert listed[0].name == "BTC low"
    assert listed[0].channels == ["inapp"]
    assert listed[0].enabled is True


def test_store_update_and_delete(store: AlertStore) -> None:
    rule = _run(
        store.create_rule(
            name="ETH high",
            metric="price.ETH-USD",
            op=">",
            threshold=4000,
            channels=["inapp", "discord"],
        )
    )
    updated = _run(
        store.update_rule(
            rule.id, enabled=False, threshold=4200, channels=["inapp"]
        )
    )
    assert updated is not None
    assert updated.enabled is False
    assert updated.threshold == 4200
    assert updated.channels == ["inapp"]

    ok = _run(store.delete_rule(rule.id))
    assert ok is True
    assert _run(store.get_rule(rule.id)) is None
    ok_again = _run(store.delete_rule(rule.id))
    assert ok_again is False


def test_store_events_are_capped(store: AlertStore, monkeypatch) -> None:
    monkeypatch.setattr(AlertStore, "EVENT_CAP", 5, raising=False)
    rule = _run(
        store.create_rule(
            name="cap test", metric="price.BTC-USD", op="<", threshold=1
        )
    )
    for i in range(20):
        _run(
            store.record_event(
                rule_id=rule.id, ts=float(i), metric_value=float(i), message=f"m{i}"
            )
        )
    events = _run(store.list_events(limit=100))
    assert len(events) == 5
    # newest first
    assert events[0]["message"] == "m19"
    assert events[-1]["message"] == "m15"


# ---------------------------------------------------------------------------
# Evaluator tests
# ---------------------------------------------------------------------------


def test_evaluator_fires_on_lt(store: AlertStore) -> None:
    rule = _run(
        store.create_rule(
            name="btc lt", metric="price.BTC-USD", op="<", threshold=50_000
        )
    )
    ev = AlertEvaluator(store)
    fired = _run(ev.evaluate({"price.BTC-USD": 49_000}, now=1000.0))
    assert len(fired) == 1
    assert fired[0].rule.id == rule.id
    assert fired[0].value == 49_000

    # No fire when above threshold
    fired2 = _run(ev.evaluate({"price.BTC-USD": 51_000}, now=1001.0))
    assert fired2 == []


def test_evaluator_crosses_above_needs_previous(store: AlertStore) -> None:
    _run(
        store.create_rule(
            name="cross up",
            metric="price.SOL-USD",
            op="crosses_above",
            threshold=100.0,
            cooldown_seconds=0,
        )
    )
    ev = AlertEvaluator(store)

    # First observation seeds last_value, does not fire because previous is None.
    fired = _run(ev.evaluate({"price.SOL-USD": 95.0}, now=100.0))
    assert fired == []

    # Still below → no fire
    fired = _run(ev.evaluate({"price.SOL-USD": 99.0}, now=101.0))
    assert fired == []

    # Now crosses the threshold from below → fires
    fired = _run(ev.evaluate({"price.SOL-USD": 101.0}, now=102.0))
    assert len(fired) == 1
    assert fired[0].previous_value == 99.0

    # persist trigger, so cooldown machinery kicks in
    _run(ev.mark_triggered(fired[0]))

    # A subsequent tick that stays above should not re-fire (already
    # crossed) — previous is now 101.0 which is not <= threshold.
    fired = _run(ev.evaluate({"price.SOL-USD": 105.0}, now=103.0))
    assert fired == []


def test_evaluator_cooldown_suppresses_second_fire(store: AlertStore) -> None:
    rule = _run(
        store.create_rule(
            name="dd", metric="portfolio.drawdown", op=">", threshold=10.0,
            cooldown_seconds=3600,
        )
    )
    ev = AlertEvaluator(store)

    fired1 = _run(ev.evaluate({"portfolio.drawdown": 12.0}, now=1000.0))
    assert len(fired1) == 1
    _run(ev.mark_triggered(fired1[0]))

    # Still above threshold but within cooldown → suppressed
    fired2 = _run(ev.evaluate({"portfolio.drawdown": 15.0}, now=1500.0))
    assert fired2 == []

    # After cooldown → fires again
    fired3 = _run(ev.evaluate({"portfolio.drawdown": 15.0}, now=1000.0 + 3601))
    assert len(fired3) == 1
    assert fired3[0].rule.id == rule.id


def test_evaluator_skips_disabled_rules(store: AlertStore) -> None:
    rule = _run(
        store.create_rule(
            name="off", metric="price.BTC-USD", op="<", threshold=100_000
        )
    )
    _run(store.update_rule(rule.id, enabled=False))
    ev = AlertEvaluator(store)
    fired = _run(ev.evaluate({"price.BTC-USD": 100}, now=1.0))
    assert fired == []


# ---------------------------------------------------------------------------
# Dispatcher tests
# ---------------------------------------------------------------------------


class _RecordingWS:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def broadcast(self, msg: dict[str, Any]) -> None:
        self.messages.append(msg)


class _FakeResponse:
    def __init__(self, status_code: int = 200) -> None:
        self.status_code = status_code


class _RecordingHttp:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, json=None, timeout=None) -> _FakeResponse:
        self.calls.append({"url": url, "json": json, "timeout": timeout})
        return _FakeResponse(200)


def _make_event(rule, value=100.0):
    return TriggeredEvent(
        rule=rule,
        value=value,
        previous_value=None,
        ts=1234567.0,
        message=f"{rule.name}: current {value}",
    )


def test_dispatcher_inapp_broadcasts_over_ws(store: AlertStore) -> None:
    ws = _RecordingWS()
    dispatcher = AlertDispatcher(ws_manager=ws, http_client=None, env={})
    rule = _run(
        store.create_rule(
            name="broadcast",
            metric="price.BTC-USD",
            op="<",
            threshold=50000,
            channels=["inapp"],
        )
    )
    result = _run(dispatcher.dispatch(_make_event(rule, 49000.0)))
    assert result["inapp"]["ok"] is True
    assert len(ws.messages) == 1
    msg = ws.messages[0]
    assert msg["channel"] == "alert"
    assert msg["rule_id"] == rule.id
    assert msg["value"] == 49000.0
    assert msg["name"] == "broadcast"


def test_dispatcher_discord_posts_correct_payload(store: AlertStore) -> None:
    ws = _RecordingWS()
    http = _RecordingHttp()
    env = {"DISCORD_WEBHOOK_URL": "https://discord.example/webhook/xyz"}
    dispatcher = AlertDispatcher(
        ws_manager=ws, http_client=http, env=env
    )
    rule = _run(
        store.create_rule(
            name="dc",
            metric="price.BTC-USD",
            op="<",
            threshold=50000,
            channels=["discord"],
        )
    )
    _run(dispatcher.dispatch(_make_event(rule, 49000.0)))
    assert len(http.calls) == 1
    call = http.calls[0]
    assert call["url"] == "https://discord.example/webhook/xyz"
    assert "content" in call["json"]
    assert "dc" in call["json"]["content"]


def test_dispatcher_telegram_posts_correct_payload(store: AlertStore) -> None:
    ws = _RecordingWS()
    http = _RecordingHttp()
    env = {
        "TELEGRAM_BOT_TOKEN": "12345:ABC",
        "TELEGRAM_CHAT_ID": "987654321",
    }
    dispatcher = AlertDispatcher(ws_manager=ws, http_client=http, env=env)
    rule = _run(
        store.create_rule(
            name="tg",
            metric="portfolio.drawdown",
            op=">",
            threshold=10.0,
            channels=["telegram"],
        )
    )
    _run(dispatcher.dispatch(_make_event(rule, 12.5)))
    assert len(http.calls) == 1
    call = http.calls[0]
    assert call["url"] == "https://api.telegram.org/bot12345:ABC/sendMessage"
    assert call["json"]["chat_id"] == "987654321"
    assert "tg" in call["json"]["text"]


def test_dispatcher_channels_without_env_are_noop(store: AlertStore) -> None:
    ws = _RecordingWS()
    http = _RecordingHttp()
    # empty env → both external channels short-circuit gracefully
    dispatcher = AlertDispatcher(ws_manager=ws, http_client=http, env={})
    rule = _run(
        store.create_rule(
            name="quiet",
            metric="price.ETH-USD",
            op=">",
            threshold=1,
            channels=["discord", "telegram"],
        )
    )
    result = _run(dispatcher.dispatch(_make_event(rule, 5000.0)))
    assert http.calls == []
    assert result["discord"]["skipped"] is True
    assert result["telegram"]["skipped"] is True


# ---------------------------------------------------------------------------
# Bridge REST endpoint tests
# ---------------------------------------------------------------------------


@pytest.fixture
def bridge_client(tmp_path, monkeypatch):
    """Fresh bridge TestClient with an isolated alerts.db.

    Points the app's ``_project_root`` at a scratch dir so the alerts
    engine writes to a temp SQLite file per test.
    """
    from dashboard import app as bridge_app

    userdir = tmp_path / "userdata"
    userdir.mkdir()
    monkeypatch.setattr(bridge_app, "_project_root", lambda: tmp_path)

    with TestClient(bridge_app.app) as c:
        yield c


def test_create_alert_rejects_bad_metric(bridge_client):
    resp = bridge_client.post(
        "/api/alerts",
        json={
            "name": "bad",
            "metric": "totally.made.up",
            "op": "<",
            "threshold": 1,
            "channels": ["inapp"],
        },
    )
    assert resp.status_code == 400
    assert "invalid metric" in resp.json()["detail"].lower()


def test_create_alert_rejects_bad_op(bridge_client):
    resp = bridge_client.post(
        "/api/alerts",
        json={
            "name": "bad",
            "metric": "price.BTC-USD",
            "op": "??",
            "threshold": 1,
            "channels": ["inapp"],
        },
    )
    assert resp.status_code == 400
    assert "invalid op" in resp.json()["detail"].lower()


def test_alerts_crud_end_to_end(bridge_client):
    # Empty listing
    resp = bridge_client.get("/api/alerts")
    assert resp.status_code == 200
    assert resp.json() == {"rules": []}

    # Create
    create = bridge_client.post(
        "/api/alerts",
        json={
            "name": "BTC dip",
            "metric": "price.BTC-USD",
            "op": "<",
            "threshold": 50000,
            "channels": ["inapp"],
            "cooldown_seconds": 60,
        },
    )
    assert create.status_code == 200
    rule = create.json()["rule"]
    rid = rule["id"]

    # Listing includes it
    lst = bridge_client.get("/api/alerts").json()
    assert len(lst["rules"]) == 1
    assert lst["rules"][0]["id"] == rid

    # Patch
    patch = bridge_client.patch(
        f"/api/alerts/{rid}",
        json={"enabled": False, "threshold": 45000},
    )
    assert patch.status_code == 200
    assert patch.json()["rule"]["enabled"] is False
    assert patch.json()["rule"]["threshold"] == 45000

    # Delete
    dele = bridge_client.delete(f"/api/alerts/{rid}")
    assert dele.status_code == 200
    assert dele.json()["ok"] is True

    # 404 on second delete
    again = bridge_client.delete(f"/api/alerts/{rid}")
    assert again.status_code == 404


def test_alert_events_endpoint(bridge_client):
    create = bridge_client.post(
        "/api/alerts",
        json={
            "name": "hist",
            "metric": "price.BTC-USD",
            "op": "<",
            "threshold": 100000,
            "channels": ["inapp"],
        },
    )
    rid = create.json()["rule"]["id"]
    # Trigger via test endpoint
    test = bridge_client.post(f"/api/alerts/test/{rid}")
    assert test.status_code == 200

    events = bridge_client.get("/api/alerts/events?limit=10").json()["events"]
    assert len(events) >= 1
    assert events[0]["rule_id"] == rid
