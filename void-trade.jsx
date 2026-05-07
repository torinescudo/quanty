// =============================================================
// VOID Trade View — chart + orderbook + order ticket + confirm
// =============================================================

let __pairBus = (() => {
  const subs = new Set();
  let cur = 'BTC-USD';
  return {
    set(p) { cur = p; subs.forEach(fn => fn(p)); },
    get() { return cur; },
    sub(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
})();
window.__setPair = (p) => __pairBus.set(p);

function usePair() {
  const [p, setP] = useState(__pairBus.get());
  useEffect(() => __pairBus.sub(setP), []);
  return [p, (v) => __pairBus.set(v)];
}

// ---- Synthetic orderbook around live price ----
function useOrderbook(pair, depth = 12) {
  const live = useLivePrice(pair);
  return useMemo(() => {
    if (!live) return { bids: [], asks: [], spread: 0 };
    const tick = live > 1000 ? 0.5 : live > 10 ? 0.01 : 0.001;
    const asks = [];
    const bids = [];
    let askT = 0, bidT = 0;
    for (let i = 0; i < depth; i++) {
      const price = live + tick * (i + 1) + Math.random() * tick * 0.4;
      const size = 0.05 + Math.random() * 1.4;
      askT += size;
      asks.push({ price, size, total: askT });
    }
    for (let i = 0; i < depth; i++) {
      const price = live - tick * (i + 1) - Math.random() * tick * 0.4;
      const size = 0.05 + Math.random() * 1.4;
      bidT += size;
      bids.push({ price, size, total: bidT });
    }
    return { bids, asks, spread: tick * 2 };
  }, [pair, Math.floor((live || 0) * 100)]);
}

// ---- Candle chart (synthetic OHLC) ----
function useCandles(pair, n = 80) {
  const live = useLivePrice(pair) || (window.__livePrices?.[pair]);
  return useMemo(() => {
    if (!live) return [];
    const out = [];
    let p = live * 0.95;
    for (let i = 0; i < n; i++) {
      const open = p;
      const drift = (Math.random() - 0.45) * live * 0.008;
      const close = Math.max(0.0001, open + drift);
      const high = Math.max(open, close) + Math.random() * live * 0.004;
      const low = Math.min(open, close) - Math.random() * live * 0.004;
      out.push({ open, close, high, low });
      p = close;
    }
    // ensure last close == live
    out[n-1].close = live;
    out[n-1].high = Math.max(out[n-1].high, live);
    out[n-1].low = Math.min(out[n-1].low, live);
    return out;
  }, [pair, Math.floor((live || 0) * 10)]);
}

function CandleChart({ pair }) {
  const ref = useRef(null);
  const candles = useCandles(pair, 80);
  const live = useLivePrice(pair);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0,0,w,h);
    if (!candles.length) return;

    const padL = 8, padR = 60, padT = 12, padB = 22;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const min = Math.min(...candles.map(c => c.low));
    const max = Math.max(...candles.map(c => c.high));
    const range = (max - min) || 1;
    const Y = v => padT + (1 - (v - min) / range) * chartH;
    const cw = chartW / candles.length;

    // grid
    ctx.strokeStyle = 'rgba(94,234,212,0.05)'; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = padT + (i / 5) * chartH;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+chartW, y); ctx.stroke();
      const v = max - (i / 5) * range;
      ctx.fillStyle = 'rgba(148,163,184,0.5)';
      ctx.font = '9px JetBrains Mono';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(v), padL+chartW+6, y+3);
    }

    // candles
    candles.forEach((cd, i) => {
      const x = padL + i * cw + cw * 0.5;
      const up = cd.close >= cd.open;
      ctx.strokeStyle = up ? '#5eead4' : '#fb7185';
      ctx.fillStyle = up ? 'rgba(94,234,212,0.7)' : 'rgba(251,113,133,0.7)';
      ctx.lineWidth = 1;
      // wick
      ctx.beginPath(); ctx.moveTo(x, Y(cd.high)); ctx.lineTo(x, Y(cd.low)); ctx.stroke();
      // body
      const bodyTop = Y(Math.max(cd.open, cd.close));
      const bodyH = Math.max(1, Math.abs(Y(cd.open) - Y(cd.close)));
      ctx.fillRect(x - cw*0.32, bodyTop, cw*0.64, bodyH);
      ctx.strokeRect(x - cw*0.32, bodyTop, cw*0.64, bodyH);
    });

    // last price line
    if (live) {
      const ly = Y(live);
      ctx.strokeStyle = 'rgba(94,234,212,0.4)';
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL+chartW, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#5eead4';
      ctx.fillRect(padL+chartW, ly - 9, padR-2, 18);
      ctx.fillStyle = '#02030a';
      ctx.font = '10px JetBrains Mono';
      ctx.textAlign = 'left';
      ctx.fillText(fmtPrice(live), padL+chartW+4, ly+3);
    }
  }, [candles, live]);
  return <div className="trade-chart-wrap"><canvas ref={ref}/></div>;
}

// ---- Orderbook ----
function Orderbook({ pair, onPick }) {
  const ob = useOrderbook(pair, 11);
  const live = useLivePrice(pair);
  const maxTotal = Math.max(...ob.asks.map(x=>x.total), ...ob.bids.map(x=>x.total), 1);
  return (
    <div className="orderbook">
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', padding:'8px 12px', fontSize:9, letterSpacing:'0.18em', color:'var(--text-tertiary)', textTransform:'uppercase', borderBottom:'1px solid var(--hairline)'}}>
        <span>Price</span><span style={{textAlign:'right'}}>Size</span><span style={{textAlign:'right'}}>Total</span>
      </div>
      {[...ob.asks].reverse().map((r, i) => (
        <div key={'a'+i} className="ob-row ask" onClick={() => onPick?.(r.price)} style={{cursor:'pointer'}}>
          <div className="bg-fill" style={{width: (r.total/maxTotal*100)+'%'}}/>
          <span className="price">{fmtPrice(r.price)}</span>
          <span className="size">{r.size.toFixed(4)}</span>
          <span className="total">{r.total.toFixed(2)}</span>
        </div>
      ))}
      <div className="ob-spread">
        <span>SPREAD {ob.spread.toFixed(4)}</span>
        <span className="price">{fmtPrice(live)}</span>
        <span></span>
      </div>
      {ob.bids.map((r, i) => (
        <div key={'b'+i} className="ob-row bid" onClick={() => onPick?.(r.price)} style={{cursor:'pointer'}}>
          <div className="bg-fill" style={{width: (r.total/maxTotal*100)+'%'}}/>
          <span className="price">{fmtPrice(r.price)}</span>
          <span className="size">{r.size.toFixed(4)}</span>
          <span className="total">{r.total.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Pair list (left rail) ----
function PairList({ active, onPick }) {
  const prices = useAllPrices();
  const [q, setQ] = useState('');
  const pairs = (window.__pricePairs || []).filter(p => p.toLowerCase().includes(q.toLowerCase()));
  return (
    <Panel title="Markets" sub={`${pairs.length}`} padded={false}>
      <div style={{padding:'10px 12px', borderBottom:'1px solid var(--hairline)'}}>
        <input className="input" placeholder="Search..." value={q} onChange={e => setQ(e.target.value)} style={{padding:'6px 10px', fontSize:11}}/>
      </div>
      <div style={{maxHeight:'calc(100vh - 220px)', overflowY:'auto'}}>
        {pairs.map(p => {
          const px = prices[p];
          const o = window.__priceOpen24h?.[p];
          const chg = o ? ((px - o) / o) * 100 : 0;
          return (
            <div key={p} className={`pair-list-row ${active === p ? 'active' : ''}`} onClick={() => onPick(p)}>
              <span className="pulse-dot"/>
              <strong>{p.replace('-USD','')}</strong>
              <Sparkline data={window.__priceSparks?.[p]} color={chg >= 0 ? '#5eead4' : '#fb7185'} width={70} height={18}/>
              <span style={{textAlign:'right'}}>{fmtPrice(px)}</span>
              <span style={{textAlign:'right', color: chg >= 0 ? 'var(--accent)' : 'var(--neg)', fontSize:10}}>{fmtPct(chg, {dp:1})}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ---- Order Ticket ----
function OrderTicket({ pair }) {
  const s = useApiState();
  const live = useLivePrice(pair);
  const [side, setSide] = useState('BUY');
  const [type, setType] = useState('limit');
  const [price, setPrice] = useState('');
  const [size, setSize] = useState('');
  const [tif, setTif] = useState('GTC');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const [base, quote] = pair.split('-');
  const balance = s.balances[side === 'BUY' ? quote : base]?.available || 0;

  // auto-fill price with live when switching pair
  useEffect(() => {
    if (live && (!price || type === 'market')) setPrice(live.toFixed(live > 100 ? 2 : 4));
  }, [pair, live]);
  useEffect(() => {
    if (type === 'market' && live) setPrice(live.toFixed(2));
  }, [type, live]);

  const px = +price || live || 0;
  const sz = +size || 0;
  const notional = px * sz;
  const fee = notional * 0.006;
  const total = side === 'BUY' ? notional + fee : notional - fee;
  const enough = side === 'BUY' ? balance >= total : balance >= sz;

  function setPct(pct) {
    if (!live) return;
    if (side === 'BUY') {
      const usdAmt = balance * (pct / 100);
      const sz = usdAmt / (px || live);
      setSize(sz.toFixed(6));
    } else {
      setSize(((s.balances[base]?.available || 0) * (pct / 100)).toFixed(6));
    }
  }

  async function placeNow() {
    setBusy(true);
    try {
      await window.api.placeOrder({ pair, side, type, size: sz, price: type === 'market' ? undefined : px, tif });
      setSize('');
      setConfirm(null);
    } catch (e) {
      window.__toast({ kind: 'error', msg: e.message });
    }
    setBusy(false);
  }
  function attemptPlace() {
    if (!sz) { window.__toast({kind:'error', msg:'Size required'}); return; }
    if (!enough) { window.__toast({kind:'error', msg:'Insufficient balance'}); return; }
    if (s.settings.confirmOrders) {
      setConfirm({ pair, side, type, size: sz, price: px, tif, fee, total });
      setCountdown(5);
    } else {
      placeNow();
    }
  }

  // confirm countdown
  useEffect(() => {
    if (!confirm || countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [confirm, countdown]);

  return (
    <Panel title={`Order Ticket`} sub={pair} padded={false}>
      <div style={{padding:'12px 16px 0'}}>
        <div className="segmented">
          <button className={side === 'BUY' ? 'active buy' : ''} onClick={() => setSide('BUY')}>BUY · LONG</button>
          <button className={side === 'SELL' ? 'active sell' : ''} onClick={() => setSide('SELL')}>SELL · SHORT</button>
        </div>
      </div>
      <div className="ticket-row">
        <div className="segmented" style={{maxWidth:'100%'}}>
          {['market','limit','stop'].map(t => (
            <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>{t.toUpperCase()}</button>
          ))}
        </div>

        {type !== 'market' && (
          <div className="field">
            <div className="field-label">Price</div>
            <div className="input-with-suffix">
              <input className="input" type="number" value={price} onChange={e => setPrice(e.target.value)}/>
              <div className="input-suffix">USD</div>
            </div>
          </div>
        )}

        <div className="field">
          <div className="field-label">Size</div>
          <div className="input-with-suffix">
            <input className="input" type="number" value={size} onChange={e => setSize(e.target.value)} placeholder="0.00"/>
            <div className="input-suffix">{base}</div>
          </div>
          <div className="size-quick">
            {[25, 50, 75, 100].map(p => <button key={p} onClick={() => setPct(p)}>{p}%</button>)}
          </div>
        </div>

        <div className="field">
          <div className="field-label">Time-In-Force</div>
          <div className="segmented">
            {['GTC','IOC','FOK'].map(t => (
              <button key={t} className={tif === t ? 'active' : ''} onClick={() => setTif(t)}>{t}</button>
            ))}
          </div>
        </div>

        <div className="ticket-summary">
          <div className="ticket-summary-row"><span>Notional</span><span className="v">{fmtUsd(notional)}</span></div>
          <div className="ticket-summary-row"><span>Fee (0.6%)</span><span className="v dim">{fmtUsd(fee)}</span></div>
          <div className="ticket-summary-row total"><span>{side === 'BUY' ? 'Cost' : 'Receive'}</span><span className="v">{fmtUsd(total)}</span></div>
          <div className="ticket-summary-row"><span>{side === 'BUY' ? quote : base} balance</span><span className="v">{fmtAmt(balance, 6)}</span></div>
        </div>

        <button
          className={`btn ${side === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
          disabled={busy || !sz}
          onClick={attemptPlace}
          style={{justifyContent:'center', padding:'14px', fontSize:12}}>
          {busy ? '◌ TRANSMITTING' : `${side} ${base} · ${type.toUpperCase()}`}
        </button>
        {!enough && sz > 0 && (
          <div style={{fontFamily:'JetBrains Mono', fontSize:10, color:'var(--neg)', textAlign:'center'}}>INSUFFICIENT BALANCE</div>
        )}
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(null)}
        eyebrow={`◇ CONFIRM ${confirm?.side}`}
        title={`${confirm?.size} ${confirm && confirm.pair.split('-')[0]} @ ${confirm?.type.toUpperCase()}`}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirm(null)}>ABORT</button>
          <button
            className={`btn ${confirm?.side === 'BUY' ? 'btn-buy' : 'btn-sell'}`}
            disabled={busy || countdown > 0}
            onClick={placeNow}>
            {busy ? '◌ TRANSMITTING' : countdown > 0 ? `WAIT ${countdown}s` : `EXECUTE ${confirm?.side}`}
          </button>
        </>}>
        {confirm && (
          <div style={{display:'flex', flexDirection:'column', gap:14}}>
            <div className="ticket-summary">
              <div className="ticket-summary-row"><span>Pair</span><span className="v">{confirm.pair}</span></div>
              <div className="ticket-summary-row"><span>Side</span><span className="v" style={{color: confirm.side === 'BUY' ? 'var(--buy)' : 'var(--sell)'}}>{confirm.side}</span></div>
              <div className="ticket-summary-row"><span>Type</span><span className="v">{confirm.type.toUpperCase()}</span></div>
              <div className="ticket-summary-row"><span>Size</span><span className="v">{fmtAmt(confirm.size, 6)} {confirm.pair.split('-')[0]}</span></div>
              {confirm.type !== 'market' && <div className="ticket-summary-row"><span>Price</span><span className="v">${fmtPrice(confirm.price)}</span></div>}
              <div className="ticket-summary-row"><span>Fee</span><span className="v">{fmtUsd(confirm.fee)}</span></div>
              <div className="ticket-summary-row total"><span>{confirm.side === 'BUY' ? 'Total Cost' : 'Total Receive'}</span><span className="v">{fmtUsd(confirm.total)}</span></div>
            </div>
            <div className="onboard-warn">
              ⚠ Once executed this order broadcasts to {s.mode === 'live' ? 'Coinbase live' : 'paper book'} and cannot be unsent. Abort window: {countdown}s remaining.
            </div>
          </div>
        )}
      </Modal>
    </Panel>
  );
}

// ---- Trade view ----
function TradeView() {
  const [pair, setPair] = usePair();
  const live = useLivePrice(pair);
  const open = window.__priceOpen24h?.[pair];
  const chg = open ? ((live - open) / open) * 100 : 0;
  const [obPickPrice, setObPickPrice] = useState(null);

  return (
    <div className="trade-grid">
      <PairList active={pair} onPick={setPair}/>

      <div style={{display:'flex', flexDirection:'column', gap:16, minWidth:0}}>
        <Panel title={pair} sub={live ? `$${fmtPrice(live)}` : 'loading'} right={
          <div style={{display:'flex', gap:18, alignItems:'center', fontFamily:'JetBrains Mono', fontSize:11}}>
            <span>24H Δ <span style={{color: chg >= 0 ? 'var(--accent)' : 'var(--neg)'}}>{fmtPct(chg)}</span></span>
            <span className="dim">OPEN ${fmtPrice(open)}</span>
            <span className="pulse-dot"/>
          </div>
        } padded={false}>
          <CandleChart pair={pair}/>
        </Panel>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:16}}>
          <Panel title="Open Orders" sub={pair}>
            <OpenOrdersForPair pair={pair}/>
          </Panel>
          <Panel title="Recent Fills" sub={pair}>
            <FillsForPair pair={pair}/>
          </Panel>
        </div>
      </div>

      <div style={{display:'flex', flexDirection:'column', gap:16, minWidth:0}}>
        <OrderTicket pair={pair}/>
        <Panel title="Orderbook" sub={pair} padded={false}>
          <Orderbook pair={pair} onPick={(p) => { /* could fill ticket but isolated here */ }}/>
        </Panel>
      </div>
    </div>
  );
}

function OpenOrdersForPair({ pair }) {
  const s = useApiState();
  const orders = s.openOrders.filter(o => o.pair === pair);
  if (!orders.length) return <div className="table-empty">NO OPEN ORDERS</div>;
  return (
    <table className="table">
      <thead><tr><th>SIDE</th><th>TYPE</th><th className="right">SIZE</th><th className="right">PRICE</th><th></th></tr></thead>
      <tbody>
        {orders.map(o => (
          <tr key={o.id}>
            <td><span className={`chip chip-${o.side.toLowerCase()}`}>{o.side}</span></td>
            <td className="dim">{o.type}</td>
            <td className="right">{fmtAmt(o.size, 6)}</td>
            <td className="right">{fmtPrice(o.price)}</td>
            <td className="right"><button className="btn btn-sm btn-ghost" onClick={() => window.api.cancelOrder(o.id)} style={{color:'var(--neg)'}}>×</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function FillsForPair({ pair }) {
  const s = useApiState();
  const fills = s.fills.filter(f => f.pair === pair).slice(0, 8);
  if (!fills.length) return <div className="table-empty">NO RECENT FILLS</div>;
  return (
    <table className="table">
      <thead><tr><th>WHEN</th><th>SIDE</th><th className="right">SIZE</th><th className="right">PRICE</th></tr></thead>
      <tbody>
        {fills.map(f => (
          <tr key={f.id}>
            <td className="dim">{timeAgo(f.ts)}</td>
            <td><span className={`chip chip-${f.side.toLowerCase()}`}>{f.side}</span></td>
            <td className="right">{fmtAmt(f.size, 6)}</td>
            <td className="right">{fmtPrice(f.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

Object.assign(window, { TradeView });
