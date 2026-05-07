# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# Bridge image — FastAPI + uvicorn that proxies the freqtrade REST API and
# serves the static dashboard. Multi-stage so the final image only carries
# the installed dependencies, not the build-time tooling.
# ---------------------------------------------------------------------------

# -------- builder ----------------------------------------------------------
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build deps for any C extensions pulled in transitively (TA-Lib stub deps,
# uvloop wheel fallbacks, etc.). Kept minimal — freqtrade itself ships its
# own image, this bridge only needs FastAPI + httpx.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy only the metadata first so dependency installs can be cached when
# only application code changes.
COPY pyproject.toml README.md ./
COPY dashboard ./dashboard

# We install the package into a dedicated venv that we copy verbatim into
# the runtime stage. Skipping freqtrade itself: the bridge only talks to
# it over REST and freqtrade lives in its own container.
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install \
        "fastapi>=0.104.0" \
        "uvicorn[standard]>=0.24.0" \
        "httpx>=0.25.0" \
        "python-dotenv>=1.0.0"

# -------- runtime ----------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    LOG_LEVEL=INFO \
    FREQTRADE_URL=http://freqtrade:8080

# curl is used by the healthcheck below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --home /app --shell /usr/sbin/nologin app

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app

# Application code last so source-only changes invalidate only this layer.
COPY dashboard ./dashboard

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

CMD ["uvicorn", "dashboard.app:app", "--host", "0.0.0.0", "--port", "8000"]
