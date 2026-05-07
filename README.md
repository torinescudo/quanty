quant_platform
Plataforma de research → live para trading sistemático en cripto. Construida sobre Freqtrade para no reinventar el motor, con dos capas propias por encima:
Tus estrategias (`user_data/strategies/`)
Un dashboard custom con estética terminal (`dashboard/`)
Por qué Freqtrade y no otra cosa
Crypto-native: integra CCXT por debajo, soporta Coinbase Advanced, Binance, Bybit, Kraken, OKX, Hyperliquid…
Backtest, hyperopt (Optuna), paper trading y live ejecutan con la misma clase de estrategia. Sin reescribir.
REST API + autenticación JWT integrada en el puerto 8080. El dashboard custom tira de ahí.
Open source MIT, mantenido activamente, comunidad grande, ejemplos de estrategias en abundancia.
Estructura del proyecto
```
quant_platform/
├── README.md                          # este archivo
├── pyproject.toml                     # deps mínimas (freqtrade + fastapi para el bridge)
├── user_data/                         # convención de Freqtrade — todo aquí es tuyo
│   ├── config.json                    # backtest + paper + live se controlan desde aquí
│   ├── strategies/
│   │   ├── SmaCross.py                # ejemplo: trend following
│   │   ├── BollingerRevert.py         # ejemplo: mean reversion
│   │   └── DonchianBreak.py           # ejemplo: breakout
│   ├── data/                          # OHLCV descargada (gitignored)
│   ├── backtest_results/              # output de backtests (gitignored)
│   └── hyperopt_results/              # output de hyperopt (gitignored)
├── dashboard/                         # capa visual propia
│   ├── app.py                         # FastAPI bridge → REST de Freqtrade
│   └── static/
│       └── index.html                 # el dashboard gótico, conectado a app.py
└── scripts/
    ├── download.sh                    # descarga datos de Coinbase
    ├── backtest.sh                    # corre backtest
    ├── hyperopt.sh                    # corre hyperopt (busca params óptimos)
    ├── paper.sh                       # arranca en paper trading + dashboard
    └── live.sh                        # arranca en live (requiere API keys)
```
Workflow completo
0 · Setup (una sola vez)
```bash
python -m venv .venv && source .venv/bin/activate
pip install -e .                       # instala freqtrade + fastapi
ft init --userdir user_data            # crea estructura interna de Freqtrade
```
1 · Descargar histórico
```bash
freqtrade download-data \
    --exchange coinbase \
    --pairs BTC/USD ETH/USD SOL/USD AVAX/USD MATIC/USD LINK/USD \
    --timeframes 5m 1h 1d \
    --timerange 20220101-20240101
```
Tarda 5-15 minutos. Se guarda en `user_data/data/coinbase/`.
2 · Backtest de una estrategia
```bash
freqtrade backtesting \
    --strategy SmaCross \
    --timeframe 1h \
    --timerange 20220101-20240101 \
    --export trades
```
Output: equity curve, Sharpe, Sortino, max DD, win rate, profit factor, lista de trades. Reportes en `user_data/backtest_results/`.
3 · Hyperopt para encontrar parámetros óptimos
```bash
freqtrade hyperopt \
    --strategy SmaCross \
    --hyperopt-loss SharpeHyperOptLoss \
    --spaces buy sell roi stoploss \
    --timeframe 1h \
    --timerange 20220101-20240101 \
    --epochs 500
```
Optuna prueba 500 combinaciones de parámetros buscando el Sharpe out-of-sample más alto. Importante: corta el dataset en train / validation. Si hyperoptas en todo el rango de 2 años y luego "live" con esos params, has overfitted.
Mejor práctica: hyperopt en 2022 + H1 2023, validas en H2 2023, luego live.
4 · Walk-forward validation manual
```bash
# Train: 2022
freqtrade hyperopt --strategy SmaCross --timerange 20220101-20221231 --epochs 300

# Test (out-of-sample) — usa los params óptimos del paso anterior
freqtrade backtesting --strategy SmaCross --timerange 20230101-20240101
```
Si el Sharpe in-sample es 2.5 y el out-of-sample es 0.3, has overfitted. Vuelve a la mesa de research.
5 · Paper trading + dashboard
```bash
./scripts/paper.sh                     # arranca freqtrade en dry-run + dashboard FastAPI
```
Esto levanta dos procesos:
Freqtrade en `localhost:8080` (REST + WebUI propia, ignorable)
Dashboard custom en `localhost:8000` (la estética gótica conectada a la API real)
Abres `http://localhost:8000` y ves: equity curve real, posiciones abiertas reales (en paper), trades ejecutados, ticks vivos, todo sobre estrategias que has validado.
6 · Live
```bash
# Edita user_data/config.json:
#   "dry_run": false
#   "exchange.key": "tu_api_key_coinbase"
#   "exchange.secret": "tu_secret"

./scripts/live.sh
```
Empieza con capital simbólico (100€). Mira el dashboard durante una semana. Si los fills cuadran con los del backtest (slippage realista, latencia razonable), escala.
Cómo añadir una estrategia nueva
```python
# user_data/strategies/MiEstrategia.py
from freqtrade.strategy import IStrategy, IntParameter
import pandas as pd

class MiEstrategia(IStrategy):
    timeframe = "1h"
    minimal_roi = {"0": 0.04}
    stoploss = -0.05

    fast = IntParameter(5, 30, default=10, space="buy")
    slow = IntParameter(40, 200, default=50, space="buy")

    def populate_indicators(self, df: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        df["sma_fast"] = df["close"].rolling(self.fast.value).mean()
        df["sma_slow"] = df["close"].rolling(self.slow.value).mean()
        return df

    def populate_entry_trend(self, df: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        df.loc[df["sma_fast"] > df["sma_slow"], "enter_long"] = 1
        return df

    def populate_exit_trend(self, df: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        df.loc[df["sma_fast"] < df["sma_slow"], "exit_long"] = 1
        return df
```
Ya está. Ahora puedes hacer `freqtrade backtesting --strategy MiEstrategia` y `freqtrade hyperopt --strategy MiEstrategia` sin tocar nada más.
Caveats que importan
Coinbase Advanced spot tiene fees del 0.6% taker / 0.4% maker — comparado con 0.05% de Binance. Cualquier estrategia que rote >5 veces al mes deja la mitad del retorno en fees. Usa órdenes limit (maker) siempre que puedas.
Hyperopt es overfitting industrializado. 500 epochs sobre 2 años de datos encuentra un overfit perfecto. Splits estrictos, validación out-of-sample, y desconfianza permanente.
Paper trading ≠ live trading. Slippage real, latencia, fills parciales, exchange downtime. Pasa al menos 30 días en paper antes de capital real, y empieza con 100€.
Los 14 altcoins del dashboard son sugerencia. Personalizalos en `user_data/config.json` → `pair_whitelist`. Algunos no están en Coinbase (LDO, RPL) — comprueba antes con `freqtrade list-pairs --exchange coinbase`.
