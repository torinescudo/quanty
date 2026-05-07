"""Structured (JSON) logging configuration for the bridge.

The default Python logging handlers emit human-readable text, which is
fine for ``stdout`` during development but a pain to ingest into log
aggregators (Loki, ELK, Datadog) in production. This module installs a
small JSON formatter — no extra dependency required — and wires the
root logger to ``stdout`` with a level controlled by ``LOG_LEVEL``.

Each record is serialized to a single JSON line with the following
fields::

    ts          ISO-8601 UTC timestamp with millisecond precision
    level       INFO / WARNING / ERROR / ...
    logger      logging name (``dashboard.app`` etc.)
    msg         the log message (already formatted)
    module      source module
    line        source line number
    request_id  optional, present when set via the request middleware

Any extra ``extra={...}`` fields passed to ``logger.info(...)`` are
merged on top of the defaults — that is how the request middleware
attaches a ``request_id`` and how the bridge can attach job ids etc.

Apply once at startup with :func:`configure_logging` (idempotent).
"""

from __future__ import annotations

import contextvars
import datetime as _dt
import json
import logging
import os
import sys
from typing import Any

# Per-request context variable populated by ``RequestIDMiddleware``. We
# expose a tiny accessor so other modules can stamp the current id onto
# their logs without importing FastAPI internals.
_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "request_id", default=None
)


def get_request_id() -> str | None:
    """Return the current request id if a middleware has set one."""
    return _request_id_var.get()


def set_request_id(value: str | None) -> contextvars.Token:
    """Set the current request id, returning the token to reset later."""
    return _request_id_var.set(value)


def reset_request_id(token: contextvars.Token) -> None:
    _request_id_var.reset(token)


# Standard ``LogRecord`` attributes we never want to dump into ``extra``.
_STANDARD_RECORD_ATTRS = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
        "taskName",
    }
)


class JsonFormatter(logging.Formatter):
    """Serialize a ``LogRecord`` as a single JSON line.

    The formatter is dependency-free on purpose — adding
    ``python-json-logger`` for ~70 lines of glue is overkill.
    """

    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        # ``record.getMessage()`` applies %-formatting if args were used.
        ts = _dt.datetime.fromtimestamp(record.created, tz=_dt.timezone.utc)
        payload: dict[str, Any] = {
            "ts": ts.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "module": record.module,
            "line": record.lineno,
        }
        rid = get_request_id()
        if rid:
            payload["request_id"] = rid

        # Surface any structured extras the caller passed via ``extra=``.
        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_ATTRS or key.startswith("_"):
                continue
            if key == "request_id" and rid is None:
                payload["request_id"] = value
                continue
            # Avoid clobbering reserved fields.
            if key in payload:
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)

        return json.dumps(payload, default=str)


_CONFIGURED = False


def configure_logging(level: str | int | None = None) -> None:
    """Install the JSON formatter on the root logger.

    Idempotent — calling twice does not stack handlers. ``LOG_LEVEL``
    env var (default ``INFO``) is consulted when ``level`` is omitted.
    """
    global _CONFIGURED

    if level is None:
        level = os.getenv("LOG_LEVEL", "INFO").upper()
    if isinstance(level, str):
        level_value = logging.getLevelName(level)
        if not isinstance(level_value, int):
            level_value = logging.INFO
    else:
        level_value = int(level)

    root = logging.getLogger()
    if _CONFIGURED:
        # Already configured — just adjust the level so callers can
        # change it at runtime if they want.
        root.setLevel(level_value)
        for h in root.handlers:
            h.setLevel(level_value)
        return

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.setLevel(level_value)

    # Replace existing handlers to avoid double-logging when uvicorn
    # also installs its own formatters.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(level_value)

    # Keep uvicorn's loggers in sync — propagate to root so they pick up
    # our JSON handler instead of uvicorn's default text formatter.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
        lg.setLevel(level_value)

    _CONFIGURED = True
