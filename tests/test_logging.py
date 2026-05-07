"""Tests for the structured-logging configuration."""

from __future__ import annotations

import io
import json
import logging

import pytest

from dashboard import logging_config


@pytest.fixture
def fresh_logging(monkeypatch):
    """Reset the module-level idempotency flag and capture root handlers."""
    monkeypatch.setattr(logging_config, "_CONFIGURED", False)
    root = logging.getLogger()
    saved_handlers = root.handlers[:]
    saved_level = root.level
    yield
    # Restore the original handlers so other tests are not affected.
    for h in list(root.handlers):
        root.removeHandler(h)
    for h in saved_handlers:
        root.addHandler(h)
    root.setLevel(saved_level)
    monkeypatch.setattr(logging_config, "_CONFIGURED", False)


def _capture_one_record(level: int = logging.INFO):
    """Install the JSON formatter on a fresh stream and return the parsed line."""
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging_config.JsonFormatter())
    handler.setLevel(level)

    logger = logging.getLogger("quanty.test")
    logger.handlers = [handler]
    logger.setLevel(level)
    logger.propagate = False
    return logger, buf


def test_format_emits_parseable_json(fresh_logging):
    logger, buf = _capture_one_record()
    logger.info("hello world", extra={"job_id": "abc"})

    line = buf.getvalue().strip()
    payload = json.loads(line)

    assert payload["level"] == "INFO"
    assert payload["logger"] == "quanty.test"
    assert payload["msg"] == "hello world"
    assert payload["job_id"] == "abc"
    # ts must be ISO-8601 UTC with the trailing Z marker.
    assert payload["ts"].endswith("Z")
    assert "module" in payload and "line" in payload
    assert isinstance(payload["line"], int)


def test_format_includes_request_id_when_set(fresh_logging):
    logger, buf = _capture_one_record()

    token = logging_config.set_request_id("req-xyz")
    try:
        logger.info("with rid")
    finally:
        logging_config.reset_request_id(token)

    payload = json.loads(buf.getvalue().strip())
    assert payload["request_id"] == "req-xyz"


def test_format_handles_non_json_serializable_extras(fresh_logging):
    logger, buf = _capture_one_record()

    class Thing:
        def __repr__(self) -> str:
            return "<Thing>"

    logger.info("weird", extra={"obj": Thing()})

    payload = json.loads(buf.getvalue().strip())
    assert payload["obj"] == "<Thing>"


def test_configure_logging_is_idempotent(fresh_logging):
    logging_config.configure_logging(level="DEBUG")
    root = logging.getLogger()
    n1 = len(root.handlers)
    assert n1 == 1
    assert root.level == logging.DEBUG

    logging_config.configure_logging(level="INFO")
    n2 = len(root.handlers)
    assert n2 == 1  # no stacking
    assert root.level == logging.INFO


def test_configure_logging_respects_env_level(fresh_logging, monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    logging_config.configure_logging()
    assert logging.getLogger().level == logging.WARNING
