// =============================================================
// VOID API client — Phase 2: real HTTP/WS bridge to FastAPI.
//
// Replaces the previous localStorage mock. Exposes the SAME public
// surface the views consume:
//
//   window.api.state()                          → snapshot of central state
//   window.api.subscribe(fn)                    → returns unsubscribe
//   window.api.portfolio()                      → { holdings, totalUsd }
//   async window.api.connect/disconnect/...
//
// Settings still live in localStorage (UI prefs only). All trading
// data is fetched from the bridge — when it is offline the relevant
// arrays stay empty and `state.bridgeOnline` flips to false so the
// UI can render its "Bridge offline" banner.
// =============================================================

(function () {
  // ------------------------------------------------------------
  // Config
  // ------------------------------------------------------------
  const BASE_URL = (window.__BRIDGE_BASE_URL || '').replace(/\/+$/, '');
  const POLL_MS = 5000;
  const BRIDGE_RETRY_MS = 10000;
  const WS_BACKOFF = [2000, 4000, 8000, 16000, 30000];
  const SETTINGS_KEY = 'void_settings_v1';
  const LEGACY_STATE_KEY = 'void_state_v1';

  // Wipe the old mock blob if it lingers from a previous build.
  try { localStorage.removeItem(LEGACY_STATE_KEY); } catch (_) {}

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function loadSettings() {
    const defaults = {
      theme: 'void',
      slippageTolerance: 0.5,
      defaultTif: 'GTC',
      confirmOrders: true,
      sounds: true,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      return { ...defaults, ...JSON.parse(raw) };
    } catch (_) {
      return defaults;
    }
  }
  function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
  }
  function tsOf(v) {
    if (v == null) return Date.now();
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const d = Date.parse(v);
    return isNaN(d) ? Date.now() : d;
  }
  function uuid() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ------------------------------------------------------------
  // Central state
  // ------------------------------------------------------------
  const state = {
    connected: false,
    mode: 'paper',
    portfolioMode: 'spot',
    leverage: 1,
    apiKey: '',
    apiSecret: '',
    passphrase: '',

    balances: {},          // { ASSET: { available, hold } }
    openOrders: [],        // shaped for views (size/price/side/type/...)
    fills: [],
    transfers: [],
    strategies: [],
    notifications: [],

    // cached portfolio used by window.api.portfolio()
    _portfolio: { holdings: [], totalUsd: 0 },

    settings: loadSettings(),

    loading: {
      portfolio: false,
      orders: false,
      fills: false,
      strategies: false,
      transfers: false,
      notifications: false,
      placeOrder: false,
      cancelOrder: false,
      transfer: false,
    },
    errors: {},

    bridgeOnline: true,
    reconnecting: false,

    // Backtest / Hyperopt jobs (in-memory, populated from bridge + WS).
    // Keyed by jobId for O(1) updates.
    backtestJobs: {},   // { [jobId]: { status, log[], result, started_at, ... } }
    hyperoptJobs: {},   // same shape, but with current_epoch/best_params/...
  };

  // ------------------------------------------------------------
  // Pub/sub
  // ------------------------------------------------------------
  const subs = new Set();
  function snapshot() {
    // Shallow copy so React's useState identity check fires.
    return { ...state };
  }
  function emit() {
    const snap = snapshot();
    subs.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }
  function setLoading(key, v) {
    state.loading = { ...state.loading, [key]: v };
  }
  function setError(key, err) {
    if (err) state.errors = { ...state.errors, [key]: err };
    else { const e = { ...state.errors }; delete e[key]; state.errors = e; }
  }

  // ------------------------------------------------------------
  // HTTP layer
  // ------------------------------------------------------------
  async function request(path, options = {}) {
    const url = BASE_URL + path;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        credentials: 'same-origin',
        ...options,
      });
    } catch (netErr) {
      // network failure → bridge unreachable
      markBridgeOffline(netErr.message || 'network error');
      throw new Error('Bridge unreachable: ' + (netErr.message || 'network'));
    }

    if (res.status === 503) {
      let body = null;
      try { body = await res.json(); } catch (_) {}
      markBridgeOffline(body?.message || 'freqtrade unreachable');
      const err = new Error(body?.message || 'Bridge offline');
      err.status = 503;
      err.detail = body;
      throw err;
    }
    if (res.status === 401) {
      // forced logout
      state.connected = false;
      emit();
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }
    // any successful response means the bridge is alive (even if it
    // bubbles a 4xx for the specific request)
    markBridgeOnline();

    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch (_) {}
      const err = new Error(body?.message || body?.detail || `HTTP ${res.status}`);
      err.status = res.status;
      err.detail = body;
      throw err;
    }
    if (res.status === 204) return null;
    try { return await res.json(); } catch (_) { return null; }
  }

  let bridgeRetryTimer = null;
  function markBridgeOffline(reason) {
    if (state.bridgeOnline) {
      state.bridgeOnline = false;
      state.reconnecting = true;
      emit();
    }
    if (!bridgeRetryTimer) {
      bridgeRetryTimer = setTimeout(() => {
        bridgeRetryTimer = null;
        // Probe by re-running the slow poll. If it succeeds the
        // success path will flip bridgeOnline back to true.
        refreshAll().catch(() => {});
      }, BRIDGE_RETRY_MS);
    }
  }
  function markBridgeOnline() {
    if (!state.bridgeOnline) {
      state.bridgeOnline = true;
      state.reconnecting = false;
      emit();
    }
  }

  // ------------------------------------------------------------
  // Backtest / Hyperopt job helpers
  // ------------------------------------------------------------
  function jobBucket(kind) {
    return kind === 'hyperopt' ? state.hyperoptJobs : state.backtestJobs;
  }
  function adaptJob(j) {
    if (!j || typeof j !== 'object') return null;
    const id = j.jobId || j.id;
    if (!id) return null;
    return {
      id,
      kind: j.kind || 'backtest',
      status: j.status || 'running',
      strategy: j.strategy || '',
      timerange: j.timerange || '',
      pairs: j.pairs || null,
      timeframe: j.timeframe || null,
      started_at: Number(j.started_at || 0) * 1000 || tsOf(j.started_at),
      finished_at: j.finished_at ? (Number(j.finished_at) * 1000 || tsOf(j.finished_at)) : null,
      log: Array.isArray(j.log) ? j.log : [],
      result: j.result || null,
      error: j.error || null,
      epochs: j.epochs ?? null,
      current_epoch: j.current_epoch ?? null,
      best_params: j.best_params ?? null,
      return_code: j.return_code ?? null,
    };
  }
  function upsertJob(kind, jobLike) {
    const adapted = adaptJob(jobLike);
    if (!adapted) return;
    adapted.kind = kind;
    const bucket = jobBucket(kind);
    const prev = bucket[adapted.id] || {};
    const merged = {
      ...prev,
      ...adapted,
      // Preserve previously-streamed log if the new payload omits it.
      log: adapted.log.length ? adapted.log : (prev.log || []),
    };
    if (kind === 'hyperopt') {
      state.hyperoptJobs = { ...state.hyperoptJobs, [adapted.id]: merged };
    } else {
      state.backtestJobs = { ...state.backtestJobs, [adapted.id]: merged };
    }
    return merged;
  }
  function applyJobEvent(kind, msg) {
    const id = msg.jobId || msg.id;
    if (!id) return;
    const bucket = jobBucket(kind);
    const prev = bucket[id] || {
      id,
      kind,
      log: [],
      status: 'running',
      strategy: msg.strategy || '',
      timerange: msg.timerange || '',
      started_at: Date.now(),
    };
    const next = { ...prev };
    if (msg.event === 'started') {
      next.status = 'running';
      if (msg.strategy) next.strategy = msg.strategy;
      if (msg.timerange) next.timerange = msg.timerange;
      next.started_at = next.started_at || Date.now();
    } else if (msg.event === 'progress') {
      if (Array.isArray(msg.log) && msg.log.length) {
        // Cap at 500 lines client-side.
        const combined = [...(prev.log || []), ...msg.log];
        next.log = combined.slice(-500);
      }
      if (msg.current_epoch != null) next.current_epoch = msg.current_epoch;
    } else if (msg.event === 'completed') {
      next.status = 'completed';
      next.finished_at = Date.now();
      if (msg.result) next.result = msg.result;
    } else if (msg.event === 'failed') {
      next.status = 'failed';
      next.finished_at = Date.now();
      next.error = msg.error || next.error;
    } else if (msg.event === 'cancelled') {
      next.status = 'cancelled';
      next.finished_at = Date.now();
    }
    if (kind === 'hyperopt') {
      state.hyperoptJobs = { ...state.hyperoptJobs, [id]: next };
    } else {
      state.backtestJobs = { ...state.backtestJobs, [id]: next };
    }
    emit();
  }

  async function fetchBacktestJobs() {
    try {
      const data = await request('/api/backtest/jobs');
      const next = { ...state.backtestJobs };
      const nextHo = { ...state.hyperoptJobs };
      (data?.jobs || []).forEach(j => {
        const adapted = adaptJob(j);
        if (!adapted) return;
        if ((j.kind || 'backtest') === 'hyperopt') nextHo[adapted.id] = { ...(nextHo[adapted.id] || {}), ...adapted };
        else next[adapted.id] = { ...(next[adapted.id] || {}), ...adapted };
      });
      state.backtestJobs = next;
      state.hyperoptJobs = nextHo;
    } catch (_) {
      // Silent — bridge offline banner already handles it.
    }
  }

  // ------------------------------------------------------------
  // Adapters: bridge shape → view shape
  // ------------------------------------------------------------
  function adaptOrder(o) {
    const side = (o.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
    return {
      id: String(o.id ?? uuid()),
      pair: o.pair || o.symbol || '',
      side,
      type: (o.type || 'limit').toLowerCase(),
      size: Number(o.amount ?? o.size ?? 0),
      price: Number(o.price ?? 0),
      filled: Number(o.filled ?? 0),
      status: o.status || 'open',
      created: tsOf(o.openedAt ?? o.created),
      tif: o.tif || 'GTC',
      raw: o.raw || o,
    };
  }
  function adaptFill(f) {
    const side = (f.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
    return {
      id: String(f.id ?? uuid()),
      pair: f.pair || '',
      side,
      size: Number(f.amount ?? f.size ?? 0),
      price: Number(f.price ?? 0),
      fee: Number(f.fee ?? 0),
      pnl: Number(f.pnl ?? 0),
      pnlPct: Number(f.pnlPct ?? 0),
      ts: tsOf(f.closedAt ?? f.openedAt ?? f.ts),
      raw: f.raw || f,
    };
  }
  function adaptTransfer(t) {
    return {
      id: String(t.id ?? uuid()),
      kind: (t.kind || t.type || 'deposit').toLowerCase(),
      asset: (t.asset || t.currency || 'USD').toUpperCase(),
      amount: Number(t.amount ?? 0),
      method: t.method || '—',
      status: (t.status || 'pending').toLowerCase(),
      ts: tsOf(t.ts ?? t.created),
      raw: t,
    };
  }
  function adaptStrategy(s) {
    const status = (s.status || 'stopped').toUpperCase();
    return {
      id: String(s.id ?? s.name ?? uuid()),
      name: s.name || s.id || 'unnamed',
      status,
      mode: s.mode || 'paper',
      pairs: s.pairs ?? (Array.isArray(s.pair_whitelist) ? s.pair_whitelist.length : 0),
      pnl30d: Number(s.pnl30d ?? 0),
      trades30d: Number(s.trades30d ?? 0),
      sharpe: Number(s.sharpe ?? 0),
      params: s.params || {},
      active: !!s.active,
    };
  }
  function adaptNotification(n) {
    let kind = n.kind;
    if (!kind) {
      const src = (n.source || '').toLowerCase();
      if (src === 'orders') kind = 'fill';
      else if (src === 'strategies') kind = 'strategy';
      else if (src === 'transfers') kind = 'transfer';
      else kind = 'system';
    }
    return {
      id: String(n.id ?? uuid()),
      kind,
      msg: n.msg || n.message || '',
      ts: tsOf(n.ts),
      read: !!n.read,
      level: n.level || 'info',
      raw: n,
    };
  }
  function adaptPortfolio(p) {
    const holdings = (p?.holdings || []).map(h => ({
      asset: (h.asset || '').toUpperCase(),
      total: Number(h.total ?? 0),
      available: Number(h.free ?? h.available ?? 0),
      hold: Number(h.hold ?? 0),
      price: Number(h.price ?? 0),
      valueUsd: Number(h.valueUsd ?? 0),
    }));
    const balances = {};
    holdings.forEach(h => {
      balances[h.asset] = { available: h.available, hold: h.hold };
    });
    return {
      portfolio: { holdings, totalUsd: Number(p?.totalUsd ?? 0) },
      balances,
    };
  }

  // ------------------------------------------------------------
  // Pollers
  // ------------------------------------------------------------
  async function fetchPortfolio() {
    setLoading('portfolio', true);
    try {
      const data = await request('/api/portfolio');
      const { portfolio, balances } = adaptPortfolio(data);
      state._portfolio = portfolio;
      state.balances = balances;
      setError('portfolio', null);
    } catch (e) {
      setError('portfolio', e.message);
    } finally {
      setLoading('portfolio', false);
    }
  }
  async function fetchOrders() {
    setLoading('orders', true);
    try {
      const data = await request('/api/orders');
      state.openOrders = (data?.orders || []).map(adaptOrder);
      setError('orders', null);
    } catch (e) {
      setError('orders', e.message);
    } finally {
      setLoading('orders', false);
    }
  }
  async function fetchFills() {
    setLoading('fills', true);
    try {
      const data = await request('/api/fills');
      state.fills = (data?.fills || []).map(adaptFill).sort((a, b) => b.ts - a.ts);
      setError('fills', null);
    } catch (e) {
      setError('fills', e.message);
    } finally {
      setLoading('fills', false);
    }
  }
  async function fetchTransfers() {
    setLoading('transfers', true);
    try {
      const data = await request('/api/transfers');
      state.transfers = (data?.transfers || []).map(adaptTransfer).sort((a, b) => b.ts - a.ts);
      setError('transfers', null);
    } catch (e) {
      setError('transfers', e.message);
    } finally {
      setLoading('transfers', false);
    }
  }
  async function fetchStrategies() {
    setLoading('strategies', true);
    try {
      const data = await request('/api/strategies');
      state.strategies = (data?.strategies || []).map(adaptStrategy);
      setError('strategies', null);
    } catch (e) {
      setError('strategies', e.message);
    } finally {
      setLoading('strategies', false);
    }
  }
  async function fetchNotifications() {
    setLoading('notifications', true);
    try {
      const data = await request('/api/notifications');
      state.notifications = (data?.notifications || []).map(adaptNotification).sort((a, b) => b.ts - a.ts);
      setError('notifications', null);
    } catch (e) {
      setError('notifications', e.message);
    } finally {
      setLoading('notifications', false);
    }
  }

  async function refreshAll() {
    await Promise.allSettled([
      fetchPortfolio(),
      fetchOrders(),
      fetchFills(),
      fetchTransfers(),
      fetchStrategies(),
      fetchNotifications(),
      fetchBacktestJobs(),
    ]);
    emit();
  }

  let pollTimer = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { refreshAll().catch(() => {}); }, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------
  let ws = null;
  let wsAttempt = 0;
  let wsTimer = null;
  function wsUrl() {
    if (BASE_URL && /^https?:/i.test(BASE_URL)) {
      return BASE_URL.replace(/^http/i, 'ws') + '/ws';
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${BASE_URL}/ws`;
  }
  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    let sock;
    try {
      sock = new WebSocket(wsUrl());
    } catch (e) {
      scheduleWsReconnect();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      wsAttempt = 0;
      // bridge is reachable on the WS layer
    };
    sock.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const channel = msg.channel || msg.type;
      if (channel === 'tick' || channel === 'pong' || channel === 'hello') return;
      if (channel === 'fill') {
        const f = adaptFill(msg.payload || msg.fill || msg);
        state.fills = [f, ...state.fills].slice(0, 500);
        emit();
        // Refresh portfolio after a fill — balances move.
        fetchPortfolio().then(emit).catch(() => {});
      } else if (channel === 'strategy') {
        const incoming = adaptStrategy(msg.payload || msg);
        const idx = state.strategies.findIndex(s => s.id === incoming.id);
        if (idx >= 0) {
          const next = state.strategies.slice();
          next[idx] = { ...next[idx], ...incoming };
          state.strategies = next;
        } else {
          state.strategies = [...state.strategies, incoming];
        }
        emit();
      } else if (channel === 'notification') {
        const n = adaptNotification(msg.payload || msg);
        state.notifications = [n, ...state.notifications].slice(0, 200);
        emit();
        if (window.__toast) {
          window.__toast({ kind: n.kind, msg: n.msg });
        }
      } else if (channel === 'backtest' || channel === 'hyperopt') {
        applyJobEvent(channel, msg);
      }
    };
    sock.onerror = () => { /* will fall through to onclose */ };
    sock.onclose = () => {
      ws = null;
      scheduleWsReconnect();
    };
  }
  function scheduleWsReconnect() {
    if (wsTimer) return;
    const delay = WS_BACKOFF[Math.min(wsAttempt, WS_BACKOFF.length - 1)];
    wsAttempt++;
    wsTimer = setTimeout(() => {
      wsTimer = null;
      connectWs();
    }, delay);
  }

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------
  const api = {
    state: snapshot,
    subscribe(fn) {
      subs.add(fn);
      // Push the current snapshot immediately so subscribers don't
      // miss the first emit on slow networks.
      try { fn(snapshot()); } catch (_) {}
      return () => subs.delete(fn);
    },
    portfolio() {
      return state._portfolio;
    },

    async connect(creds = {}) {
      try {
        const res = await request('/api/connect', {
          method: 'POST',
          body: JSON.stringify({ apiKey: creds.apiKey || '' }),
        });
        state.connected = !!res?.connected;
        state.mode = (creds.mode || state.mode || 'paper').toLowerCase();
        state.apiKey = creds.apiKey || '';
        state.apiSecret = creds.apiSecret || '';
        state.passphrase = creds.passphrase || '';
        emit();
        // Kick a refresh — bridge may have data ready.
        refreshAll().catch(() => {});
        return res;
      } catch (e) {
        // Even if the bridge is offline we let the user "connect"
        // optimistically — the views need state.connected = true to
        // leave the onboarding screen, and the banner will signal
        // the real status. This matches the spec: settings/toggles
        // keep working when bridge is down.
        state.connected = true;
        state.mode = (creds.mode || state.mode || 'paper').toLowerCase();
        state.apiKey = creds.apiKey || '';
        state.apiSecret = creds.apiSecret || '';
        state.passphrase = creds.passphrase || '';
        emit();
        // Re-throw so callers (Onboard) can show a soft warning if
        // they want — but only when it's NOT a 503 / network issue,
        // otherwise we just stay optimistic.
        if (e.status && e.status !== 503) throw e;
        return { connected: true, offline: true };
      }
    },

    async disconnect() {
      try { await request('/api/disconnect', { method: 'POST' }); } catch (_) {}
      state.connected = false;
      state.apiKey = '';
      state.apiSecret = '';
      state.passphrase = '';
      emit();
      return { ok: true };
    },

    async testConnection() {
      const t0 = performance.now();
      const res = await request('/api/connection/test');
      const latencyMs = Math.round(performance.now() - t0);
      return { ok: !!res?.ok, latencyMs, exchange: 'COINBASE', detail: res };
    },

    async placeOrder({ pair, side, type, size, price, tif }) {
      setLoading('placeOrder', true); emit();
      try {
        const body = {
          pair,
          side: side?.toLowerCase() === 'sell' ? 'short' : 'long',
          orderType: type,
          stakeAmount: size,
          price,
          tif,
        };
        const res = await request('/api/orders', { method: 'POST', body: JSON.stringify(body) });
        await Promise.allSettled([fetchOrders(), fetchPortfolio(), fetchNotifications()]);
        emit();
        return res;
      } finally {
        setLoading('placeOrder', false); emit();
      }
    },

    async cancelOrder(id) {
      setLoading('cancelOrder', true); emit();
      try {
        const res = await request(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await Promise.allSettled([fetchOrders(), fetchPortfolio()]);
        emit();
        return res;
      } finally {
        setLoading('cancelOrder', false); emit();
      }
    },

    async cancelAll() {
      setLoading('cancelOrder', true); emit();
      try {
        const res = await request('/api/orders', { method: 'DELETE' });
        await Promise.allSettled([fetchOrders(), fetchPortfolio()]);
        emit();
        return res;
      } finally {
        setLoading('cancelOrder', false); emit();
      }
    },

    async modifyOrder(id, patch) {
      // The bridge does not expose modify — emulate via cancel+place.
      const existing = state.openOrders.find(o => o.id === id);
      if (!existing) throw new Error('Order not found');
      await api.cancelOrder(id);
      return api.placeOrder({
        pair: existing.pair,
        side: existing.side,
        type: existing.type,
        size: Number(patch.size ?? existing.size),
        price: Number(patch.price ?? existing.price),
        tif: existing.tif,
      });
    },

    async deposit({ asset, amount, method }) {
      setLoading('transfer', true); emit();
      try {
        const res = await request('/api/transfers/deposit', {
          method: 'POST',
          body: JSON.stringify({ asset, amount, method }),
        });
        await fetchTransfers(); emit();
        if (res?.ok === false) {
          const err = new Error(res.message || 'Deposit unavailable');
          err.detail = res;
          throw err;
        }
        return res;
      } finally {
        setLoading('transfer', false); emit();
      }
    },

    async withdraw({ asset, amount, address }) {
      setLoading('transfer', true); emit();
      try {
        const res = await request('/api/transfers/withdraw', {
          method: 'POST',
          body: JSON.stringify({ asset, amount, address }),
        });
        await fetchTransfers(); emit();
        if (res?.ok === false) {
          const err = new Error(res.message || 'Withdrawal unavailable');
          err.detail = res;
          throw err;
        }
        return res;
      } finally {
        setLoading('transfer', false); emit();
      }
    },

    async setStrategyStatus(id, status) {
      const action = (status || '').toLowerCase() === 'running' ? 'start' :
                      (status || '').toLowerCase() === 'paused'  ? 'stop'  :
                      (status || '').toLowerCase() === 'stopped' ? 'stop'  : status;
      const res = await request(`/api/strategies/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: action }),
      });
      await fetchStrategies(); emit();
      return res;
    },

    async updateStrategyParams(id, params) {
      const res = await request(`/api/strategies/${encodeURIComponent(id)}/params`, {
        method: 'PATCH',
        body: JSON.stringify(params),
      });
      await fetchStrategies(); emit();
      return res;
    },

    setSetting(key, value) {
      state.settings = { ...state.settings, [key]: value };
      saveSettings(state.settings);
      emit();
    },

    async markAllRead() {
      // Optimistic local update so the UI feels snappy.
      state.notifications = state.notifications.map(n => ({ ...n, read: true }));
      emit();
      try { await request('/api/notifications/read-all', { method: 'POST' }); } catch (_) {}
      return { ok: true };
    },

    async clearNotifs() {
      state.notifications = [];
      emit();
      try { await request('/api/notifications', { method: 'DELETE' }); } catch (_) {}
      return { ok: true };
    },

    // ---------- Backtest ----------
    backtest: {
      async run({ strategy, timerange, pairs, timeframe } = {}) {
        if (!strategy) throw new Error("backtest.run: 'strategy' required");
        const res = await request('/api/backtest/run', {
          method: 'POST',
          body: JSON.stringify({ strategy, timerange, pairs, timeframe }),
        });
        // Seed local job entry so UI shows it immediately.
        if (res?.jobId) {
          upsertJob('backtest', {
            jobId: res.jobId,
            status: res.status || 'running',
            strategy,
            timerange,
            pairs,
            timeframe,
            started_at: Date.now() / 1000,
            log: [],
          });
          emit();
        }
        return res;
      },
      async jobs() {
        await fetchBacktestJobs();
        emit();
        const out = Object.values(state.backtestJobs).sort(
          (a, b) => (b.started_at || 0) - (a.started_at || 0),
        );
        return out;
      },
      async job(jobId) {
        if (!jobId) throw new Error('backtest.job: jobId required');
        const data = await request(`/api/backtest/jobs/${encodeURIComponent(jobId)}`);
        const merged = upsertJob('backtest', data);
        emit();
        return merged;
      },
      async cancel(jobId) {
        if (!jobId) throw new Error('backtest.cancel: jobId required');
        const res = await request(
          `/api/backtest/jobs/${encodeURIComponent(jobId)}/cancel`,
          { method: 'POST' },
        );
        // Optimistic local update; the WS event will confirm.
        const prev = state.backtestJobs[jobId];
        if (prev) {
          state.backtestJobs = { ...state.backtestJobs, [jobId]: { ...prev, status: 'cancelled' } };
          emit();
        }
        return res;
      },
    },

    // ---------- Hyperopt ----------
    hyperopt: {
      async run({ strategy, epochs, timerange, spaces, loss, timeframe } = {}) {
        if (!strategy) throw new Error("hyperopt.run: 'strategy' required");
        const res = await request('/api/hyperopt/run', {
          method: 'POST',
          body: JSON.stringify({ strategy, epochs, timerange, spaces, loss, timeframe }),
        });
        if (res?.jobId) {
          upsertJob('hyperopt', {
            jobId: res.jobId,
            status: res.status || 'running',
            strategy,
            timerange,
            timeframe,
            epochs: epochs ?? null,
            spaces: spaces ?? null,
            loss: loss ?? null,
            started_at: Date.now() / 1000,
            log: [],
          });
          emit();
        }
        return res;
      },
      async jobs() {
        await fetchBacktestJobs();
        emit();
        return Object.values(state.hyperoptJobs).sort(
          (a, b) => (b.started_at || 0) - (a.started_at || 0),
        );
      },
      async job(jobId) {
        if (!jobId) throw new Error('hyperopt.job: jobId required');
        const data = await request(`/api/hyperopt/jobs/${encodeURIComponent(jobId)}`);
        const merged = upsertJob('hyperopt', data);
        emit();
        return merged;
      },
      async cancel(jobId) {
        if (!jobId) throw new Error('hyperopt.cancel: jobId required');
        const res = await request(
          `/api/hyperopt/jobs/${encodeURIComponent(jobId)}/cancel`,
          { method: 'POST' },
        );
        const prev = state.hyperoptJobs[jobId];
        if (prev) {
          state.hyperoptJobs = { ...state.hyperoptJobs, [jobId]: { ...prev, status: 'cancelled' } };
          emit();
        }
        return res;
      },
    },
  };

  // ------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------
  window.api = api;

  // Initial fetch + polling. Don't crash if bridge is down — the
  // request() helper marks bridgeOnline=false and the banner shows.
  refreshAll().finally(() => {
    emit();
    startPolling();
  });
  connectWs();

  // Expose tiny debug surface for dev tools.
  window.__api = { refreshAll, connectWs, state };
})();
