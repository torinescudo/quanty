#!/usr/bin/env bash
# quickstart.sh — arranca el dashboard VOID con un solo comando.
#
#   ./scripts/quickstart.sh           # full: freqtrade dry-run + bridge + browser
#   ./scripts/quickstart.sh --demo    # solo bridge + frontend (UI con bridge offline)
#   ./scripts/quickstart.sh --stop    # mata todos los procesos arrancados antes
#
# Idempotente: re-ejecutarlo no duplica deps ni procesos.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
PIDFILE="$ROOT/.quickstart.pids"
LOGDIR="$ROOT/.quickstart.logs"
mkdir -p "$LOGDIR"

# colores para terminal
c_blue='\033[1;34m'; c_green='\033[1;32m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'; c_dim='\033[2m'; c_off='\033[0m'

log()  { printf "${c_blue}▸${c_off} %s\n" "$*"; }
ok()   { printf "${c_green}✓${c_off} %s\n" "$*"; }
warn() { printf "${c_yellow}!${c_off} %s\n" "$*"; }
fail() { printf "${c_red}✗${c_off} %s\n" "$*" >&2; exit 1; }

# ---- modo --stop ----
if [ "${1:-}" = "--stop" ]; then
  if [ ! -f "$PIDFILE" ]; then
    warn "no hay procesos registrados en $PIDFILE"
    exit 0
  fi
  while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && ok "killed pid $pid" || warn "no pude matar pid $pid"
    fi
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  ok "stop done"
  exit 0
fi

DEMO_MODE=0
if [ "${1:-}" = "--demo" ]; then
  DEMO_MODE=1
  log "modo DEMO: solo bridge + frontend (sin freqtrade)"
fi

# ---- prerequisitos ----
command -v python3 >/dev/null || fail "python3 no encontrado. Instálalo y vuelve."

# ---- venv + deps ----
if [ ! -d "$VENV" ]; then
  log "creando venv en .venv/"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

if [ ! -f "$VENV/.deps_installed" ] || [ pyproject.toml -nt "$VENV/.deps_installed" ]; then
  log "instalando dependencias (puede tardar 1-3 min la primera vez)..."
  pip install --quiet --upgrade pip
  pip install --quiet -e . 2>&1 | tail -5 || fail "pip install falló"
  touch "$VENV/.deps_installed"
  ok "dependencias instaladas"
else
  ok "dependencias ya instaladas"
fi

# ---- limpia procesos previos ----
if [ -f "$PIDFILE" ]; then
  warn "matando procesos previos (de un quickstart anterior)..."
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PIDFILE"
  rm -f "$PIDFILE"
fi
: > "$PIDFILE"

# ---- arranca freqtrade (solo en modo full) ----
if [ "$DEMO_MODE" -eq 0 ]; then
  if command -v freqtrade >/dev/null; then
    log "arrancando freqtrade en dry-run (estrategia: ${STRATEGY:-SmaCross})..."
    nohup freqtrade trade \
      --strategy "${STRATEGY:-SmaCross}" \
      --userdir user_data \
      > "$LOGDIR/freqtrade.log" 2>&1 &
    FT_PID=$!
    echo "$FT_PID" >> "$PIDFILE"
    ok "freqtrade pid=$FT_PID  (logs: .quickstart.logs/freqtrade.log)"
    sleep 3
  else
    warn "freqtrade no está instalado. Arrancando en modo demo (UI con bridge offline)."
    warn "para tradear: pip install freqtrade  o  ./scripts/quickstart.sh --demo"
    DEMO_MODE=1
  fi
fi

# ---- arranca bridge ----
log "arrancando bridge FastAPI en :8000..."
nohup uvicorn dashboard.app:app \
  --host 127.0.0.1 --port 8000 \
  > "$LOGDIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
echo "$BRIDGE_PID" >> "$PIDFILE"

# espera a que /healthz responda
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  if curl -fs http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
    break
  fi
done
curl -fs http://127.0.0.1:8000/healthz >/dev/null 2>&1 \
  || fail "bridge no respondió en 5s — revisa $LOGDIR/bridge.log"
ok "bridge pid=$BRIDGE_PID  http://localhost:8000  (logs: .quickstart.logs/bridge.log)"

# ---- abre browser ----
URL="http://localhost:8000"
log "abriendo $URL en tu browser..."
if command -v open >/dev/null; then open "$URL"           # macOS
elif command -v xdg-open >/dev/null; then xdg-open "$URL" # linux
elif command -v start >/dev/null; then start "$URL"       # git-bash on windows
else warn "no pude detectar el comando de abrir browser — abre $URL manualmente"
fi

echo
ok "todo arriba — abre $URL"
if [ "$DEMO_MODE" -eq 1 ]; then
  printf "${c_dim}modo DEMO: el banner 'Bridge offline' es esperado, la UI funciona pero no hay datos de trading reales.${c_off}\n"
fi
echo
printf "${c_dim}para parar todo:  ./scripts/quickstart.sh --stop${c_off}\n"
printf "${c_dim}logs en tiempo real:  tail -f .quickstart.logs/bridge.log${c_off}\n"
