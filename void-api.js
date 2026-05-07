// ============================================================
// MOCK BACKEND — simulates Coinbase Advanced Trade + Freqtrade
// Replace baseURL + auth in window.api.* with real fetch calls
// when backend is wired up.
// ============================================================

(function() {
  // -------- persistent state (localStorage) --------
  const STORAGE_KEY = 'void_state_v1';
  const defaultState = {
    connected: false,
    apiKey: '',
    apiSecret: '',
    passphrase: '',
    mode: 'paper',                 // paper | live
    portfolioMode: 'spot',         // spot | futures
    leverage: 1,
    balances: {
      USD:  { available: 12450.32, hold: 1200.00 },
      BTC:  { available: 0.0852,    hold: 0.012 },
      ETH:  { available: 2.4,       hold: 0.5 },
      SOL:  { available: 18.7,      hold: 0 },
      AVAX: { available: 42.1,      hold: 0 },
      LINK: { available: 110.5,     hold: 0 },
    },
    openOrders: [
      { id: 'ord_8a2f', pair: 'BTC-USD', side: 'BUY',  type: 'limit', size: 0.015, price: 67200, filled: 0, status: 'OPEN', created: Date.now() - 1800000, tif: 'GTC' },
      { id: 'ord_3c91', pair: 'ETH-USD', side: 'SELL', type: 'limit', size: 0.5,    price: 3580,  filled: 0, status: 'OPEN', created: Date.now() - 5400000, tif: 'GTC' },
      { id: 'ord_d4e8', pair: 'SOL-USD', side: 'BUY',  type: 'stop',  size: 5,      price: 152,   stopPrice: 152, filled: 0, status: 'OPEN', created: Date.now() - 900000, tif: 'GTC' },
    ],
    fills: [
      { id: 'fil_001', pair: 'BTC-USD', side: 'BUY',  size: 0.024, price: 66800, fee: 4.81,  ts: Date.now() - 86400000 * 0.5 },
      { id: 'fil_002', pair: 'ETH-USD', side: 'BUY',  size: 1.2,   price: 3420,  fee: 4.10,  ts: Date.now() - 86400000 * 1.2 },
      { id: 'fil_003', pair: 'SOL-USD', side: 'BUY',  size: 12,    price: 145,   fee: 1.74,  ts: Date.now() - 86400000 * 2.1 },
      { id: 'fil_004', pair: 'LINK-USD',side: 'BUY',  size: 80,    price: 14.2,  fee: 0.68,  ts: Date.now() - 86400000 * 3.0 },
      { id: 'fil_005', pair: 'BTC-USD', side: 'SELL', size: 0.005, price: 68150, fee: 1.02,  ts: Date.now() - 86400000 * 4.5 },
      { id: 'fil_006', pair: 'AVAX-USD',side: 'BUY',  size: 30,    price: 28.5,  fee: 1.03,  ts: Date.now() - 86400000 * 6.0 },
      { id: 'fil_007', pair: 'ETH-USD', side: 'BUY',  size: 0.8,   price: 3350,  fee: 2.68,  ts: Date.now() - 86400000 * 8.0 },
      { id: 'fil_008', pair: 'SOL-USD', side: 'SELL', size: 4.5,   price: 162,   fee: 1.09,  ts: Date.now() - 86400000 * 10 },
    ],
    transfers: [
      { id: 'tx_a01', kind: 'deposit',  asset: 'USD', amount: 10000, ts: Date.now() - 86400000 * 25, status: 'COMPLETED', method: 'ACH' },
      { id: 'tx_a02', kind: 'deposit',  asset: 'BTC', amount: 0.05,  ts: Date.now() - 86400000 * 18, status: 'COMPLETED', method: 'CRYPTO' },
      { id: 'tx_a03', kind: 'withdraw', asset: 'USD', amount: 500,   ts: Date.now() - 86400000 * 12, status: 'COMPLETED', method: 'ACH' },
      { id: 'tx_a04', kind: 'deposit',  asset: 'ETH', amount: 1.5,   ts: Date.now() - 86400000 * 7,  status: 'COMPLETED', method: 'CRYPTO' },
      { id: 'tx_a05', kind: 'withdraw', asset: 'BTC', amount: 0.01,  ts: Date.now() - 86400000 * 2,  status: 'PENDING',   method: 'CRYPTO' },
    ],
    strategies: [
      { id: 'sma_cross', name: 'SmaCross',          status: 'RUNNING', pairs: 14, params: { fast: 12, slow: 50, rsi_max: 70 }, pnl30d: 432.50, sharpe: 1.42, trades30d: 38, mode: 'paper' },
      { id: 'boll_revert', name: 'BollingerRevert', status: 'PAUSED',  pairs: 8,  params: { window: 20, std: 2.0 },             pnl30d: -45.20, sharpe: 0.21, trades30d: 12, mode: 'paper' },
      { id: 'donchian',   name: 'DonchianBreak',    status: 'STOPPED', pairs: 6,  params: { lookback: 55 },                     pnl30d: 0,      sharpe: 0,    trades30d: 0,  mode: 'paper' },
    ],
    notifications: [
      { id: 'n1', kind: 'fill',     msg: 'Order filled · BTC-USD BUY 0.024 @ $66,800',     ts: Date.now() - 1800000,  read: false },
      { id: 'n2', kind: 'strategy', msg: 'SmaCross opened LONG SOL-USD',                    ts: Date.now() - 3600000,  read: false },
      { id: 'n3', kind: 'system',   msg: 'API uplink restored',                             ts: Date.now() - 7200000,  read: true  },
      { id: 'n4', kind: 'transfer', msg: 'Withdrawal of 0.01 BTC pending confirmation',     ts: Date.now() - 14400000, read: false },
    ],
    settings: {
      theme: 'cosmos',
      slippageTolerance: 0.5,
      defaultTif: 'GTC',
      confirmOrders: true,
      sounds: false,
    },
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(defaultState);
      return { ...structuredClone(defaultState), ...JSON.parse(raw) };
    } catch { return structuredClone(defaultState); }
  }
  function save(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }
  let state = load();

  // -------- subscribers (so views re-render on state changes) --------
  const subs = new Set();
  function emit() {
    save(state);
    subs.forEach(fn => { try { fn(state); } catch (e) { console.warn(e); } });
  }
  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

  // -------- helpers --------
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  function uid(p='') { return p + Math.random().toString(36).slice(2, 8); }

  function getPrice(pair) {
    // pull from the live price store updated by Coinbase WS
    return (window.__livePrices && window.__livePrices[pair]) || null;
  }

  // -------- API surface --------
  const api = {
    state: () => state,
    subscribe,

    // ---- AUTH / CONNECTION ----
    async connect({ apiKey, apiSecret, passphrase, mode }) {
      await wait(900);
      if (!apiKey || apiKey.length < 8) throw new Error('Invalid API key (min 8 chars)');
      if (!apiSecret || apiSecret.length < 16) throw new Error('Invalid secret (min 16 chars)');
      state.apiKey = apiKey;
      state.apiSecret = '••••••••' + apiSecret.slice(-4);
      state.passphrase = passphrase ? '••••••' : '';
      state.mode = mode || 'paper';
      state.connected = true;
      addNotif({ kind:'system', msg:`Account connected · ${state.mode.toUpperCase()} mode` });
      emit();
      return { ok: true, accountId: 'CB-' + uid() };
    },
    async disconnect() {
      state.connected = false;
      state.apiKey = ''; state.apiSecret = ''; state.passphrase = '';
      addNotif({ kind:'system', msg:'Account disconnected' });
      emit();
    },
    async testConnection() {
      await wait(600);
      if (!state.connected) throw new Error('Not connected');
      return { ok: true, latencyMs: 42 + Math.floor(Math.random()*30), exchange: 'coinbase-advanced' };
    },

    // ---- PORTFOLIO ----
    portfolio() {
      const holdings = Object.entries(state.balances).map(([asset, b]) => {
        const total = b.available + b.hold;
        const price = asset === 'USD' ? 1 : (getPrice(asset + '-USD') || refPrice(asset));
        const valueUsd = total * price;
        return { asset, available: b.available, hold: b.hold, total, price, valueUsd };
      });
      const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
      return { holdings, totalUsd };
    },

    // ---- ORDERS ----
    async placeOrder({ pair, side, type, size, price, stopPrice, tif }) {
      await wait(700);
      if (!size || size <= 0) throw new Error('Size must be > 0');
      if (type !== 'market' && (!price || price <= 0)) throw new Error('Price required for limit orders');
      const px = type === 'market' ? (getPrice(pair) || refPrice(pair.split('-')[0])) : price;
      // for market: instant fill against simulated balance
      if (type === 'market') {
        applyFill({ pair, side, size, price: px, fee: px * size * 0.006 });
        addNotif({ kind:'fill', msg:`Market filled · ${pair} ${side} ${size} @ $${formatPrice(px)}` });
        emit();
        return { ok: true, status: 'FILLED', fillPrice: px };
      }
      // limit/stop: queue as open
      const order = {
        id: 'ord_' + uid(), pair, side, type,
        size: +size, price: +price, stopPrice: stopPrice ? +stopPrice : undefined,
        filled: 0, status: 'OPEN', created: Date.now(), tif: tif || 'GTC',
      };
      state.openOrders.unshift(order);
      addNotif({ kind:'system', msg:`${type.toUpperCase()} ${side} ${pair} placed · ${size} @ $${formatPrice(price)}` });
      emit();
      return { ok: true, orderId: order.id };
    },
    async cancelOrder(id) {
      await wait(400);
      state.openOrders = state.openOrders.filter(o => o.id !== id);
      addNotif({ kind:'system', msg:`Order ${id} cancelled` });
      emit();
    },
    async cancelAll() {
      await wait(400);
      const n = state.openOrders.length;
      state.openOrders = [];
      addNotif({ kind:'system', msg:`Cancelled all ${n} open orders` });
      emit();
    },
    async modifyOrder(id, { price, size }) {
      await wait(400);
      const o = state.openOrders.find(x => x.id === id);
      if (!o) throw new Error('Order not found');
      if (price) o.price = +price;
      if (size) o.size = +size;
      emit();
    },

    // ---- TRANSFERS ----
    async deposit({ asset, amount, method }) {
      await wait(700);
      const tx = { id: 'tx_'+uid(), kind:'deposit', asset, amount:+amount, ts: Date.now(), status:'PENDING', method };
      state.transfers.unshift(tx);
      // simulated quick confirm for paper
      setTimeout(() => {
        tx.status = 'COMPLETED';
        if (!state.balances[asset]) state.balances[asset] = { available: 0, hold: 0 };
        state.balances[asset].available += +amount;
        addNotif({ kind:'transfer', msg:`Deposit confirmed · ${amount} ${asset}` });
        emit();
      }, 2500);
      addNotif({ kind:'transfer', msg:`Deposit initiated · ${amount} ${asset}` });
      emit();
      return { ok:true, txId: tx.id };
    },
    async withdraw({ asset, amount, address }) {
      await wait(700);
      if (!state.balances[asset] || state.balances[asset].available < +amount)
        throw new Error('Insufficient balance');
      state.balances[asset].available -= +amount;
      const tx = { id:'tx_'+uid(), kind:'withdraw', asset, amount:+amount, ts: Date.now(), status:'PENDING', method:'CRYPTO', address };
      state.transfers.unshift(tx);
      addNotif({ kind:'transfer', msg:`Withdrawal initiated · ${amount} ${asset}` });
      emit();
      return { ok:true, txId: tx.id };
    },

    // ---- STRATEGIES ----
    async setStrategyStatus(id, status) {
      await wait(400);
      const s = state.strategies.find(x => x.id === id);
      if (!s) return;
      s.status = status;
      addNotif({ kind:'strategy', msg:`${s.name} → ${status}` });
      emit();
    },
    async updateStrategyParams(id, params) {
      await wait(400);
      const s = state.strategies.find(x => x.id === id);
      if (!s) return;
      s.params = { ...s.params, ...params };
      emit();
    },

    // ---- SETTINGS ----
    setSetting(key, value) {
      state.settings[key] = value;
      emit();
    },

    // ---- NOTIFICATIONS ----
    markAllRead() { state.notifications.forEach(n => n.read = true); emit(); },
    clearNotifs() { state.notifications = []; emit(); },
  };

  function addNotif({ kind, msg }) {
    state.notifications.unshift({ id:'n_'+uid(), kind, msg, ts: Date.now(), read:false });
    if (state.notifications.length > 30) state.notifications.length = 30;
    if (window.__toast) window.__toast({ kind, msg });
  }
  function applyFill({ pair, side, size, price, fee }) {
    const [base, quote] = pair.split('-');
    if (!state.balances[base])  state.balances[base]  = { available: 0, hold: 0 };
    if (!state.balances[quote]) state.balances[quote] = { available: 0, hold: 0 };
    const cost = size * price;
    if (side === 'BUY') {
      state.balances[base].available  += size;
      state.balances[quote].available -= cost + fee;
    } else {
      state.balances[base].available  -= size;
      state.balances[quote].available += cost - fee;
    }
    state.fills.unshift({ id:'fil_'+uid(), pair, side, size, price, fee, ts: Date.now() });
    if (state.fills.length > 100) state.fills.length = 100;
  }
  function refPrice(asset) {
    const map = { BTC: 68000, ETH: 3500, SOL: 160, AVAX: 28, LINK: 14, DOT: 6.5, ADA: 0.42, MATIC: 0.55, ARB: 0.85, OP: 1.65, UNI: 8.5, ATOM: 8, DOGE: 0.16, LDO: 1.7, USD: 1 };
    return map[asset] || 1;
  }
  function formatPrice(p) {
    if (p == null) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(3);
    return p.toFixed(4);
  }

  // -------- Auto-fill simulation (limit orders fill when price crosses) --------
  setInterval(() => {
    if (!state.openOrders.length) return;
    let changed = false;
    for (let i = state.openOrders.length - 1; i >= 0; i--) {
      const o = state.openOrders[i];
      const live = getPrice(o.pair);
      if (!live) continue;
      const shouldFill =
        (o.type === 'limit' && o.side === 'BUY'  && live <= o.price) ||
        (o.type === 'limit' && o.side === 'SELL' && live >= o.price) ||
        (o.type === 'stop'  && o.side === 'BUY'  && live >= o.stopPrice) ||
        (o.type === 'stop'  && o.side === 'SELL' && live <= o.stopPrice);
      if (shouldFill) {
        applyFill({ pair: o.pair, side: o.side, size: o.size, price: live, fee: live * o.size * 0.006 });
        addNotif({ kind:'fill', msg:`${o.side} ${o.pair} filled · ${o.size} @ $${formatPrice(live)}` });
        state.openOrders.splice(i, 1);
        changed = true;
      }
    }
    if (changed) emit();
  }, 3000);

  // expose
  window.api = api;
  window.__formatPrice = formatPrice;
})();
