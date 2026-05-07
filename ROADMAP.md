# Roadmap · VOID quant.platform

Plan para llevar el repo desde su estado actual (frontend completo con backend simulado) hasta un sistema funcional de paper → live trading sobre Coinbase Advanced + Freqtrade.

## Estado actual

**Lo que existe**
- Frontend completo en React 18 vía Babel standalone (sin bundler).
  - `VOID.html` carga el SPA y los layers visuales.
  - Vistas modulares: `void-shell.jsx`, `void-views.jsx`, `void-trade.jsx`, `void-backtest.jsx`, `void-mount.jsx`, `void-tweaks.jsx`.
  - Estilos: `void-styles.css`, `void-backtest.css`.
  - Background canvases: `starfield.js`, `solar.js`.
  - Panel reusable de tweaks: `tweaks-panel.jsx`.
- Mock backend en `void-api.js` con persistencia en `localStorage` (balances, órdenes, fills, transferencias, estrategias, notificaciones).
- Feed real de precios de Coinbase WebSocket en `void-prices.js` con fallback a random walk.

**Lo que NO existe (gap principal)**
- El backend Python descrito en `README.md`: estructura `quant_platform/`, `pyproject.toml`, estrategias en `user_data/strategies/`, scripts y bridge FastAPI en `dashboard/app.py`.
- Cualquier ejecución real de órdenes o estrategias.

## Fases

### Fase 0 · Estructura base del proyecto
- Crear el layout descrito en el README:
  ```
  quant_platform/
  ├── pyproject.toml
  ├── user_data/{config.json,strategies/,data/,backtest_results/,hyperopt_results/}
  ├── dashboard/{app.py,static/}
  └── scripts/{download.sh,backtest.sh,hyperopt.sh,paper.sh,live.sh}
  ```
- Mover el frontend actual (`VOID.html`, `void-*.js/jsx`, `*.css`, `starfield.js`, `solar.js`, `tweaks-panel.jsx`) a `dashboard/static/`.
- `pyproject.toml` con dependencias mínimas: `freqtrade`, `fastapi`, `uvicorn`, `httpx`, `python-dotenv`, `pytest`.
- `.gitignore` para `user_data/data/`, `user_data/backtest_results/`, `user_data/hyperopt_results/`, `.venv/`, `__pycache__/`.

**Done cuando** `pip install -e .` instala todo y `ft init --userdir user_data` corre sin error.

### Fase 1 · Bridge FastAPI (`dashboard/app.py`)
- Servir los estáticos del dashboard.
- Proxy autenticado contra la REST API de Freqtrade (`localhost:8080` con JWT).
- Endpoints alineados con la superficie de `void-api.js`:
  - `GET  /api/portfolio` → balances + holdings valorados
  - `GET  /api/orders` · `POST /api/orders` · `DELETE /api/orders/:id` · `DELETE /api/orders`
  - `GET  /api/fills`
  - `GET  /api/transfers` · `POST /api/transfers/deposit` · `POST /api/transfers/withdraw`
  - `GET  /api/strategies` · `POST /api/strategies/:id/status` · `PATCH /api/strategies/:id/params`
  - `GET  /api/notifications` · `POST /api/notifications/read-all` · `DELETE /api/notifications`
  - `POST /api/connect` · `POST /api/disconnect` · `GET /api/connection/test`
- WebSocket `/ws` que multiplexa: ticks de Coinbase, eventos de fill, estado de estrategias.

**Done cuando** el bridge devuelve datos reales de Freqtrade en dry-run.

### Fase 2 · Reemplazar mock por cliente HTTP real
- Convertir `void-api.js` en cliente HTTP que conserve la **misma forma** (estado central, `subscribe`, métodos `async`) — así las vistas no se tocan.
- Las API keys de Coinbase viven en el bridge (variables de entorno / archivo cifrado), nunca en el browser.
- Frontend solo guarda token de sesión.
- Cablear estados `loading` / `error` / `reconnecting` en UI (las vistas ya tienen banners — falta enlazarlos).

**Done cuando** se puede borrar `localStorage` y la app se rehidrata leyendo del bridge.

### Fase 3 · Estrategias y scripts
- Tres estrategias de ejemplo en `user_data/strategies/` (de menor a mayor complejidad):
  - `SmaCross.py` (trend following)
  - `BollingerRevert.py` (mean reversion)
  - `DonchianBreak.py` (breakout)
- Cada una con `IntParameter` / `DecimalParameter` declarados para hyperopt.
- `user_data/config.json` con `pair_whitelist` derivado de los 14 pares del frontend, **previa verificación** con `freqtrade list-pairs --exchange coinbase` (LDO, RPL y otros podrían no existir en Coinbase Advanced).
- `scripts/`:
  - `download.sh` — descarga OHLCV de Coinbase para los pares y timeframes 5m/1h/1d.
  - `backtest.sh` — backtest de una estrategia con `--export trades`.
  - `hyperopt.sh` — Optuna con `SharpeHyperOptLoss` y splits explícitos.
  - `paper.sh` — arranca freqtrade dry-run + bridge + estáticos.
  - `live.sh` — equivalente para live (con confirmación interactiva).

**Done cuando** `./scripts/backtest.sh SmaCross` produce métricas en `user_data/backtest_results/`.

### Fase 4 · Backtest funcional desde el dashboard
- `void-backtest.jsx` deja de usar datos sintéticos y llama a `POST /api/backtest/run` (job en background).
- Streaming de progreso vía WebSocket (epochs, equity curve, métricas parciales).
- Resultados reales: equity curve, Sharpe, Sortino, max DD, win rate, profit factor, lista de trades.
- Hyperopt como job de larga duración con polling y posibilidad de cancelar.

**Done cuando** lanzar un backtest desde la UI produce los mismos números que `freqtrade backtesting` por CLI.

### Fase 5 · Paper trading end-to-end
- `./scripts/paper.sh` levanta los tres procesos (freqtrade dry-run, bridge, frontend) coordinados.
- Verificar el camino completo: tick Coinbase → indicador → señal de entrada → orden simulada → fill → balance actualizado en dashboard.
- **Mínimo 30 días de paper** antes de tocar capital real, monitorizando que el slippage y los fills cuadran con el backtest.

**Done cuando** una estrategia corre 30 días en paper sin reinicios y los stats coinciden con el backtest dentro de tolerancia razonable.

### Fase 6 · Live trading (con barandillas)
- API keys Coinbase Advanced (formato `organizations/{org_id}/apiKeys/{id}`) en `.env` del bridge.
- Capital inicial simbólico: 100€.
- Solo órdenes limit (maker) por defecto — Coinbase Advanced spot tiene 0.6% taker / 0.4% maker.
- Alertas Discord/Telegram en: cada fill, drawdown > umbral, exchange downtime, latencia > umbral.
- Kill switch global accesible desde la UI y desde CLI.

**Done cuando** una semana en live con 100€ produce fills consistentes con el paper trading.

### Fase 7 · Hardening y observabilidad
- Tests del bridge con `pytest` (unitarios + un integración contra freqtrade dry-run).
- Docker Compose: `freqtrade` + `bridge` + servidor estático para producción.
- Logging estructurado (JSON) con niveles separados para tráfico, estrategia, exchange.
- Reconexión robusta del WebSocket con backoff exponencial (frontend ya tiene fallback, hardening en el bridge).
- Healthchecks `/healthz` y `/readyz` en el bridge.
- Documentar walk-forward validation como práctica obligatoria antes de pasar cualquier estrategia a live.

## Decisiones abiertas

1. **Spot only o también futures.** El frontend ya soporta `portfolioMode: spot|futures` y leverage. Si solo es spot, el modelo se simplifica.
2. **Auth multiusuario o single-user local.** Cambia drásticamente el bridge (single-user → token estático en `.env`; multi → cookie de sesión + DB).
3. **¿Mantener Freqtrade o backend custom?** Freqtrade ahorra meses pero condiciona el modelo de estrategia. Recomendación por defecto: mantenerlo y solo migrar si aparece un bloqueo concreto.

## Caveats que el README ya marca y conviene no olvidar

- Hyperopt es overfitting industrializado. Splits estrictos y validación out-of-sample siempre.
- Paper ≠ live. Slippage real, latencia, fills parciales, downtime del exchange.
- Las fees de Coinbase Advanced spot son altas. Cualquier estrategia que rote >5 veces al mes deja la mitad del retorno en fees.
