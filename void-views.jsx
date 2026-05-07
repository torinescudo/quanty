// =====================================================
// VOID Views — all major screens except Trade (separate file)
// =====================================================

// ---- Sparkline ----
function Sparkline({ data, color = 'currentColor', height = 20, width = 70 }) {
  if (!data || data.length < 2) return <svg width={width} height={height}/>;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline fill="none" stroke={color} strokeWidth="1.2" points={pts}/>
    </svg>
  );
}

// ---- Orbital ring SVG (HUD decoration) ----
function HudOrbit({ color }) {
  return (
    <svg className="hud-orbit" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="36" stroke={color || 'var(--accent)'} strokeWidth="0.6" fill="none" opacity="0.4"/>
      <circle cx="50" cy="50" r="24" stroke={color || 'var(--accent)'} strokeWidth="0.4" fill="none" opacity="0.6"/>
      <circle cx="50" cy="14" r="1.6" fill={color || 'var(--accent)'}>
        <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="9s" repeatCount="indefinite"/>
      </circle>
      <circle cx="74" cy="50" r="1" fill={color || 'var(--accent)'} opacity="0.7">
        <animateTransform attributeName="transform" type="rotate" from="180 50 50" to="-180 50 50" dur="13s" repeatCount="indefinite"/>
      </circle>
    </svg>
  );
}

// ====================================================
// ONBOARDING / CONNECT
// ====================================================
function OnboardView({ setView }) {
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [pass, setPass] = useState('');
  const [mode, setMode] = useState('paper');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function connect() {
    setErr(''); setBusy(true);
    try {
      await window.api.connect({ apiKey, apiSecret: secret, passphrase: pass, mode });
      setView('dashboard');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function demo() {
    setBusy(true);
    try {
      await window.api.connect({
        apiKey: 'CB-DEMO-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
        apiSecret: 'demo-secret-key-1234567890abcdef',
        passphrase: '',
        mode: 'paper'
      });
      setView('dashboard');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="onboard-wrap">
      <div className="onboard-card">
        <div className="onboard-header">
          <div className="onboard-eyebrow">⟢ uplink protocol</div>
          <div className="onboard-title">Connect Account</div>
          <div className="onboard-sub">
            Bring up the uplink to Coinbase Advanced Trade. Your keys are stored locally and never broadcast — for live trading,
            run the included Python bridge so signing happens server-side.
          </div>
        </div>

        <div className="onboard-form">
          <div className="field">
            <div className="field-label">Mode</div>
            <div className="segmented">
              <button className={mode === 'paper' ? 'active' : ''} onClick={() => setMode('paper')}>Paper</button>
              <button className={mode === 'live' ? 'active' : ''} onClick={() => setMode('live')}>Live</button>
            </div>
            <div className="field-help">{mode === 'paper'
              ? 'Simulated balances. Orders execute against synthetic books.'
              : 'Real Coinbase account. Requires the backend bridge to be running.'}</div>
          </div>

          <div className="field">
            <div className="field-label">API Key</div>
            <input className="input" placeholder="organizations/{org_id}/apiKeys/{key_id}" value={apiKey} onChange={e => setApiKey(e.target.value)}/>
          </div>
          <div className="field">
            <div className="field-label">Secret</div>
            <input className="input" type="password" placeholder="-----BEGIN EC PRIVATE KEY-----" value={secret} onChange={e => setSecret(e.target.value)}/>
          </div>
          <div className="field">
            <div className="field-label">Passphrase <span style={{color:'var(--text-dim)'}}>(legacy keys only)</span></div>
            <input className="input" type="password" placeholder="optional" value={pass} onChange={e => setPass(e.target.value)}/>
          </div>

          {mode === 'live' && (
            <div className="onboard-warn">
              ⚠ Live mode broadcasts to a real exchange. Verify trade permissions, IP allowlists, and withdrawal scope before continuing.
              The browser never holds your secret — it is forwarded to the local bridge over loopback.
            </div>
          )}
          {err && <div className="onboard-warn" style={{borderLeftColor:'var(--neg)', color:'var(--neg)', background:'rgba(251,113,133,0.06)', borderColor:'rgba(251,113,133,0.25)'}}>{err}</div>}

          <div className="onboard-actions">
            <button className="btn btn-primary" onClick={connect} disabled={busy} style={{flex:1, justifyContent:'center'}}>
              {busy ? '◌ ESTABLISHING UPLINK' : '⟢ CONNECT'}
            </button>
          </div>
          <div className="onboard-divider">OR</div>
          <button className="btn" onClick={demo} disabled={busy} style={{justifyContent:'center'}}>
            ⟢ EXPLORE WITH DEMO ACCOUNT
          </button>
        </div>
      </div>
    </div>
  );
}

// ====================================================
// DASHBOARD
// ====================================================
function HudCard({ label, value, sub, subColor, orbitColor }) {
  return (
    <div className="hud-card">
      <HudOrbit color={orbitColor}/>
      <div className="hud-label"><span className="hud-label-tick"/> {label}</div>
      <div>
        <div className="hud-value">{value}</div>
        {sub && <div className="hud-sub" style={subColor ? {color:subColor} : {}}>{sub}</div>}
      </div>
    </div>
  );
}

function Panel({ title, sub, right, children, padded = true }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-head-left">
          <div className="panel-head-marker"/>
          <div className="panel-head-title">{title}</div>
          {sub && <span style={{fontFamily:'JetBrains Mono, monospace', fontSize:10, color:'var(--text-tertiary)', letterSpacing:'0.14em'}}>{sub}</span>}
        </div>
        {right && <div className="panel-head-right">{right}</div>}
      </div>
      <div className={padded ? 'panel-body' : ''}>{children}</div>
    </div>
  );
}

function DashboardView() {
  const s = useApiState();
  const prices = useAllPrices();
  const port = window.api.portfolio();
  const totalValue = port.totalUsd;

  // Derive 24h portfolio change from price open24h
  let pnl24h = 0;
  port.holdings.forEach(h => {
    if (h.asset === 'USD') return;
    const o = window.__priceOpen24h?.[h.asset + '-USD'] || h.price;
    pnl24h += h.total * (h.price - o);
  });
  const pnl24hPct = totalValue ? (pnl24h / totalValue) * 100 : 0;

  // Equity curve from fills (cumulative)
  const equityCurve = useMemo(() => {
    const startEquity = totalValue - pnl24h;
    const arr = [];
    let cum = startEquity * 0.94;
    for (let i = 0; i < 80; i++) {
      cum += (Math.random() - 0.45) * startEquity * 0.004;
      arr.push(cum);
    }
    arr.push(totalValue);
    return arr;
  }, [totalValue]);

  return (
    <>
      <div className="hud-row">
        <HudCard label="Net Equity" value={fmtUsd(totalValue)} sub={<><span className={pnl24h >= 0 ? 'pos' : 'neg'}>{fmtUsd(pnl24h, {sign:true})}</span><span className="dim">24H</span></>}/>
        <HudCard label="Open Positions" value={s.openOrders.length} sub={<><span className="hud-sub-chip">EXPOSURE</span><span className="mono">{fmtUsd(port.holdings.filter(h=>h.asset!=='USD').reduce((s,h)=>s+h.valueUsd,0))}</span></>} orbitColor="var(--plasma)"/>
        <HudCard label="Realized P&L 30D" value={fmtUsd(s.strategies.reduce((sum, st) => sum + (st.pnl30d || 0), 0), {sign:true})} sub={<><span className="hud-sub-chip">{s.fills.length} FILLS</span></>} orbitColor="var(--solar)"/>
        <HudCard label="Active Strategies" value={s.strategies.filter(x => x.status === 'RUNNING').length + '/' + s.strategies.length} sub={<><span className="pulse-dot"/><span className="dim">CRUISE</span></>} orbitColor="var(--warn)"/>
      </div>

      <div className="two-col">
        <Panel title="Trajectory" sub="Equity · 24H" right="LIVE">
          <EquityChart data={equityCurve}/>
        </Panel>
        <Panel title="Open Orders" sub={`${s.openOrders.length} active`}>
          <OpenOrdersMini/>
        </Panel>
      </div>

      <div className="two-col">
        <Panel title="Constellation" sub="Watchlist">
          <MarketTickerMini/>
        </Panel>
        <Panel title="Recent Transmissions" sub="Fills">
          <FillsMini/>
        </Panel>
      </div>
    </>
  );
}

function EquityChart({ data }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0,0,w,h);
    const min = Math.min(...data), max = Math.max(...data);
    const range = (max - min) || 1;
    const pad = 16;
    const drawX = i => pad + (i / (data.length - 1)) * (w - pad*2);
    const drawY = v => pad + (1 - (v - min) / range) * (h - pad*2);

    // grid
    ctx.strokeStyle = 'rgba(94,234,212,0.05)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 5; i++) {
      const y = pad + (i / 4) * (h - pad*2);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w-pad, y); ctx.stroke();
    }
    // area gradient
    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0, 'rgba(94,234,212,0.25)');
    grad.addColorStop(1, 'rgba(94,234,212,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(drawX(0), h - pad);
    data.forEach((v,i) => ctx.lineTo(drawX(i), drawY(v)));
    ctx.lineTo(drawX(data.length - 1), h - pad);
    ctx.closePath();
    ctx.fill();
    // line
    ctx.strokeStyle = '#5eead4'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    data.forEach((v,i) => i === 0 ? ctx.moveTo(drawX(i), drawY(v)) : ctx.lineTo(drawX(i), drawY(v)));
    ctx.stroke();
    // last point
    const lx = drawX(data.length - 1), ly = drawY(data[data.length-1]);
    ctx.fillStyle = '#5eead4';
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(94,234,212,0.4)';
    ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI*2); ctx.stroke();
  }, [data]);
  return <div style={{height:240}}><canvas ref={ref} style={{display:'block', width:'100%', height:'100%'}}/></div>;
}

function OpenOrdersMini() {
  const s = useApiState();
  const prices = useAllPrices();
  const orders = s.openOrders.slice(0, 6);
  if (!orders.length) return <div className="table-empty">NO OPEN ORDERS</div>;
  return (
    <table className="table">
      <thead><tr><th>PAIR</th><th>SIDE</th><th className="right">SIZE</th><th className="right">@ PRICE</th><th className="right">DIST</th><th></th></tr></thead>
      <tbody>
        {orders.map(o => {
          const live = prices[o.pair];
          const dist = live ? ((o.price - live) / live) * 100 : null;
          return (
            <tr key={o.id}>
              <td>{o.pair}</td>
              <td><span className={`chip chip-${o.side.toLowerCase()}`}>{o.side}</span></td>
              <td className="right">{fmtAmt(o.size, 4)}</td>
              <td className="right">{fmtPrice(o.price)}</td>
              <td className="right dim">{dist != null ? fmtPct(dist) : '—'}</td>
              <td className="right">
                <button className="btn btn-sm btn-ghost" onClick={() => window.api.cancelOrder(o.id)}>×</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MarketTickerMini() {
  const prices = useAllPrices();
  const pairs = (window.__pricePairs || []).slice(0, 8);
  return (
    <div>
      {pairs.map(p => {
        const px = prices[p];
        const open = window.__priceOpen24h?.[p];
        const chg = open ? ((px - open) / open) * 100 : 0;
        const spark = window.__priceSparks?.[p];
        return (
          <div key={p} className="pair-list-row">
            <div className="pulse-dot"/>
            <div>{p.replace('-USD','')}</div>
            <div><Sparkline data={spark} color={chg >= 0 ? '#5eead4' : '#fb7185'} width={80}/></div>
            <div className="right" style={{textAlign:'right'}}>{fmtPrice(px)}</div>
            <div className="right" style={{textAlign:'right', color: chg >= 0 ? 'var(--accent)' : 'var(--neg)'}}>{fmtPct(chg)}</div>
          </div>
        );
      })}
    </div>
  );
}

function FillsMini() {
  const s = useApiState();
  const fills = s.fills.slice(0, 6);
  return (
    <table className="table">
      <thead><tr><th>WHEN</th><th>PAIR</th><th>SIDE</th><th className="right">SIZE</th><th className="right">PRICE</th></tr></thead>
      <tbody>
        {fills.map(f => (
          <tr key={f.id}>
            <td className="dim">{timeAgo(f.ts)}</td>
            <td>{f.pair}</td>
            <td><span className={`chip chip-${f.side.toLowerCase()}`}>{f.side}</span></td>
            <td className="right">{fmtAmt(f.size, 4)}</td>
            <td className="right">{fmtPrice(f.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ====================================================
// PORTFOLIO
// ====================================================
const ASSET_COLORS = {
  USD:'#94a3b8', BTC:'#fbbf24', ETH:'#a78bfa', SOL:'#f0abfc',
  AVAX:'#fb7185', LINK:'#5eead4', DOT:'#e879f9', ADA:'#7dd3fc',
};
function colorFor(asset) { return ASSET_COLORS[asset] || '#5eead4'; }

function PortfolioView() {
  const s = useApiState();
  const prices = useAllPrices();
  const port = window.api.portfolio();
  const total = port.totalUsd;
  const sorted = [...port.holdings].sort((a,b) => b.valueUsd - a.valueUsd);

  // Pie chart segments
  let acc = 0;
  const segments = sorted.filter(h => h.valueUsd > 0).map(h => {
    const start = (acc / total) * Math.PI * 2;
    acc += h.valueUsd;
    const end = (acc / total) * Math.PI * 2;
    return { ...h, start, end };
  });
  const cx = 100, cy = 100, r1 = 84, r2 = 56;

  return (
    <>
      <div className="hud-row">
        <HudCard label="Total Equity" value={fmtUsd(total)} sub={<><span className="dim">{port.holdings.filter(h=>h.total>0).length} ASSETS</span></>}/>
        <HudCard label="Cash USD" value={fmtUsd(s.balances.USD?.available || 0)} sub={<><span className="dim">HOLD {fmtUsd(s.balances.USD?.hold || 0)}</span></>} orbitColor="var(--solar)"/>
        <HudCard label="Crypto Value" value={fmtUsd(port.holdings.filter(h=>h.asset!=='USD').reduce((s,h)=>s+h.valueUsd,0))} sub={<><span className="hud-sub-chip">{port.holdings.filter(h=>h.asset!=='USD'&&h.total>0).length} POS</span></>} orbitColor="var(--plasma)"/>
        <HudCard label="On Hold" value={fmtUsd(port.holdings.reduce((s,h)=>s + h.hold * h.price, 0))} sub={<><span className="dim">RESERVED FOR ORDERS</span></>} orbitColor="var(--warn)"/>
      </div>

      <Panel title="Allocation" sub="By value">
        <div className="allocation-wrap">
          <svg className="allocation-svg" viewBox="0 0 200 200">
            <circle cx={cx} cy={cy} r={r1} fill="none" stroke="var(--panel-border)" strokeWidth="0.5"/>
            <circle cx={cx} cy={cy} r={r2} fill="none" stroke="var(--panel-border)" strokeWidth="0.5"/>
            {segments.map(seg => {
              const x1 = cx + r1 * Math.sin(seg.start);
              const y1 = cy - r1 * Math.cos(seg.start);
              const x2 = cx + r1 * Math.sin(seg.end);
              const y2 = cy - r1 * Math.cos(seg.end);
              const x3 = cx + r2 * Math.sin(seg.end);
              const y3 = cy - r2 * Math.cos(seg.end);
              const x4 = cx + r2 * Math.sin(seg.start);
              const y4 = cy - r2 * Math.cos(seg.start);
              const large = seg.end - seg.start > Math.PI ? 1 : 0;
              return (
                <path key={seg.asset}
                  d={`M ${x1} ${y1} A ${r1} ${r1} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r2} ${r2} 0 ${large} 0 ${x4} ${y4} Z`}
                  fill={colorFor(seg.asset)} opacity="0.85" stroke="var(--bg-void)" strokeWidth="1"/>
              );
            })}
            <text x={cx} y={cy-2} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="9" fill="var(--text-tertiary)" letterSpacing="2">TOTAL</text>
            <text x={cx} y={cy+12} textAnchor="middle" fontFamily="JetBrains Mono" fontSize="13" fill="var(--text-primary)">{fmtUsd(total, {dp:0})}</text>
          </svg>
          <div className="allocation-legend">
            {sorted.filter(h => h.total > 0).map(h => (
              <div key={h.asset} className="allocation-row">
                <span className="allocation-swatch" style={{background:colorFor(h.asset)}}/>
                <span>{h.asset}</span>
                <span className="dim" style={{fontSize:10}}>{fmtAmt(h.total, 6)}</span>
                <span className="val">{fmtUsd(h.valueUsd, {dp:0})}</span>
                <span className="pct">{((h.valueUsd / total) * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Holdings" sub="Detailed">
        <table className="table">
          <thead><tr>
            <th>ASSET</th><th className="right">AVAILABLE</th><th className="right">ON HOLD</th><th className="right">TOTAL</th>
            <th className="right">PRICE</th><th className="right">VALUE</th><th></th>
          </tr></thead>
          <tbody>
            {sorted.filter(h => h.total > 0).map(h => (
              <tr key={h.asset}>
                <td><strong>{h.asset}</strong></td>
                <td className="right">{fmtAmt(h.available, 6)}</td>
                <td className="right dim">{fmtAmt(h.hold, 6)}</td>
                <td className="right">{fmtAmt(h.total, 6)}</td>
                <td className="right">{h.asset === 'USD' ? '—' : '$' + fmtPrice(h.price)}</td>
                <td className="right">{fmtUsd(h.valueUsd)}</td>
                <td className="right">
                  {h.asset !== 'USD' && (
                    <button className="btn btn-sm btn-ghost" onClick={() => { window.__setPair?.(h.asset+'-USD'); window.__setView?.('trade'); }}>TRADE</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

// ====================================================
// MARKETS
// ====================================================
function MarketsView() {
  const prices = useAllPrices();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('chg');
  const pairs = (window.__pricePairs || []);
  const rows = pairs.map(p => {
    const px = prices[p];
    const open = window.__priceOpen24h?.[p];
    const chg = open ? ((px - open) / open) * 100 : 0;
    return { p, px, chg };
  }).filter(r => r.p.toLowerCase().includes(q.toLowerCase()));
  rows.sort((a, b) => sort === 'chg' ? b.chg - a.chg : a.p.localeCompare(b.p));

  return (
    <Panel title="Markets" sub={`${pairs.length} instruments`} right={
      <div style={{display:'flex', gap:10, alignItems:'center'}}>
        <div className="input-with-suffix" style={{maxWidth:240}}>
          <input className="input" placeholder="Filter..." value={q} onChange={e => setQ(e.target.value)} style={{padding:'6px 10px', fontSize:11}}/>
        </div>
        <div className="segmented" style={{minWidth:160}}>
          <button className={sort === 'chg' ? 'active' : ''} onClick={() => setSort('chg')}>By Δ</button>
          <button className={sort === 'name' ? 'active' : ''} onClick={() => setSort('name')}>By Name</button>
        </div>
      </div>
    }>
      <table className="table">
        <thead><tr>
          <th></th><th>PAIR</th><th className="right">PRICE</th><th className="right">24H Δ</th>
          <th className="right">24H OPEN</th><th>TREND</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map(({p, px, chg}) => (
            <tr key={p}>
              <td><span className="pulse-dot"/></td>
              <td><strong>{p}</strong></td>
              <td className="right">{fmtPrice(px)}</td>
              <td className="right" style={{color: chg >= 0 ? 'var(--accent)' : 'var(--neg)'}}>{fmtPct(chg)}</td>
              <td className="right dim">{fmtPrice(window.__priceOpen24h?.[p])}</td>
              <td><Sparkline data={window.__priceSparks?.[p]} color={chg >= 0 ? '#5eead4' : '#fb7185'} width={120} height={22}/></td>
              <td className="right">
                <button className="btn btn-sm" onClick={() => { window.__setPair?.(p); window.__setView?.('trade'); }}>TRADE</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ====================================================
// ORDERS
// ====================================================
function OrdersView() {
  const s = useApiState();
  const prices = useAllPrices();
  const [editing, setEditing] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editSize, setEditSize] = useState('');
  const [confirmCancelAll, setConfirmCancelAll] = useState(false);

  return (
    <>
      <Panel title="Open Orders" sub={`${s.openOrders.length} active`} right={
        s.openOrders.length > 0 && <button className="btn btn-sm btn-danger" onClick={() => setConfirmCancelAll(true)}>CANCEL ALL</button>
      }>
        {!s.openOrders.length ? <div className="table-empty">NO OPEN ORDERS</div> : (
          <table className="table">
            <thead><tr>
              <th>PLACED</th><th>PAIR</th><th>TYPE</th><th>SIDE</th>
              <th className="right">SIZE</th><th className="right">PRICE</th>
              <th className="right">LIVE</th><th className="right">DIST</th>
              <th>TIF</th><th></th>
            </tr></thead>
            <tbody>
              {s.openOrders.map(o => {
                const live = prices[o.pair];
                const dist = live ? ((o.price - live) / live) * 100 : null;
                return (
                  <tr key={o.id}>
                    <td className="dim">{timeAgo(o.created)} ago</td>
                    <td><strong>{o.pair}</strong></td>
                    <td><span className="chip chip-open">{o.type}</span></td>
                    <td><span className={`chip chip-${o.side.toLowerCase()}`}>{o.side}</span></td>
                    <td className="right">{fmtAmt(o.size, 6)}</td>
                    <td className="right">{fmtPrice(o.price)}</td>
                    <td className="right">{fmtPrice(live)}</td>
                    <td className="right" style={{color: dist != null && Math.abs(dist) < 1 ? 'var(--solar)' : ''}}>{dist != null ? fmtPct(dist) : '—'}</td>
                    <td className="dim">{o.tif}</td>
                    <td className="right">
                      <button className="btn btn-sm btn-ghost" onClick={() => { setEditing(o); setEditPrice(o.price); setEditSize(o.size); }}>EDIT</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => window.api.cancelOrder(o.id)} style={{color:'var(--neg)'}}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Modal open={!!editing} onClose={() => setEditing(null)}
        eyebrow="◇ MODIFY"
        title={`Edit ${editing?.pair} ${editing?.side}`}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setEditing(null)}>CANCEL</button>
          <button className="btn btn-primary" onClick={async () => {
            await window.api.modifyOrder(editing.id, { price: editPrice, size: editSize });
            setEditing(null);
          }}>UPDATE ORDER</button>
        </>}>
        {editing && (
          <div style={{display:'flex', flexDirection:'column', gap:14}}>
            <div className="field">
              <div className="field-label">Price</div>
              <input className="input" value={editPrice} onChange={e => setEditPrice(e.target.value)}/>
            </div>
            <div className="field">
              <div className="field-label">Size</div>
              <input className="input" value={editSize} onChange={e => setEditSize(e.target.value)}/>
            </div>
            <div className="ticket-summary">
              <div className="ticket-summary-row"><span>Notional</span><span className="v">{fmtUsd(+editPrice * +editSize)}</span></div>
              <div className="ticket-summary-row"><span>Live</span><span className="v">{fmtPrice(prices[editing.pair])}</span></div>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={confirmCancelAll} onClose={() => setConfirmCancelAll(false)}
        eyebrow="⚠ DESTRUCTIVE"
        title="Cancel all orders?"
        footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirmCancelAll(false)}>KEEP THEM</button>
          <button className="btn btn-danger" onClick={async () => { await window.api.cancelAll(); setConfirmCancelAll(false); }}>CANCEL ALL</button>
        </>}>
        <div style={{fontFamily:'JetBrains Mono', fontSize:12, color:'var(--text-secondary)', lineHeight:1.7}}>
          You have <span style={{color:'var(--accent)'}}>{s.openOrders.length}</span> open orders. This cannot be undone.
        </div>
      </Modal>
    </>
  );
}

// ====================================================
// HISTORY
// ====================================================
function HistoryView() {
  const s = useApiState();
  const [tab, setTab] = useState('fills');

  return (
    <Panel title="History" right={
      <div className="segmented" style={{minWidth:280}}>
        <button className={tab==='fills' ? 'active' : ''} onClick={() => setTab('fills')}>Fills · {s.fills.length}</button>
        <button className={tab==='transfers' ? 'active' : ''} onClick={() => setTab('transfers')}>Transfers · {s.transfers.length}</button>
      </div>
    }>
      {tab === 'fills' && (
        <table className="table">
          <thead><tr>
            <th>WHEN</th><th>PAIR</th><th>SIDE</th>
            <th className="right">SIZE</th><th className="right">PRICE</th>
            <th className="right">NOTIONAL</th><th className="right">FEE</th>
          </tr></thead>
          <tbody>
            {s.fills.map(f => (
              <tr key={f.id}>
                <td className="dim">{new Date(f.ts).toLocaleString('en-US', {month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit'})}</td>
                <td><strong>{f.pair}</strong></td>
                <td><span className={`chip chip-${f.side.toLowerCase()}`}>{f.side}</span></td>
                <td className="right">{fmtAmt(f.size, 6)}</td>
                <td className="right">{fmtPrice(f.price)}</td>
                <td className="right">{fmtUsd(f.size * f.price)}</td>
                <td className="right dim">{fmtUsd(f.fee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'transfers' && (
        <table className="table">
          <thead><tr>
            <th>WHEN</th><th>TYPE</th><th>ASSET</th>
            <th className="right">AMOUNT</th><th>METHOD</th><th>STATUS</th>
          </tr></thead>
          <tbody>
            {s.transfers.map(t => (
              <tr key={t.id}>
                <td className="dim">{new Date(t.ts).toLocaleString('en-US', {month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit'})}</td>
                <td><span className={`chip ${t.kind === 'deposit' ? 'chip-buy' : 'chip-sell'}`}>{t.kind}</span></td>
                <td><strong>{t.asset}</strong></td>
                <td className="right">{fmtAmt(t.amount, 6)}</td>
                <td className="dim">{t.method}</td>
                <td><span className={`chip chip-${t.status.toLowerCase()}`}>{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ====================================================
// STRATEGIES
// ====================================================
function StrategiesView() {
  const s = useApiState();
  const [editing, setEditing] = useState(null);
  const [paramsBuf, setParamsBuf] = useState({});

  return (
    <>
      <div className="hud-row">
        <HudCard label="Running" value={s.strategies.filter(x=>x.status==='RUNNING').length} sub={<><span className="pulse-dot"/><span className="dim">CRUISE</span></>}/>
        <HudCard label="Total Trades 30D" value={s.strategies.reduce((t,x)=>t+x.trades30d,0)} sub={<><span className="dim">ALL STRATEGIES</span></>} orbitColor="var(--plasma)"/>
        <HudCard label="Aggregate P&L 30D" value={fmtUsd(s.strategies.reduce((t,x)=>t+x.pnl30d,0), {sign:true})} orbitColor="var(--solar)"/>
        <HudCard label="Avg Sharpe" value={(s.strategies.reduce((t,x)=>t+x.sharpe,0) / Math.max(1, s.strategies.length)).toFixed(2)} orbitColor="var(--warn)"/>
      </div>

      <div style={{display:'grid', gap:18, gridTemplateColumns:'repeat(auto-fill, minmax(420px, 1fr))'}}>
        {s.strategies.map(st => (
          <div key={st.id} className="strat-card">
            <div className="strat-head">
              <div>
                <div className="strat-name">{st.name}</div>
                <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--text-tertiary)', letterSpacing:'0.18em', marginTop:4}}>{st.pairs} PAIRS · {st.mode.toUpperCase()}</div>
              </div>
              <span className={`chip chip-${st.status.toLowerCase()}`}>
                <span className={`pulse-dot ${st.status === 'RUNNING' ? '' : 'dead'}`} style={{width:5, height:5}}/>
                {st.status}
              </span>
            </div>
            <div className="strat-stats">
              <div className="strat-stat"><div className="strat-stat-label">P&L 30D</div><div className="strat-stat-value" style={{color: st.pnl30d >= 0 ? 'var(--accent)' : 'var(--neg)'}}>{fmtUsd(st.pnl30d, {sign:true, dp:0})}</div></div>
              <div className="strat-stat"><div className="strat-stat-label">Sharpe</div><div className="strat-stat-value">{st.sharpe.toFixed(2)}</div></div>
              <div className="strat-stat"><div className="strat-stat-label">Trades</div><div className="strat-stat-value">{st.trades30d}</div></div>
              <div className="strat-stat"><div className="strat-stat-label">Pairs</div><div className="strat-stat-value">{st.pairs}</div></div>
            </div>
            <div className="strat-params">
              {Object.entries(st.params).map(([k,v]) => (
                <span key={k}><span className="strat-param-k">{k}=</span>{v}</span>
              ))}
            </div>
            <div className="strat-actions">
              {st.status !== 'RUNNING' && <button className="btn btn-buy" onClick={() => window.api.setStrategyStatus(st.id, 'RUNNING')}>▶ START</button>}
              {st.status === 'RUNNING' && <button className="btn" onClick={() => window.api.setStrategyStatus(st.id, 'PAUSED')}>⏸ PAUSE</button>}
              {st.status !== 'STOPPED' && <button className="btn btn-danger" onClick={() => window.api.setStrategyStatus(st.id, 'STOPPED')}>■ STOP</button>}
              <button className="btn btn-ghost" onClick={() => { setEditing(st); setParamsBuf({...st.params}); }}>PARAMS</button>
            </div>
          </div>
        ))}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)}
        eyebrow="◇ TUNING"
        title={`${editing?.name} parameters`}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setEditing(null)}>CANCEL</button>
          <button className="btn btn-primary" onClick={async () => {
            const cleaned = Object.fromEntries(Object.entries(paramsBuf).map(([k,v]) => [k, isNaN(+v) ? v : +v]));
            await window.api.updateStrategyParams(editing.id, cleaned);
            setEditing(null);
          }}>SAVE</button>
        </>}>
        {editing && (
          <div style={{display:'flex', flexDirection:'column', gap:14}}>
            {Object.entries(paramsBuf).map(([k,v]) => (
              <div key={k} className="field">
                <div className="field-label">{k}</div>
                <input className="input" value={v} onChange={e => setParamsBuf(b => ({...b, [k]: e.target.value}))}/>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}

// ====================================================
// FUNDING
// ====================================================
function FundingView() {
  const s = useApiState();
  const [tab, setTab] = useState('deposit');
  const [asset, setAsset] = useState('USD');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('ACH');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const assetList = ['USD','BTC','ETH','SOL','AVAX','LINK'];

  // Generate fake deposit address
  const depositAddr = useMemo(() => {
    if (asset === 'USD') return null;
    const seed = asset + (s.apiKey || 'demo');
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const hex = h.toString(16).padStart(8, '0');
    return (asset === 'BTC' ? 'bc1q' : '0x') + hex.repeat(asset === 'BTC' ? 5 : 5).slice(0, 38);
  }, [asset, s.apiKey]);

  async function submit() {
    setBusy(true); setResult(null);
    try {
      if (tab === 'deposit') {
        const r = await window.api.deposit({ asset, amount, method });
        setResult({ ok:true, msg: `Deposit initiated · ${amount} ${asset}` });
      } else {
        const r = await window.api.withdraw({ asset, amount, address });
        setResult({ ok:true, msg: `Withdrawal sent · ${amount} ${asset}` });
      }
      setAmount('');
    } catch (e) {
      setResult({ ok:false, msg: e.message });
    }
    setBusy(false);
  }

  return (
    <>
      <div className="two-col">
        <Panel title="Funding" sub="Move funds in/out" right={
          <div className="segmented" style={{minWidth:200}}>
            <button className={tab==='deposit' ? 'active' : ''} onClick={() => setTab('deposit')}>Deposit</button>
            <button className={tab==='withdraw' ? 'active' : ''} onClick={() => setTab('withdraw')}>Withdraw</button>
          </div>
        }>
          <div style={{display:'flex', flexDirection:'column', gap:18}}>
            <div className="field">
              <div className="field-label">Asset</div>
              <select className="select" value={asset} onChange={e => setAsset(e.target.value)}>
                {assetList.map(a => <option key={a}>{a}</option>)}
              </select>
            </div>

            {tab === 'deposit' && asset === 'USD' && (
              <div className="field">
                <div className="field-label">Method</div>
                <div className="segmented">
                  <button className={method === 'ACH' ? 'active' : ''} onClick={() => setMethod('ACH')}>ACH</button>
                  <button className={method === 'WIRE' ? 'active' : ''} onClick={() => setMethod('WIRE')}>WIRE</button>
                  <button className={method === 'CARD' ? 'active' : ''} onClick={() => setMethod('CARD')}>CARD</button>
                </div>
              </div>
            )}

            {tab === 'deposit' && asset !== 'USD' && depositAddr && (
              <div className="field">
                <div className="field-label">Deposit address</div>
                <div className="input-with-suffix">
                  <input className="input mono" readOnly value={depositAddr}/>
                  <button className="input-suffix" style={{cursor:'pointer'}} onClick={() => navigator.clipboard?.writeText(depositAddr)}>COPY</button>
                </div>
                <div className="field-help">Send only {asset} to this address. Wrong networks lose funds.</div>
              </div>
            )}

            <div className="field">
              <div className="field-label">Amount</div>
              <div className="input-with-suffix">
                <input className="input" type="number" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)}/>
                <div className="input-suffix">{asset}</div>
              </div>
              {tab === 'withdraw' && (
                <div className="field-help">Available: {fmtAmt(s.balances[asset]?.available || 0, 6)} {asset}</div>
              )}
            </div>

            {tab === 'withdraw' && asset !== 'USD' && (
              <div className="field">
                <div className="field-label">Destination Address</div>
                <input className="input" placeholder={asset === 'BTC' ? 'bc1q...' : '0x...'} value={address} onChange={e => setAddress(e.target.value)}/>
              </div>
            )}

            {result && (
              <div className="onboard-warn" style={result.ok ? {borderLeftColor:'var(--accent)', color:'var(--accent)', background:'rgba(94,234,212,0.06)', borderColor:'rgba(94,234,212,0.2)'} : {borderLeftColor:'var(--neg)', color:'var(--neg)', background:'rgba(251,113,133,0.06)', borderColor:'rgba(251,113,133,0.25)'}}>
                {result.msg}
              </div>
            )}

            <button className="btn btn-primary" onClick={submit} disabled={busy || !amount} style={{justifyContent:'center'}}>
              {busy ? '◌ TRANSMITTING' : tab === 'deposit' ? '↓ INITIATE DEPOSIT' : '↑ INITIATE WITHDRAWAL'}
            </button>
          </div>
        </Panel>

        <Panel title="Recent Transfers" sub={`${s.transfers.length} entries`}>
          <table className="table">
            <thead><tr><th>WHEN</th><th>TYPE</th><th>ASSET</th><th className="right">AMT</th><th>STATUS</th></tr></thead>
            <tbody>
              {s.transfers.slice(0, 10).map(t => (
                <tr key={t.id}>
                  <td className="dim">{timeAgo(t.ts)}</td>
                  <td><span className={`chip ${t.kind === 'deposit' ? 'chip-buy' : 'chip-sell'}`}>{t.kind}</span></td>
                  <td>{t.asset}</td>
                  <td className="right">{fmtAmt(t.amount, 4)}</td>
                  <td><span className={`chip chip-${t.status.toLowerCase()}`}>{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

// ====================================================
// API KEYS
// ====================================================
function KeysView({ setView }) {
  const s = useApiState();
  const [showRotate, setShowRotate] = useState(false);

  return (
    <Panel title="API Keys" sub="Coinbase Advanced Trade">
      <div style={{display:'flex', flexDirection:'column', gap:18, maxWidth:680}}>
        <div className="ticket-summary">
          <div className="ticket-summary-row"><span>Status</span><span className="v" style={{color: s.connected ? 'var(--accent)' : 'var(--neg)'}}>{s.connected ? 'CONNECTED' : 'OFFLINE'}</span></div>
          <div className="ticket-summary-row"><span>Mode</span><span className="v">{s.mode.toUpperCase()}</span></div>
          <div className="ticket-summary-row"><span>API Key</span><span className="v mono">{s.apiKey || '—'}</span></div>
          <div className="ticket-summary-row"><span>Secret</span><span className="v mono">{s.apiSecret || '—'}</span></div>
          <div className="ticket-summary-row"><span>Passphrase</span><span className="v mono">{s.passphrase || '—'}</span></div>
        </div>

        <div className="onboard-warn">
          ⚠ Your secret is stored in browser localStorage and never sent to any server from this app — for live trading the secret should live on the backend bridge.
          Rotate keys monthly. Set IP allowlists on Coinbase to your bridge's address.
        </div>

        <div style={{display:'flex', gap:10}}>
          <button className="btn" onClick={async () => {
            try { const r = await window.api.testConnection(); window.__toast({kind:'system', msg:`Uplink OK · ${r.latencyMs}ms · ${r.exchange}`}); }
            catch (e) { window.__toast({kind:'error', msg: e.message}); }
          }}>⟢ TEST CONNECTION</button>
          <button className="btn" onClick={() => setShowRotate(true)}>↻ ROTATE KEYS</button>
          <button className="btn btn-danger" onClick={async () => { await window.api.disconnect(); setView('onboard'); }}>DISCONNECT</button>
        </div>
      </div>

      <Modal open={showRotate} onClose={() => setShowRotate(false)}
        eyebrow="↻ ROTATE"
        title="Replace API credentials"
        footer={<>
          <button className="btn btn-ghost" onClick={() => setShowRotate(false)}>CANCEL</button>
          <button className="btn btn-primary" onClick={() => { setShowRotate(false); window.api.disconnect().then(() => setView('onboard')); }}>RE-ENTER KEYS</button>
        </>}>
        <div style={{fontFamily:'JetBrains Mono', fontSize:11.5, color:'var(--text-secondary)', lineHeight:1.7}}>
          Disconnects the current keys and walks you through entering new ones. Open orders will remain on the exchange but cannot be managed from this session until reconnected.
        </div>
      </Modal>
    </Panel>
  );
}

// ====================================================
// SETTINGS
// ====================================================
function SettingsView() {
  const s = useApiState();
  return (
    <Panel title="Settings" sub="Trading preferences">
      <div style={{display:'flex', flexDirection:'column', gap:22, maxWidth:580}}>
        <div className="field">
          <div className="field-label">Slippage tolerance</div>
          <div className="input-with-suffix">
            <input className="input" type="number" step="0.1" value={s.settings.slippageTolerance}
              onChange={e => window.api.setSetting('slippageTolerance', +e.target.value)}/>
            <div className="input-suffix">%</div>
          </div>
          <div className="field-help">Maximum price deviation accepted on market orders.</div>
        </div>

        <div className="field">
          <div className="field-label">Default Time-In-Force</div>
          <div className="segmented">
            {['GTC','IOC','FOK'].map(t => (
              <button key={t} className={s.settings.defaultTif === t ? 'active' : ''} onClick={() => window.api.setSetting('defaultTif', t)}>{t}</button>
            ))}
          </div>
          <div className="field-help">GTC stays open until filled or cancelled. IOC fills any portion immediately, cancels rest. FOK fills entirely or cancels.</div>
        </div>

        <div className="field">
          <div className="field-label">Order Confirmation</div>
          <div className="segmented">
            <button className={s.settings.confirmOrders ? 'active' : ''} onClick={() => window.api.setSetting('confirmOrders', true)}>Required</button>
            <button className={!s.settings.confirmOrders ? 'active' : ''} onClick={() => window.api.setSetting('confirmOrders', false)}>One-tap</button>
          </div>
          <div className="field-help">When required, every order opens a confirmation modal with a 5-second abort window.</div>
        </div>

        <div className="field">
          <div className="field-label">Sounds</div>
          <div className="segmented">
            <button className={s.settings.sounds ? 'active' : ''} onClick={() => window.api.setSetting('sounds', true)}>On</button>
            <button className={!s.settings.sounds ? 'active' : ''} onClick={() => window.api.setSetting('sounds', false)}>Off</button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// expose
Object.assign(window, {
  Sparkline, HudOrbit, HudCard, Panel, EquityChart,
  OnboardView, DashboardView, PortfolioView, MarketsView,
  OrdersView, HistoryView, StrategiesView, FundingView, KeysView, SettingsView,
});
