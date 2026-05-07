"""FastAPI bridge between the VOID dashboard and Freqtrade.

The bridge serves the static frontend, proxies the Freqtrade REST API
(localhost:8080) and multiplexes a WebSocket that mixes Coinbase ticks,
fill events and strategy state changes.
"""
