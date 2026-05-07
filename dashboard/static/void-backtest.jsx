// =====================================================
// VOID Backtest — historical strategy simulator
// =====================================================

function BacktestView() {
  const s = useApiState();
  const prices = useAllPrices();
  const pairs = (window.__pricePairs || ['BTC-USD','ETH-USD','SOL-USD','AVAX-USD','LINK-USD']);

  // ---- form state ----
  const [stratId, setStratId] = useState(s.strategies[0]?.id || 'sma_cross');
  const [pair, setPair] = useState(pairs[0] || 'BTC-USD');
  const [rangeDays, setRangeDays] = useState(90);
  const [capital, setCapital] = useState(10000);
  const [feeBps, setFeeBps] = useState(10);     // 0.10%
  const [slipBps, setSlipBps] = useState(5);    // 0.05%
  const [params, setParams] = useState(() => ({ ...(s.strategies.find(x=>x.id===stratId)?.params || {}) }));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem('void_bt_runs') || '[]'); } catch { return []; }
  });
  const cancelRef = useRef(false);

  // sync params when strategy changes
  useEffect(() => {
    const st = s.strategies.find(x => x.id === stratId);
    if (st) setParams({ ...st.params });
  }, [stratId]);

  function persistHistory(list) {
    setHistory(list);
    try { localStorage.setItem('void_bt_runs', JSON.stringify(list.slice(0, 30))); } catch {}
  }

  // ---- synthetic price series + run engine ----
  async function run() {
    setRunning(true);
    setProgress(0);
    setResult(null);
    cancelRef.current = false;

    // Seed series from current live price
    const seed = (window.__livePrices?.[pair]) || 100;
    const totalBars = rangeDays * 24; // hourly bars
    const series = generateSeries(seed, totalBars, stratId);

    // Engine loop with chunked yields for animated progress
    const out = await runEngine({
      series, stratId, params, capital,
      feeBps, slipBps, pair,
      onProgress: p => setProgress(p),
      cancelRef,
    });

    if (!cancelRef.current) {
      setResult(out);
      const item = {
        id: 'bt_' + Math.random().toString(36).slice(2,9),
        ts: Date.now(),
        strategy: s.strategies.find(x=>x.id===stratId)?.name || stratId,
        pair, rangeDays, capital, params: {...params},
        pnl: out.pnl, pnlPct: out.pnlPct, sharpe: out.sharpe,
        maxDD: out.maxDD, trades: out.trades.length, winRate: out.winRate,
      };
      persistHistory([item, ...history].slice(0, 30));
    }
    setRunning(false);
  }

  function abort() { cancelRef.current = true; }

  function deployToLive() {
    if (!result) return;
    window.api.updateStrategyParams(stratId, params);
    window.__toast?.({ kind:'system', msg:`Parameters synced to ${s.strategies.find(x=>x.id===stratId)?.name}` });
  }

  const strat = s.strategies.find(x => x.id === stratId);

  return (
    <>
      {/* Top metrics */}
      <div className="hud-row">
        <HudCard
          label="Last Run P&L"
          value={result ? fmtUsd(result.pnl, {sign:true, dp:0}) : '—'}
          sub={result ? <><span className={result.pnl>=0?'pos':'neg'}>{fmtPct(result.pnlPct)}</span><span className="dim">RETURN</span></> : <span className="dim">NO RUNS</span>}
          orbitColor={result ? (result.pnl>=0?'var(--accent)':'var(--neg)') : 'var(--accent)'}
        />
        <HudCard label="Sharpe" value={result ? result.sharpe.toFixed(2) : '—'}
          sub={result ? <><span className="hud-sub-chip">RISK-ADJ</span></> : <span className="dim">—</span>}
          orbitColor="var(--plasma)"/>
        <HudCard label="Max Drawdown" value={result ? fmtPct(-result.maxDD) : '—'}
          sub={result ? <><span className="dim">PEAK→TROUGH</span></> : <span className="dim">—</span>}
          orbitColor="var(--neg)"/>
        <HudCard label="Win Rate" value={result ? (result.winRate*100).toFixed(1)+'%' : '—'}
          sub={result ? <><span className="hud-sub-chip">{result.trades.length} TRADES</span></> : <span className="dim">—</span>}
          orbitColor="var(--solar)"/>
      </div>

      <div className="bt-grid">
        {/* ===== LEFT: configurator ===== */}
        <Panel title="Simulation" sub="◇ configure">
          <div className="bt-config">
            <div className="field">
              <div className="field-label">Strategy</div>
              <select className="select" value={stratId} onChange={e => setStratId(e.target.value)}>
                {s.strategies.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
              <div className="field-help">{strat?.pairs} pairs · live mode {strat?.status}</div>
            </div>

            <div className="field">
              <div className="field-label">Instrument</div>
              <select className="select" value={pair} onChange={e => setPair(e.target.value)}>
                {pairs.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>

            <div className="field">
              <div className="field-label">Window</div>
              <div className="segmented">
                {[30, 90, 180, 365].map(d => (
                  <button key={d} className={rangeDays===d?'active':''} onClick={() => setRangeDays(d)}>{d}D</button>
                ))}
              </div>
              <div className="field-help">{rangeDays * 24} hourly bars synthesised from live price seed</div>
            </div>

            <div className="bt-row2">
              <div className="field">
                <div className="field-label">Starting capital</div>
                <div className="input-with-suffix">
                  <input className="input" type="text" inputMode="numeric" value={capital} onChange={e => setCapital(+e.target.value || 0)}/>
                  <div className="input-suffix">USD</div>
                </div>
              </div>
              <div className="field">
                <div className="field-label">Fee</div>
                <div className="input-with-suffix">
                  <input className="input" type="text" inputMode="decimal" value={feeBps} onChange={e => setFeeBps(+e.target.value || 0)}/>
                  <div className="input-suffix">bps</div>
                </div>
              </div>
              <div className="field">
                <div className="field-label">Slippage</div>
                <div className="input-with-suffix">
                  <input className="input" type="text" inputMode="decimal" value={slipBps} onChange={e => setSlipBps(+e.target.value || 0)}/>
                  <div className="input-suffix">bps</div>
                </div>
              </div>
            </div>

            {/* tunable params */}
            <div className="bt-params">
              <div className="bt-params-head">
                <span className="panel-head-marker"/>
                <span>Parameters</span>
                <span className="dim mono" style={{fontSize:10, marginLeft:'auto'}}>{Object.keys(params).length} KEYS</span>
              </div>
              <div className="bt-params-grid">
                {Object.entries(params).map(([k,v]) => (
                  <div className="field" key={k}>
                    <div className="field-label">{k}</div>
                    <input className="input" value={v}
                      onChange={e => {
                        const nv = e.target.value;
                        setParams(p => ({ ...p, [k]: isNaN(+nv) || nv==='' ? nv : +nv }));
                      }}/>
                  </div>
                ))}
              </div>
            </div>

            <div className="bt-actions">
              {!running ? (
                <button className="btn btn-primary" onClick={run} style={{flex:1, justifyContent:'center'}}>
                  ▶ RUN BACKTEST
                </button>
              ) : (
                <button className="btn btn-danger" onClick={abort} style={{flex:1, justifyContent:'center'}}>
                  ◌ ABORT · {(progress*100).toFixed(0)}%
                </button>
              )}
              <button className="btn" disabled={!result} onClick={deployToLive} title="Push tuned params to live strategy">
                ↑ DEPLOY PARAMS
              </button>
            </div>

            {running && (
              <div className="bt-progress">
                <div className="bt-progress-fill" style={{width: (progress*100)+'%'}}/>
              </div>
            )}
          </div>
        </Panel>

        {/* ===== RIGHT: results ===== */}
        <div style={{display:'flex', flexDirection:'column', gap:18}}>
          <Panel title="Equity Trajectory" sub={result ? `${result.bars} BARS · ${rangeDays}D` : '— idle —'} right={result ? <span className={result.pnl>=0?'pos':'neg'} style={{fontFamily:'JetBrains Mono', fontSize:11, letterSpacing:'0.1em'}}>{fmtPct(result.pnlPct)}</span> : null}>
            <div style={{height:300}}>
              {result ? <BTEquityChart equity={result.equity} trades={result.trades} drawdown={result.drawdownSeries} rangeDays={rangeDays} capital={capital}/>
                       : <div className="bt-empty">RUN A BACKTEST TO POPULATE TRAJECTORY</div>}
            </div>
          </Panel>

          <div className="two-col">
            <Panel title="Stats" sub="◇ summary">
              {result ? (
                <div className="bt-stats">
                  <Stat label="Net P&L"        value={fmtUsd(result.pnl, {sign:true})} color={result.pnl>=0?'var(--accent)':'var(--neg)'}/>
                  <Stat label="Return"         value={fmtPct(result.pnlPct)} color={result.pnl>=0?'var(--accent)':'var(--neg)'}/>
                  <Stat label="Sharpe"         value={result.sharpe.toFixed(2)}/>
                  <Stat label="Sortino"        value={result.sortino.toFixed(2)}/>
                  <Stat label="Max Drawdown"   value={fmtPct(-result.maxDD)} color="var(--neg)"/>
                  <Stat label="Calmar"         value={result.calmar.toFixed(2)}/>
                  <Stat label="Trades"         value={result.trades.length}/>
                  <Stat label="Win Rate"       value={(result.winRate*100).toFixed(1)+'%'}/>
                  <Stat label="Avg Win"        value={fmtUsd(result.avgWin)} color="var(--accent)"/>
                  <Stat label="Avg Loss"       value={fmtUsd(result.avgLoss)} color="var(--neg)"/>
                  <Stat label="Profit Factor"  value={result.profitFactor.toFixed(2)}/>
                  <Stat label="Exposure"       value={(result.exposure*100).toFixed(0)+'%'}/>
                  <Stat label="Fees Paid"      value={fmtUsd(result.fees)} color="var(--text-tertiary)"/>
                  <Stat label="Final Equity"   value={fmtUsd(result.equity[result.equity.length-1])}/>
                </div>
              ) : <div className="bt-empty">—</div>}
            </Panel>

            <Panel title="Returns Histogram" sub="trade P&L distribution">
              {result ? <ReturnsHistogram trades={result.trades}/> : <div className="bt-empty">—</div>}
            </Panel>
          </div>

          <Panel title="Trades" sub={result ? `${result.trades.length} closed` : '—'}>
            {result && result.trades.length ? (
              <div style={{maxHeight: 260, overflow:'auto'}}>
                <table className="table">
                  <thead><tr>
                    <th>#</th><th>OPENED</th><th>CLOSED</th><th>SIDE</th>
                    <th className="right">ENTRY</th><th className="right">EXIT</th>
                    <th className="right">SIZE</th><th className="right">P&L</th><th className="right">RET</th>
                  </tr></thead>
                  <tbody>
                    {result.trades.slice().reverse().map((t, i) => (
                      <tr key={i}>
                        <td className="dim mono">{result.trades.length - i}</td>
                        <td className="dim">{fmtBar(t.openBar, rangeDays)}</td>
                        <td className="dim">{fmtBar(t.closeBar, rangeDays)}</td>
                        <td><span className={`chip chip-${t.side.toLowerCase()}`}>{t.side}</span></td>
                        <td className="right">{fmtPrice(t.entry)}</td>
                        <td className="right">{fmtPrice(t.exit)}</td>
                        <td className="right">{fmtAmt(t.size, 4)}</td>
                        <td className="right" style={{color: t.pnl>=0?'var(--accent)':'var(--neg)'}}>{fmtUsd(t.pnl, {sign:true})}</td>
                        <td className="right" style={{color: t.pnl>=0?'var(--accent)':'var(--neg)'}}>{fmtPct(t.retPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="bt-empty">NO TRADES YET</div>}
          </Panel>

          <Panel title="Run History" sub={`${history.length} archived`} right={
            history.length > 0 && <button className="btn btn-sm btn-ghost" onClick={() => persistHistory([])}>CLEAR</button>
          }>
            {history.length === 0 ? <div className="bt-empty">NO RUNS ARCHIVED</div> : (
              <table className="table">
                <thead><tr>
                  <th>WHEN</th><th>STRAT</th><th>PAIR</th><th className="right">DAYS</th>
                  <th className="right">P&L</th><th className="right">RET</th>
                  <th className="right">SHARPE</th><th className="right">DD</th><th className="right">TRADES</th>
                </tr></thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id}>
                      <td className="dim">{timeAgo(h.ts)}</td>
                      <td><strong>{h.strategy}</strong></td>
                      <td>{h.pair}</td>
                      <td className="right">{h.rangeDays}D</td>
                      <td className="right" style={{color: h.pnl>=0?'var(--accent)':'var(--neg)'}}>{fmtUsd(h.pnl, {sign:true, dp:0})}</td>
                      <td className="right" style={{color: h.pnl>=0?'var(--accent)':'var(--neg)'}}>{fmtPct(h.pnlPct)}</td>
                      <td className="right">{h.sharpe.toFixed(2)}</td>
                      <td className="right dim">{fmtPct(-h.maxDD)}</td>
                      <td className="right">{h.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

// ----- small Stat tile -----
function Stat({ label, value, color }) {
  return (
    <div className="bt-stat">
      <div className="bt-stat-label">{label}</div>
      <div className="bt-stat-value" style={color ? {color} : {}}>{value}</div>
    </div>
  );
}

// ----- equity chart with trade markers + drawdown shading + hover tooltip -----
function BTEquityChart({ equity, trades, drawdown, rangeDays, capital }) {
  const wrapRef = useRef(null);
  const ref = useRef(null);
  const overlayRef = useRef(null);
  const [hover, setHover] = useState(null); // {i, x, y}
  const padRef = useRef({ l: 50, r: 16, t: 14, b: 26 });

  // ---- main draw ----
  useEffect(() => {
    const c = ref.current; if (!c || !equity?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0,0,w,h);

    const PL = padRef.current.l, PR = padRef.current.r, PT = padRef.current.t, PB = padRef.current.b;
    const min = Math.min(...equity), max = Math.max(...equity);
    const range = (max - min) || 1;
    const X = i => PL + (i / (equity.length - 1)) * (w - PL - PR);
    const Y = v => PT + (1 - (v - min) / range) * (h - PT - PB);

    // grid + y-axis labels (equity)
    ctx.strokeStyle = 'rgba(94,234,212,0.05)'; ctx.lineWidth = 0.5;
    ctx.fillStyle = 'rgba(100,116,139,0.7)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = PT + (i / 4) * (h - PT - PB);
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
      const v = max - (i / 4) * range;
      ctx.fillText('$' + Math.round(v).toLocaleString(), PL - 6, y);
    }

    // x-axis labels (time horizon)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(100,116,139,0.7)';
    const ticks = 6;
    const totalBars = equity.length;
    for (let i = 0; i <= ticks; i++) {
      const bar = Math.floor((i / ticks) * (totalBars - 1));
      const x = X(bar);
      // small tick
      ctx.strokeStyle = 'rgba(94,234,212,0.12)';
      ctx.beginPath(); ctx.moveTo(x, h - PB); ctx.lineTo(x, h - PB + 4); ctx.stroke();
      const dayFromStart = Math.floor((bar / totalBars) * rangeDays);
      const daysAgo = rangeDays - dayFromStart;
      const lbl = daysAgo === 0 ? 'NOW' : '−' + daysAgo + 'D';
      ctx.fillText(lbl, x, h - PB + 8);
    }

    // baseline (starting capital)
    const baselineY = Y(capital ?? equity[0]);
    ctx.strokeStyle = 'rgba(148,163,184,0.3)'; ctx.setLineDash([3,3]); ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(PL, baselineY); ctx.lineTo(w - PR, baselineY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('start', w - PR - 30, baselineY - 8);

    // drawdown band
    if (drawdown) {
      ctx.fillStyle = 'rgba(251,113,133,0.06)';
      ctx.beginPath();
      drawdown.forEach((dd, i) => {
        const peak = equity[i] / (1 - dd);
        if (i === 0) ctx.moveTo(X(i), Y(peak));
        else ctx.lineTo(X(i), Y(peak));
      });
      for (let i = drawdown.length - 1; i >= 0; i--) ctx.lineTo(X(i), Y(equity[i]));
      ctx.closePath(); ctx.fill();
    }

    // area + line
    const finalUp = equity[equity.length-1] >= equity[0];
    const lineColor = finalUp ? '#5eead4' : '#fb7185';
    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0, finalUp ? 'rgba(94,234,212,0.22)' : 'rgba(251,113,133,0.22)');
    grad.addColorStop(1, 'rgba(94,234,212,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(X(0), h - PB);
    equity.forEach((v,i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(equity.length - 1), h - PB);
    ctx.closePath(); ctx.fill();

    ctx.strokeStyle = lineColor; ctx.lineWidth = 1.4;
    ctx.beginPath();
    equity.forEach((v,i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
    ctx.stroke();

    // trade markers
    trades?.forEach(t => {
      const ex = X(t.closeBar);
      const ey = Y(equity[Math.min(t.closeBar, equity.length-1)]);
      ctx.fillStyle = t.pnl >= 0 ? 'rgba(94,234,212,0.9)' : 'rgba(251,113,133,0.9)';
      ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI*2); ctx.fill();
    });

    // last point
    const lx = X(equity.length-1), ly = Y(equity[equity.length-1]);
    ctx.fillStyle = lineColor;
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = lineColor + '66';
    ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI*2); ctx.stroke();
  }, [equity, trades, drawdown, rangeDays, capital]);

  // ---- hover overlay (crosshair drawn separately to avoid full redraw) ----
  useEffect(() => {
    const oc = overlayRef.current; if (!oc) return;
    const dpr = window.devicePixelRatio || 1;
    const w = oc.clientWidth, h = oc.clientHeight;
    oc.width = w * dpr; oc.height = h * dpr;
    const ctx = oc.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0,0,w,h);
    if (!hover || !equity?.length) return;
    const PL = padRef.current.l, PR = padRef.current.r, PT = padRef.current.t, PB = padRef.current.b;
    const min = Math.min(...equity), max = Math.max(...equity);
    const range = (max - min) || 1;
    const X = i => PL + (i / (equity.length - 1)) * (w - PL - PR);
    const Y = v => PT + (1 - (v - min) / range) * (h - PT - PB);
    const cx = X(hover.i), cy = Y(equity[hover.i]);
    // vertical line
    ctx.strokeStyle = 'rgba(94,234,212,0.45)';
    ctx.setLineDash([2,3]); ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(cx, PT); ctx.lineTo(cx, h - PB); ctx.stroke();
    ctx.setLineDash([]);
    // hover dot
    ctx.fillStyle = '#5eead4';
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(2,3,10,1)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.stroke();
  }, [hover, equity]);

  function handleMove(e) {
    const wrap = wrapRef.current; if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const PL = padRef.current.l, PR = padRef.current.r;
    const inner = rect.width - PL - PR;
    if (x < PL || x > rect.width - PR) { setHover(null); return; }
    const frac = (x - PL) / inner;
    const i = Math.max(0, Math.min(equity.length - 1, Math.round(frac * (equity.length - 1))));
    setHover({ i, x, y });
  }
  function handleLeave() { setHover(null); }

  // tooltip data
  let tip = null;
  if (hover && equity?.length) {
    const v = equity[hover.i];
    const pnl = v - (capital ?? equity[0]);
    const pnlPct = ((v / (capital ?? equity[0])) - 1) * 100;
    const dd = drawdown?.[hover.i] ?? 0;
    const totalBars = equity.length;
    const hoursFromStart = Math.floor((hover.i / totalBars) * rangeDays * 24);
    const day = Math.floor(hoursFromStart / 24);
    const hour = hoursFromStart % 24;
    const daysAgo = rangeDays - day;
    const date = new Date(Date.now() - daysAgo * 86400000 - hour * 3600000);
    const tradeAt = trades?.find(t => Math.abs(t.closeBar - hover.i) < 3 || Math.abs(t.openBar - hover.i) < 3);
    tip = { v, pnl, pnlPct, dd: dd*100, day, hour, daysAgo, date, tradeAt };
  }

  return (
    <div ref={wrapRef} className="bt-chart-wrap"
      onMouseMove={handleMove} onMouseLeave={handleLeave}>
      <canvas ref={ref} style={{display:'block', width:'100%', height:'100%', position:'absolute', inset:0}}/>
      <canvas ref={overlayRef} style={{display:'block', width:'100%', height:'100%', position:'absolute', inset:0, pointerEvents:'none'}}/>
      {tip && (
        <div className="bt-tooltip" style={{
          left: Math.min(hover.x + 14, (wrapRef.current?.clientWidth || 0) - 200),
          top: Math.max(8, hover.y - 90),
        }}>
          <div className="bt-tooltip-row">
            <span className="bt-tooltip-k">WHEN</span>
            <span className="bt-tooltip-v">D{tip.day+1} · {String(tip.hour).padStart(2,'0')}:00</span>
          </div>
          <div className="bt-tooltip-row">
            <span className="bt-tooltip-k">AGO</span>
            <span className="bt-tooltip-v dim">{tip.daysAgo}D {tip.date.toLocaleDateString('en-US',{month:'short',day:'2-digit'})}</span>
          </div>
          <div className="bt-tooltip-sep"/>
          <div className="bt-tooltip-row">
            <span className="bt-tooltip-k">EQUITY</span>
            <span className="bt-tooltip-v">{fmtUsd(tip.v)}</span>
          </div>
          <div className="bt-tooltip-row">
            <span className="bt-tooltip-k">P&L</span>
            <span className="bt-tooltip-v" style={{color: tip.pnl>=0?'var(--accent)':'var(--neg)'}}>
              {fmtUsd(tip.pnl, {sign:true})} <span className="dim">({fmtPct(tip.pnlPct)})</span>
            </span>
          </div>
          <div className="bt-tooltip-row">
            <span className="bt-tooltip-k">DD</span>
            <span className="bt-tooltip-v" style={{color: tip.dd > 0 ? 'var(--neg)' : 'var(--text-tertiary)'}}>
              {tip.dd > 0 ? '−' + tip.dd.toFixed(2) + '%' : '0.00%'}
            </span>
          </div>
          {tip.tradeAt && (
            <>
              <div className="bt-tooltip-sep"/>
              <div className="bt-tooltip-row">
                <span className="bt-tooltip-k">TRADE</span>
                <span className="bt-tooltip-v" style={{color: tip.tradeAt.pnl>=0?'var(--accent)':'var(--neg)'}}>
                  {tip.tradeAt.side} {fmtUsd(tip.tradeAt.pnl, {sign:true})}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ----- returns histogram -----
function ReturnsHistogram({ trades }) {
  if (!trades?.length) return <div className="bt-empty">—</div>;
  const rets = trades.map(t => t.retPct);
  const min = Math.min(...rets), max = Math.max(...rets);
  const buckets = 14;
  const span = (max - min) || 1;
  const step = span / buckets;
  const bins = Array(buckets).fill(0);
  rets.forEach(r => {
    let i = Math.floor((r - min) / step);
    if (i >= buckets) i = buckets - 1;
    if (i < 0) i = 0;
    bins[i]++;
  });
  const peak = Math.max(...bins) || 1;
  return (
    <div className="bt-hist">
      {bins.map((count, i) => {
        const lo = min + i*step;
        const hi = lo + step;
        const mid = (lo + hi) / 2;
        const positive = mid >= 0;
        return (
          <div key={i} className="bt-hist-col" title={`${lo.toFixed(2)}% to ${hi.toFixed(2)}% · ${count} trades`}>
            <div className="bt-hist-bar"
              style={{
                height: (count / peak * 100) + '%',
                background: positive ? 'linear-gradient(180deg, #5eead4, rgba(94,234,212,0.3))'
                                     : 'linear-gradient(180deg, #fb7185, rgba(251,113,133,0.3))'
              }}/>
          </div>
        );
      })}
      <div className="bt-hist-axis">
        <span>{min.toFixed(1)}%</span>
        <span style={{color:'var(--text-dim)'}}>0</span>
        <span>{max.toFixed(1)}%</span>
      </div>
    </div>
  );
}

function fmtBar(bar, rangeDays) {
  const totalBars = rangeDays * 24;
  const hoursAgo = totalBars - bar;
  const d = Math.floor(hoursAgo / 24);
  const h = hoursAgo % 24;
  return `D${rangeDays - d}·${String(h).padStart(2,'0')}:00`;
}

// ====================================================
// SYNTHETIC DATA + ENGINE
// ====================================================
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function generateSeries(seed, bars, stratId) {
  // GBM with regime shifts
  const rng = mulberry32(Math.floor(seed * 1000) + bars + stratId.length * 7);
  const arr = new Array(bars);
  let p = seed * 0.85; // start slightly below current
  let mu = 0.00005, sigma = 0.012;
  for (let i = 0; i < bars; i++) {
    if (i % 240 === 0) {
      mu = (rng() - 0.45) * 0.0008;
      sigma = 0.006 + rng() * 0.018;
    }
    const u1 = Math.max(rng(), 1e-9), u2 = rng();
    const z = Math.sqrt(-2*Math.log(u1)) * Math.cos(2*Math.PI*u2);
    p = p * Math.exp((mu - 0.5*sigma*sigma) + sigma * z);
    arr[i] = p;
  }
  return arr;
}

// strategy signals → +1 long, -1 short (we trade long/flat only here)
function signal(stratId, series, i, params) {
  if (stratId === 'sma_cross') {
    const fast = +params.fast || 12;
    const slow = +params.slow || 50;
    if (i < slow) return 0;
    const mean = (a, n) => {
      let s = 0;
      for (let k = i - n + 1; k <= i; k++) s += series[k];
      return s / n;
    };
    return mean(series, fast) > mean(series, slow) ? 1 : 0;
  }
  if (stratId === 'boll_revert') {
    const w = +params.window || 20;
    const std = +params.std || 2.0;
    if (i < w) return 0;
    let m = 0, sq = 0;
    for (let k = i - w + 1; k <= i; k++) m += series[k];
    m /= w;
    for (let k = i - w + 1; k <= i; k++) sq += (series[k] - m) ** 2;
    const sd = Math.sqrt(sq / w);
    const lower = m - std * sd, upper = m + std * sd;
    if (series[i] < lower) return 1;
    if (series[i] > upper) return 0;
    return null; // hold
  }
  if (stratId === 'donchian') {
    const lb = +params.lookback || 55;
    if (i < lb) return 0;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - lb; k < i; k++) { if (series[k] > hi) hi = series[k]; if (series[k] < lo) lo = series[k]; }
    if (series[i] > hi) return 1;
    if (series[i] < lo) return 0;
    return null;
  }
  // default: simple momentum
  if (i < 24) return 0;
  return series[i] > series[i-24] ? 1 : 0;
}

async function runEngine({ series, stratId, params, capital, feeBps, slipBps, pair, onProgress, cancelRef }) {
  const fee = feeBps / 10000;
  const slip = slipBps / 10000;
  const equity = new Array(series.length);
  const drawdownSeries = new Array(series.length);
  const trades = [];

  let cash = capital;
  let pos = 0; // units of asset
  let entryPrice = 0;
  let entryBar = 0;
  let prevSig = 0;
  let totalFees = 0;
  let peak = capital;
  let maxDD = 0;
  let exposureBars = 0;

  const chunkSize = Math.max(50, Math.floor(series.length / 60));

  for (let i = 0; i < series.length; i++) {
    if (cancelRef.current) return null;
    const px = series[i];
    let sig = signal(stratId, series, i, params);
    if (sig == null) sig = prevSig; // hold

    // entry
    if (sig === 1 && pos === 0) {
      const fillPx = px * (1 + slip);
      const size = (cash * 0.95) / fillPx;
      const cost = size * fillPx;
      const f = cost * fee;
      cash -= cost + f;
      totalFees += f;
      pos = size;
      entryPrice = fillPx;
      entryBar = i;
    }
    // exit
    else if (sig === 0 && pos > 0) {
      const fillPx = px * (1 - slip);
      const proceeds = pos * fillPx;
      const f = proceeds * fee;
      cash += proceeds - f;
      totalFees += f;
      const pnl = proceeds - f - (pos * entryPrice);
      const retPct = ((fillPx - entryPrice) / entryPrice) * 100;
      trades.push({
        side: 'LONG',
        entry: entryPrice, exit: fillPx,
        size: pos, openBar: entryBar, closeBar: i,
        pnl, retPct,
      });
      pos = 0;
    }

    if (pos > 0) exposureBars++;
    const eq = cash + pos * px;
    equity[i] = eq;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    drawdownSeries[i] = dd;
    if (dd > maxDD) maxDD = dd;
    prevSig = sig;

    if (i % chunkSize === 0) {
      onProgress(i / series.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // close any open position
  if (pos > 0) {
    const lastPx = series[series.length-1] * (1 - slip);
    const proceeds = pos * lastPx;
    const f = proceeds * fee;
    cash += proceeds - f;
    totalFees += f;
    const pnl = proceeds - f - (pos * entryPrice);
    const retPct = ((lastPx - entryPrice) / entryPrice) * 100;
    trades.push({
      side: 'LONG',
      entry: entryPrice, exit: lastPx,
      size: pos, openBar: entryBar, closeBar: series.length - 1,
      pnl, retPct,
    });
    equity[equity.length - 1] = cash;
  }

  onProgress(1);

  // ---- stats ----
  const finalEq = equity[equity.length - 1];
  const pnl = finalEq - capital;
  const pnlPct = (pnl / capital) * 100;

  // hourly returns
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    const r = (equity[i] - equity[i-1]) / (equity[i-1] || 1);
    rets.push(r);
  }
  const mean = rets.reduce((a,b)=>a+b, 0) / Math.max(1, rets.length);
  const variance = rets.reduce((a,b) => a + (b - mean)**2, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(variance);
  // annualise (hourly): √(24*365) ≈ 92.7
  const annFactor = Math.sqrt(24 * 365);
  const sharpe = sd > 0 ? (mean / sd) * annFactor : 0;
  const downside = Math.sqrt(rets.filter(r => r < 0).reduce((a,b)=>a+b*b, 0) / Math.max(1, rets.length));
  const sortino = downside > 0 ? (mean / downside) * annFactor : 0;
  const annRet = (Math.pow(finalEq / capital, (24*365) / equity.length) - 1) * 100;
  const calmar = maxDD > 0 ? annRet / (maxDD * 100) : 0;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((a,t)=>a+t.pnl,0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a,t)=>a+t.pnl,0) / losses.length : 0;
  const grossWin = wins.reduce((a,t)=>a+t.pnl,0);
  const grossLoss = Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
  const exposure = exposureBars / equity.length;

  return {
    equity, drawdownSeries, trades,
    pnl, pnlPct, sharpe, sortino, maxDD: maxDD * 100, calmar,
    winRate, avgWin, avgLoss, profitFactor,
    exposure, fees: totalFees, bars: equity.length,
  };
}

// expose
Object.assign(window, { BacktestView });
