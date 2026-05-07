// =============================================================
// Live prices via Coinbase WS — populates window.__livePrices
// and dispatches 'priceupdate' on window for components to listen.
// =============================================================

(function() {
  const PAIRS = [
    'BTC-USD','ETH-USD','SOL-USD','AVAX-USD','LINK-USD',
    'DOT-USD','ADA-USD','MATIC-USD','ARB-USD','OP-USD',
    'UNI-USD','ATOM-USD','DOGE-USD','LDO-USD'
  ];
  const initial = {
    'BTC-USD': 67800, 'ETH-USD': 3500, 'SOL-USD': 158, 'AVAX-USD': 28.4,
    'LINK-USD': 14.2, 'DOT-USD': 6.5, 'ADA-USD': 0.42, 'MATIC-USD': 0.55,
    'ARB-USD': 0.85, 'OP-USD': 1.65, 'UNI-USD': 8.5, 'ATOM-USD': 8.0,
    'DOGE-USD': 0.16, 'LDO-USD': 1.7,
  };
  const sparkLen = 60;
  const live = {};
  const open24h = {};
  const sparks = {};
  PAIRS.forEach(p => {
    live[p] = initial[p];
    open24h[p] = initial[p] * (1 - (Math.random() * 0.06 - 0.03));
    sparks[p] = Array.from({ length: sparkLen }, (_, i) => initial[p] * (1 + Math.sin(i*0.3) * 0.005 + (Math.random()-0.5)*0.004));
  });

  window.__livePrices = live;
  window.__priceOpen24h = open24h;
  window.__priceSparks = sparks;
  window.__pricePairs = PAIRS;

  function emit(pair) {
    window.dispatchEvent(new CustomEvent('priceupdate', { detail: { pair, price: live[pair] } }));
  }
  function pushSpark(pair, p) {
    const arr = sparks[pair];
    arr.push(p);
    if (arr.length > sparkLen) arr.shift();
  }

  // ---- Coinbase WS ----
  let ws = null;
  let connected = false;
  function connectWS() {
    try {
      ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
      ws.onopen = () => {
        connected = true;
        ws.send(JSON.stringify({
          type: 'subscribe',
          product_ids: PAIRS,
          channels: ['ticker'],
        }));
      };
      ws.onmessage = (evt) => {
        try {
          const m = JSON.parse(evt.data);
          if (m.type === 'ticker' && m.product_id && m.price) {
            const p = parseFloat(m.price);
            const pair = m.product_id;
            if (PAIRS.includes(pair)) {
              live[pair] = p;
              if (m.open_24h) open24h[pair] = parseFloat(m.open_24h);
              pushSpark(pair, p);
              emit(pair);
            }
          }
        } catch {}
      };
      ws.onerror = () => { connected = false; };
      ws.onclose = () => {
        connected = false;
        setTimeout(connectWS, 4000);
      };
    } catch {
      connected = false;
    }
  }
  connectWS();

  // ---- Fallback random walk if WS fails (so UI keeps moving) ----
  setInterval(() => {
    if (connected) return;
    PAIRS.forEach(pair => {
      const drift = (Math.random() - 0.5) * live[pair] * 0.001;
      live[pair] = Math.max(0.0001, live[pair] + drift);
      pushSpark(pair, live[pair]);
      emit(pair);
    });
  }, 1500);
})();
