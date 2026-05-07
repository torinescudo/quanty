"""Shared pytest configuration.

The bridge resolves Freqtrade credentials in this order:
  1. ``FREQTRADE_USER`` / ``FREQTRADE_PASS`` env vars
  2. ``api_server.username`` / ``api_server.password`` in
     ``user_data/config.json``

The shipped ``user_data/config.json`` declares placeholder credentials
(``freqtrader`` / ``CHANGE_ME_IN_ENV``) so the operator does not forget
to override them, but those would make the ``FreqtradeClient`` attempt
a real login round-trip. The bridge tests mount an ``httpx.MockTransport``
that does **not** route ``/api/v1/token/login``, so we strip the config
fallback for the duration of the test session.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_config_credentials(monkeypatch):
    """Force ``_read_config_credentials`` to behave as if the file had
    no credentials, matching the historical (Phase 1) behaviour the
    bridge tests were written against."""
    try:
        from dashboard import app as bridge_app
    except Exception:  # pragma: no cover — bridge import failure
        return
    monkeypatch.setattr(bridge_app, "_read_config_credentials", lambda: (None, None))
