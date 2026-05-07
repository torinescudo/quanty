// VOID dashboard — Coinbase WS (real) + simulated freqtrade bridge data
const PRODUCTS = [
  "BTC-USD","ETH-USD","SOL-USD","AVAX-USD","MATIC-USD","ARB-USD","OP-USD",
  "LINK-USD","ATOM-USD","DOT-USD","ADA-USD","DOGE-USD","UNI-USD","LDO-USD"
];

const state = {
  prices: {}, prevPrices: {}, open24h: {}, sparkBuf: {},
  tickCount: 0, tickRate: 0, lastTickTime: 0, lastSecondTicks: 0,
  daily: [],
  startTime: Date.now(),
  latency: null,
};

// --- formatting ---
function fmtPrice(p) {
  if (p == null) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}
function fmtPct(p) { return (p >= 0 ? "+" : "") + p.toFixed(2) + "%"; }
function fmtMoney(v) {
  const sign = v >= 0 ? "+$" : "-$";
  return sign + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600).toString().padStart(2, "0");
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

// === TICKERS / CONSTELLATION ===
function buildTickers() {
  const list = document.getElementById("tickerList");
  list.innerHTML = PRODUCTS.map((p, i) => {
    const sym = p.replace("-USD", "");
    return `
      <div class="ticker-row" id="tk-${p}">
        <span class="ticker-idx">${(i+1).toString().padStart(2,"0")}</span>
        <span class="ticker-sym">${sym}</span>
        <svg class="ticker-spark" id="tk-${p}-spark" viewBox="0 0 80 18" preserveAspectRatio="none"></svg>
        <span class="ticker-price mono" id="tk-${p}-price">—</span>
        <span class="ticker-chg mono" id="tk-${p}-chg" style="color: var(--text-tertiary);">—</span>
        <span class="ticker-arr mono" id="tk-${p}-arr"></span>
      </div>`;
  }).join("");
}

function updateTicker(product, price) {
  state.prevPrices[product] = state.prices[product];
  state.prices[product] = price;
  if (state.open24h[product] === undefined) state.open24h[product] = price;
  // sparkline buffer
  if (!state.sparkBuf[product]) state.sparkBuf[product] = [];
  const buf = state.sparkBuf[product];
  buf.push(price);
  if (buf.length > 40) buf.shift();

  const priceEl = document.getElementById(`tk-${product}-price`);
  if (!priceEl) return;
  priceEl.textContent = fmtPrice(price);
  const pct = ((price - state.open24h[product]) / state.open24h[product]) * 100;
  const chgEl = document.getElementById(`tk-${product}-chg`);
  chgEl.textContent = fmtPct(pct);
  chgEl.className = "ticker-chg mono " + (pct >= 0 ? "pos" : "neg");

  const arrEl = document.getElementById(`tk-${product}-arr`);
  const rowEl = document.getElementById(`tk-${product}`);
  const prev = state.prevPrices[product];
  if (prev !== undefined) {
    const up = price > prev;
    arrEl.textContent = up ? "▲" : (price < prev ? "▼" : "·");
    arrEl.className = "ticker-arr mono " + (up ? "pos" : "neg");
    rowEl.classList.remove("flash-up", "flash-down"); void rowEl.offsetWidth;
    rowEl.classList.add(up ? "flash-up" : "flash-down");
  }

  // sparkline
  if (buf.length >= 2) {
    const min = Math.min(...buf);
    const max = Math.max(...buf);
    const range = max - min || 1;
    const w = 80, h = 18;
    const pts = buf.map((v, i) => {
      const x = (i / (buf.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const lastUp = buf[buf.length - 1] >= buf[0];
    const color = lastUp ? "#5eead4" : "#fb7185";
    const spark = document.getElementById(`tk-${product}-spark`);
    if (spark) {
      spark.innerHTML = `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1" opacity="0.85" />`;
    }
  }
}

// === COINBASE WS — REAL DATA ===
function connectCoinbase() {
  let pingStart = 0;
  const ws = new WebSocket("wss://advanced-trade-ws.coinbase.com");
  ws.onopen = () => {
    document.getElementById("connStatus").textContent = "UPLINK · LIVE";
    document.getElementById("connStatus").style.color = "var(--accent)";
    document.getElementById("pulseDot").className = "pulse-dot";
    pingStart = Date.now();
    ws.send(JSON.stringify({ type: "subscribe", product_ids: PRODUCTS, channel: "ticker" }));
  };
  ws.onmessage = (ev) => {
    if (state.latency === null) state.latency = Date.now() - pingStart;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.channel === "ticker" && msg.events) {
        msg.events.forEach(e => {
          if (e.tickers) e.tickers.forEach(t => {
            const price = parseFloat(t.price);
            if (!isNaN(price)) {
              updateTicker(t.product_id, price);
              state.tickCount++; state.lastSecondTicks++;
              state.lastTickTime = Date.now();
            }
          });
        });
      }
    } catch (_) { }
  };
  ws.onclose = () => {
    document.getElementById("connStatus").textContent = "UPLINK · LOST";
    document.getElementById("connStatus").style.color = "var(--neg)";
    document.getElementById("pulseDot").className = "pulse-dot dead";
    setTimeout(connectCoinbase, 3000);
  };
  ws.onerror = () => ws.close();
}

// === SIMULATED FREQTRADE BRIDGE DATA ===
// (since we're standalone — generate realistic snapshots that mimic the real bridge)
function generateSnapshot() {
  const now = Date.now();
  // realistic: paper trading, ~14 days running
  const daysRun = 22;
  const baseEquity = 10000;

  // daily P&L — realistic equity curve with some drawdowns
  const daily = [];
  let cum = 0;
  const seed = 0.12;
  for (let i = 0; i < 30; i++) {
    const drift = Math.sin(i * 0.4) * 35 + Math.cos(i * 0.7) * 18;
    const noise = (Math.sin(i * 13.7) * 0.5 + Math.sin(i * 7.3) * 0.5) * 60;
    const dayPnL = drift + noise + (i > 18 ? 25 : 0); // upward bias recent
    daily.push({
      date: new Date(now - (29 - i) * 86400000).toISOString().slice(0, 10),
      abs_profit: dayPnL,
    });
    cum += dayPnL;
  }
  const totalProfit = cum;

  // open trades (3 satellites in orbit)
  const open = [
    { pair: "BTC-USD", profit_abs: 42.18, profit_ratio: 0.018, open_rate: state.prices["BTC-USD"] ? state.prices["BTC-USD"] * 0.987 : 67500, current_rate: state.prices["BTC-USD"] || 68380, stake_amount: 2400, open_date: new Date(now - 4 * 3600000).toISOString(), enter_tag: "sma_cross_up" },
    { pair: "ETH-USD", profit_abs: -18.45, profit_ratio: -0.011, open_rate: state.prices["ETH-USD"] ? state.prices["ETH-USD"] * 1.011 : 3520, current_rate: state.prices["ETH-USD"] || 3482, stake_amount: 1700, open_date: new Date(now - 9 * 3600000).toISOString(), enter_tag: "sma_cross_up" },
    { pair: "SOL-USD", profit_abs: 28.94, profit_ratio: 0.024, open_rate: state.prices["SOL-USD"] ? state.prices["SOL-USD"] * 0.977 : 158, current_rate: state.prices["SOL-USD"] || 161.7, stake_amount: 1200, open_date: new Date(now - 1.5 * 3600000).toISOString(), enter_tag: "sma_cross_up" },
  ];

  // recent closed trades
  const closedSrc = [
    { pair: "LINK-USD", profit_abs: 18.32, exit_reason: "trailing_stop_loss", hAgo: 1.2 },
    { pair: "AVAX-USD", profit_abs: -22.15, exit_reason: "stop_loss",       hAgo: 3.5 },
    { pair: "ARB-USD",  profit_abs: 31.80, exit_reason: "roi",              hAgo: 5.8 },
    { pair: "DOT-USD",  profit_abs: 12.45, exit_reason: "sma_cross_down",   hAgo: 8.1 },
    { pair: "ADA-USD",  profit_abs: -9.62, exit_reason: "stop_loss",        hAgo: 11.4 },
    { pair: "MATIC-USD",profit_abs: 24.18, exit_reason: "roi",              hAgo: 14.0 },
    { pair: "OP-USD",   profit_abs: 16.50, exit_reason: "trailing_stop_loss", hAgo: 18.2 },
    { pair: "DOGE-USD", profit_abs: -7.30, exit_reason: "sma_cross_down",   hAgo: 22.1 },
    { pair: "UNI-USD",  profit_abs: 28.60, exit_reason: "roi",              hAgo: 26.5 },
    { pair: "ATOM-USD", profit_abs: 9.85,  exit_reason: "trailing_stop_loss", hAgo: 31.0 },
  ];
  const closed = closedSrc.map(t => ({
    ...t,
    close_date: new Date(now - t.hAgo * 3600000).toISOString(),
    open_date: new Date(now - (t.hAgo + 6) * 3600000).toISOString(),
  }));

  const wins = closed.filter(t => t.profit_abs > 0).length;
  const losses = closed.filter(t => t.profit_abs <= 0).length;

  // performance per pair
  const perfMap = {};
  closed.concat(open).forEach(t => {
    perfMap[t.pair] = (perfMap[t.pair] || 0) + (t.profit_abs || 0);
  });
  const performance = Object.entries(perfMap)
    .map(([pair, profit_abs]) => ({ pair, profit_abs }))
    .sort((a, b) => b.profit_abs - a.profit_abs);

  return {
    ts: now / 1000,
    open_trades: open,
    profit: {
      profit_all_coin: totalProfit,
      profit_all_percent_mean: (totalProfit / baseEquity) * 100,
      winning_trades: wins,
      losing_trades: losses,
    },
    balance: { value: baseEquity + totalProfit },
    daily: { data: daily },
    performance,
    recent_trades: { trades: closed, trades_count: closed.length + open.length + 38 },
    show_config: { strategy: "SmaCross", dry_run: true },
  };
}

// === RENDER METRICS ===
function renderSnapshot(snap) {
  const profit = snap.profit || {};
  const balance = snap.balance || {};
  const trades = snap.recent_trades?.trades || [];
  const open = snap.open_trades || [];
  const daily = snap.daily?.data || [];
  const perf = snap.performance || [];

  // Equity
  const equity = balance.value;
  if (equity != null) {
    document.getElementById("mEquity").textContent = "$" + equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const totalProfit = profit.profit_all_coin ?? 0;
  const profitPct = profit.profit_all_percent_mean ?? 0;
  const dayChange = daily.length ? daily[daily.length - 1].abs_profit : 0;
  document.getElementById("mEquityChg").innerHTML = `
    <span class="hud-sub-chip ${dayChange >= 0 ? 'pos' : 'neg'}">${fmtPct((dayChange / equity) * 100)}</span>
    <span style="color: var(--text-tertiary);">24H · Δ ${fmtMoney(dayChange)}</span>`;

  document.getElementById("mProfit").textContent = fmtMoney(totalProfit);
  document.getElementById("mProfit").className = "hud-value mono " + (totalProfit >= 0 ? "pos" : "neg");
  document.getElementById("mProfitSub").innerHTML = `
    <span class="hud-sub-chip ${profitPct >= 0 ? 'pos' : 'neg'}">${fmtPct(profitPct)}</span>
    <span style="color: var(--text-tertiary);">SINCE INCEPTION</span>`;

  document.getElementById("mPos").textContent = open.length.toString().padStart(2, "0");
  const exposure = open.reduce((s, t) => s + (t.stake_amount || 0), 0);
  document.getElementById("mPosSub").innerHTML = open.length === 0
    ? `<span style="color: var(--text-tertiary);">— vacuum —</span>`
    : `<span class="hud-sub-chip warn">${open.length} sat</span><span style="color: var(--text-tertiary);">$${exposure.toFixed(0)} EXPOSED</span>`;

  const wins = profit.winning_trades ?? 0;
  const losses = profit.losing_trades ?? 0;
  const total = wins + losses;
  if (total > 0) {
    const wr = (wins / total) * 100;
    document.getElementById("mWin").textContent = wr.toFixed(0) + "%";
    document.getElementById("mWin").className = "hud-value mono " + (wr > 55 ? "pos" : (wr < 45 ? "neg" : ""));
    document.getElementById("mWinSub").innerHTML = `
      <span class="hud-sub-chip" style="color: var(--solar);">${wins}W</span>
      <span class="hud-sub-chip neg">${losses}L</span>
      <span style="color: var(--text-tertiary);">${total} CLOSED</span>`;
  }

  // Mission state
  const isPaper = snap.show_config?.dry_run;
  const missionEl = document.getElementById("missionState");
  if (open.length > 0) {
    missionEl.textContent = "CRUISE";
    missionEl.style.color = "var(--accent)";
  } else {
    missionEl.textContent = "STANDBY";
    missionEl.style.color = "var(--solar)";
  }
  document.getElementById("topStrat").textContent = snap.show_config?.strategy || "—";
  document.getElementById("topMode").innerHTML = isPaper
    ? `<span style="color: var(--solar);">PAPER</span>`
    : `<span style="color: var(--neg);">LIVE</span>`;
  document.getElementById("mTradesCount").textContent = (snap.recent_trades?.trades_count || 0).toString();
  document.getElementById("mPairs").textContent = PRODUCTS.length.toString();

  // Daily for chart
  if (daily.length > 0) {
    state.daily = daily.map(d => ({ t: new Date(d.date).getTime(), v: parseFloat(d.abs_profit) }));
    drawTrajectory();
  }

  // Performance bars
  if (perf.length > 0) {
    const max = Math.max(...perf.map(p => Math.abs(p.profit_abs || 0)), 0.01);
    document.getElementById("perfList").innerHTML = perf.slice(0, 10).map(p => {
      const pct = (Math.abs(p.profit_abs || 0) / max) * 100;
      const isPos = (p.profit_abs || 0) >= 0;
      return `
        <div class="perf-row">
          <span class="perf-pair">${p.pair.replace("-USD", "")}</span>
          <div class="perf-track">
            <div class="perf-fill ${isPos ? '' : 'neg'}" style="${isPos ? 'left:50%' : 'right:50%'}; width:${pct/2}%;"></div>
          </div>
          <span class="perf-val ${isPos ? 'pos' : 'neg'} mono">${fmtMoney(p.profit_abs || 0)}</span>
        </div>`;
    }).join("");
  }

  // Trades log / transmissions
  const allTrades = [
    ...open.map(t => ({ ...t, _state: "OPEN" })),
    ...trades.slice(0, 10).map(t => ({ ...t, _state: "CLOSED" })),
  ];
  if (allTrades.length > 0) {
    document.getElementById("logList").innerHTML = allTrades.map(t => {
      const pnl = t.profit_abs ?? 0;
      const isOpen = t._state === "OPEN";
      const iconClass = isOpen ? "open" : (pnl >= 0 ? "close-pos" : "close-neg");
      const action = isOpen ? "OPEN · TX" : "CLOSE";
      const actionColor = isOpen ? "warn" : (pnl >= 0 ? "pos" : "neg");
      const time = t.close_date || t.open_date || "";
      const tShort = time ? time.slice(11, 16) + "z" : "";
      const note = t.exit_reason || t.enter_tag || "—";
      const pnlText = isOpen ? fmtMoney(t.profit_abs || 0) : fmtMoney(pnl);
      const pnlClass = (t.profit_abs || 0) >= 0 ? "pos" : "neg";
      return `
        <div class="log-row">
          <span class="log-icon ${iconClass}"></span>
          <span class="log-time">${tShort}</span>
          <span class="log-action ${actionColor}">${action}</span>
          <span class="log-pair">${t.pair}</span>
          <span class="log-pnl ${pnlClass}">${pnlText}</span>
          <span class="log-note">${note.replace(/_/g, " ")}</span>
        </div>`;
    }).join("");
  }

  // Orbital positions
  drawOrbital(open);
}

// === TRAJECTORY (equity curve) ===
function drawTrajectory() {
  const canvas = document.getElementById("eqCanvas");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.offsetWidth;
  const h = canvas.parentElement.offsetHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = state.daily;
  if (data.length < 2) return;

  // cumulative
  let cum = 0;
  const cumData = data.map(d => { cum += d.v; return { t: d.t, v: cum }; });
  const min = Math.min(...cumData.map(d => d.v), 0);
  const max = Math.max(...cumData.map(d => d.v), 0.01);
  const range = max - min || 1;

  document.getElementById("trajMax").textContent = "$" + max.toFixed(0);
  document.getElementById("trajMin").textContent = "$" + min.toFixed(0);

  // grid lines (orbital rings concept — horizontal)
  ctx.strokeStyle = "rgba(94,234,212,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * h;
    ctx.beginPath();
    ctx.setLineDash([2, 4]);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // zero line
  const zeroY = h - ((0 - min) / range) * (h - 20) - 10;
  ctx.strokeStyle = "rgba(148,163,184,0.18)";
  ctx.beginPath();
  ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
  ctx.fillStyle = "rgba(148,163,184,0.5)";
  ctx.font = "9px 'JetBrains Mono', monospace";
  ctx.fillText("0", 4, zeroY - 3);

  const last = cumData[cumData.length - 1].v;
  const isUp = last >= 0;
  const color = isUp ? "#5eead4" : "#fb7185";
  const colorSoft = isUp ? "rgba(94,234,212,0.18)" : "rgba(251,113,133,0.18)";

  // gradient fill under curve
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, colorSoft);
  grad.addColorStop(1, "rgba(94,234,212,0)");

  const points = cumData.map((d, i) => {
    const x = (i / (cumData.length - 1)) * w;
    const y = h - ((d.v - min) / range) * (h - 20) - 10;
    return { x, y };
  });

  // fill
  ctx.beginPath();
  ctx.moveTo(points[0].x, h);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // last point — pulsing satellite
  const lp = points[points.length - 1];
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.003);
  ctx.beginPath();
  ctx.arc(lp.x, lp.y, 3 + pulse * 1.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.shadowBlur = 0;
  // outer ring
  ctx.beginPath();
  ctx.arc(lp.x, lp.y, 7 + pulse * 3, 0, Math.PI * 2);
  ctx.strokeStyle = color + "55";
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

// === ORBITAL POSITIONS (satellites around equity core) ===
let orbitalAngles = {};
function drawOrbital(open) {
  const svg = document.getElementById("orbitalSvg");
  const exposure = open.reduce((s, t) => s + (t.stake_amount || 0), 0);
  document.getElementById("orbitalExposure").textContent = "$" + exposure.toFixed(0);
  document.getElementById("orbitalSubtext").textContent = open.length > 0
    ? `${open.length} satellite${open.length > 1 ? "s" : ""} in orbit`
    : "awaiting positions";
  document.getElementById("orbitalCount").textContent = open.length === 0
    ? "0 active" : `${open.length} active`;
  document.getElementById("orbitalEmpty").style.display = open.length === 0 ? "block" : "none";

  const cx = 300, cy = 180;
  const orbits = [90, 130, 170];
  const totalStake = exposure || 1;

  let inner = "";
  // central core
  inner += `<circle cx="${cx}" cy="${cy}" r="32" fill="rgba(94,234,212,0.04)" stroke="rgba(94,234,212,0.4)" stroke-width="0.8"/>`;
  inner += `<circle cx="${cx}" cy="${cy}" r="22" fill="none" stroke="rgba(94,234,212,0.15)" stroke-width="0.5"/>`;
  // crosshair
  inner += `<line x1="${cx-44}" y1="${cy}" x2="${cx-36}" y2="${cy}" stroke="rgba(94,234,212,0.4)" stroke-width="0.8"/>`;
  inner += `<line x1="${cx+36}" y1="${cy}" x2="${cx+44}" y2="${cy}" stroke="rgba(94,234,212,0.4)" stroke-width="0.8"/>`;
  inner += `<line x1="${cx}" y1="${cy-44}" x2="${cx}" y2="${cy-36}" stroke="rgba(94,234,212,0.4)" stroke-width="0.8"/>`;
  inner += `<line x1="${cx}" y1="${cy+36}" x2="${cx}" y2="${cy+44}" stroke="rgba(94,234,212,0.4)" stroke-width="0.8"/>`;

  // orbital rings
  orbits.forEach((r, i) => {
    inner += `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.5}" fill="none" stroke="rgba(94,234,212,${0.18 - i * 0.03})" stroke-width="0.6" stroke-dasharray="${i === 0 ? '' : '2 4'}"/>`;
  });

  // satellites
  open.forEach((t, i) => {
    const orbitR = orbits[i % orbits.length];
    if (!orbitalAngles[t.pair]) orbitalAngles[t.pair] = (i * 137.5) % 360;
    orbitalAngles[t.pair] += 0.15; // slow orbit
    const angle = (orbitalAngles[t.pair] * Math.PI) / 180;
    const x = cx + orbitR * Math.cos(angle);
    const y = cy + orbitR * 0.5 * Math.sin(angle);
    const profit = t.profit_abs || 0;
    const color = profit >= 0 ? "#5eead4" : "#fb7185";
    const stakePct = (t.stake_amount || 0) / totalStake;
    const satSize = 4 + stakePct * 6;

    // trail (faint arc behind)
    const trailStart = angle - 0.6;
    const trailEnd = angle - 0.05;
    const arcPoints = [];
    for (let a = trailStart; a <= trailEnd; a += 0.06) {
      arcPoints.push(`${cx + orbitR * Math.cos(a)},${cy + orbitR * 0.5 * Math.sin(a)}`);
    }
    inner += `<polyline points="${arcPoints.join(' ')}" fill="none" stroke="${color}" stroke-width="0.8" opacity="0.35"/>`;

    // satellite
    inner += `
      <circle cx="${x}" cy="${y}" r="${satSize + 4}" fill="${color}" opacity="0.12"/>
      <circle cx="${x}" cy="${y}" r="${satSize}" fill="${color}" opacity="0.95"/>
      <circle cx="${x}" cy="${y}" r="${satSize * 0.4}" fill="#02030a"/>
    `;

    // label
    const labelX = x + (Math.cos(angle) >= 0 ? satSize + 8 : -satSize - 8);
    const anchor = Math.cos(angle) >= 0 ? "start" : "end";
    const sym = t.pair.replace("-USD", "");
    inner += `
      <text x="${labelX}" y="${y - 2}" text-anchor="${anchor}" font-family="JetBrains Mono, monospace" font-size="10" fill="#e2e8f0" letter-spacing="0.5">${sym}</text>
      <text x="${labelX}" y="${y + 9}" text-anchor="${anchor}" font-family="JetBrains Mono, monospace" font-size="9" fill="${color}" letter-spacing="0.3">${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}</text>
    `;
  });

  svg.innerHTML = inner;
}

// === CLOCK + UPTIME + TICK RATE ===
function tick() {
  const now = new Date();
  document.getElementById("clock").textContent =
    now.toLocaleTimeString("en-GB", { hour12: false }) + "z";
  document.getElementById("mUptime").textContent = fmtUptime(Date.now() - state.startTime);
  document.getElementById("footTs").textContent = "T+" + fmtUptime(Date.now() - state.startTime);

  if (state.lastTickTime) {
    const ago = Math.floor((Date.now() - state.lastTickTime) / 1000);
    document.getElementById("lastTickAgo").textContent = ago === 0 ? "LIVE · 0s" : ago + "s AGO";
  }

  // tick rate (per sec)
  state.tickRate = state.lastSecondTicks;
  state.lastSecondTicks = 0;
  document.getElementById("mTickRate").textContent = state.tickRate + " t/s";
  document.getElementById("mLatency").textContent = state.latency != null ? state.latency + " ms" : "— ms";
}

// === ANIMATION LOOP for orbits + trajectory pulse ===
function animLoop() {
  // re-render orbital + trajectory cheap pieces
  if (window.__lastSnap) drawOrbital(window.__lastSnap.open_trades || []);
  drawTrajectory();
  requestAnimationFrame(animLoop);
}

// === BOOT ===
buildTickers();
connectCoinbase();
setInterval(tick, 1000);

// Simulate the freqtrade bridge: initial snapshot + updates
function pushSnapshot() {
  const snap = generateSnapshot();
  window.__lastSnap = snap;
  renderSnapshot(snap);
}
pushSnapshot();
setInterval(pushSnapshot, 4000);
requestAnimationFrame(animLoop);
window.addEventListener("resize", drawTrajectory);
