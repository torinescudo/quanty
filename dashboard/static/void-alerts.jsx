// =====================================================
// VOID Alerts — user-defined metric rules with channels
// =====================================================
// Reads state.alerts + state.alertEvents from the API layer and
// exposes CRUD + test through window.api.alerts.*.
// Metrics supported:
//   price.<PAIR>          e.g. price.BTC-USD
//   portfolio.equity      total USD equity from freqtrade
//   portfolio.drawdown    percent DD from running equity HWM
//   ratio.<A>/<B>         pairwise ratio, e.g. ratio.SOL-USD/ETH-USD

const OPS = [
  { id: '<',              label: '<',           kind: 'compare' },
  { id: '>',              label: '>',           kind: 'compare' },
  { id: '==',             label: '=',           kind: 'compare' },
  { id: 'crosses_above',  label: 'crosses ↑',   kind: 'cross'  },
  { id: 'crosses_below',  label: 'crosses ↓',   kind: 'cross'  },
];

const CHANNEL_LABELS = { inapp: 'In-app', discord: 'Discord', telegram: 'Telegram' };

function fmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1)    return n.toFixed(4);
  return n.toFixed(6);
}

function humanCondition(rule) {
  const label = OPS.find(o => o.id === rule.op)?.label || rule.op;
  return `${rule.metric} ${label} ${fmtNum(rule.threshold)}`;
}

function isTriggeredToday(rule) {
  if (!rule.last_triggered_at) return false;
  const dayAgo = Date.now() / 1000 - 24 * 3600;
  return rule.last_triggered_at >= dayAgo;
}

// ---- Metric builder ----
// Renders a compact metric picker with type-aware operand inputs.
function MetricBuilder({ metric, setMetric }) {
  const pairs = (window.__pricePairs || ['BTC-USD','ETH-USD','SOL-USD']);
  // parse current
  const parsed = React.useMemo(() => {
    if (metric?.startsWith('price.'))     return { type: 'price',    a: metric.slice(6),  b: pairs[1] };
    if (metric?.startsWith('ratio.')) {
      const rest = metric.slice(6);
      const [a, b] = rest.split('/');
      return { type: 'ratio', a: a || pairs[0], b: b || pairs[1] };
    }
    if (metric === 'portfolio.equity')    return { type: 'equity',   a: '', b: '' };
    if (metric === 'portfolio.drawdown')  return { type: 'drawdown', a: '', b: '' };
    return { type: 'price', a: pairs[0], b: pairs[1] };
  }, [metric]);

  function update(next) {
    const p = { ...parsed, ...next };
    if (p.type === 'price')    setMetric(`price.${p.a}`);
    if (p.type === 'ratio')    setMetric(`ratio.${p.a}/${p.b}`);
    if (p.type === 'equity')   setMetric('portfolio.equity');
    if (p.type === 'drawdown') setMetric('portfolio.drawdown');
  }

  return (
    <div style={{display:'flex', flexDirection:'column', gap:8}}>
      <select className="select" value={parsed.type} onChange={e => update({ type: e.target.value })}>
        <option value="price">Price of pair</option>
        <option value="ratio">Ratio of two pairs</option>
        <option value="equity">Portfolio equity (USD)</option>
        <option value="drawdown">Portfolio drawdown (%)</option>
      </select>
      {parsed.type === 'price' && (
        <select className="select" value={parsed.a} onChange={e => update({ a: e.target.value })}>
          {pairs.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
      {parsed.type === 'ratio' && (
        <div style={{display:'flex', gap:6, alignItems:'center'}}>
          <select className="select" value={parsed.a} onChange={e => update({ a: e.target.value })} style={{flex:1}}>
            {pairs.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <span style={{color:'var(--text-tertiary)', fontFamily:'JetBrains Mono', fontSize:12}}>/</span>
          <select className="select" value={parsed.b} onChange={e => update({ b: e.target.value })} style={{flex:1}}>
            {pairs.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

// ---- Rule row ----
function AlertRow({ rule }) {
  const [busy, setBusy] = React.useState(false);
  async function toggle() {
    setBusy(true);
    try { await window.api.alerts.update(rule.id, { enabled: !rule.enabled }); }
    catch (e) { window.__toast?.({ kind: 'error', msg: e.message }); }
    setBusy(false);
  }
  async function del() {
    setBusy(true);
    try {
      await window.api.alerts.remove(rule.id);
      window.__toast?.({ kind: 'system', msg: `Rule '${rule.name}' deleted` });
    } catch (e) { window.__toast?.({ kind: 'error', msg: e.message }); }
    setBusy(false);
  }
  async function test() {
    setBusy(true);
    try {
      await window.api.alerts.test(rule.id);
      window.__toast?.({ kind: 'system', msg: `Test dispatched for '${rule.name}'` });
    } catch (e) { window.__toast?.({ kind: 'error', msg: e.message }); }
    setBusy(false);
  }
  return (
    <tr style={{opacity: rule.enabled ? 1 : 0.6}}>
      <td>
        <button
          className={`btn btn-sm ${rule.enabled ? 'btn-buy' : 'btn-ghost'}`}
          onClick={toggle}
          disabled={busy}
          title={rule.enabled ? 'Disable' : 'Enable'}
          style={{minWidth:44}}
        >
          {rule.enabled ? 'ON' : 'OFF'}
        </button>
      </td>
      <td><strong>{rule.name}</strong></td>
      <td className="mono" style={{color:'var(--text-secondary)'}}>{humanCondition(rule)}</td>
      <td>
        {rule.channels.map(c => (
          <span key={c} className="chip chip-open" style={{marginRight:4}}>{CHANNEL_LABELS[c] || c}</span>
        ))}
      </td>
      <td className="dim">
        {rule.last_triggered_at
          ? timeAgo(rule.last_triggered_at * 1000) + ' ago'
          : 'never'}
      </td>
      <td className="right dim">{rule.trigger_count}</td>
      <td className="right">
        <button className="btn btn-sm btn-ghost" onClick={test} disabled={busy}>TEST</button>
        <button className="btn btn-sm btn-ghost" onClick={del} disabled={busy} style={{color:'var(--neg)'}}>×</button>
      </td>
    </tr>
  );
}

// ---- Main view ----
function AlertsView() {
  const s = useApiState();
  const rules = s.alerts || [];
  const events = s.alertEvents || [];

  const [name, setName]       = React.useState('');
  const [metric, setMetric]   = React.useState('price.BTC-USD');
  const [op, setOp]           = React.useState('<');
  const [threshold, setThr]   = React.useState('');
  const [cooldownMin, setCd]  = React.useState(60);
  const [chInapp, setChIn]    = React.useState(true);
  const [chDiscord, setChDc]  = React.useState(false);
  const [chTelegram, setChTg] = React.useState(false);
  const [busy, setBusy]       = React.useState(false);
  const [err, setErr]         = React.useState('');

  const activeCount    = rules.filter(r => r.enabled).length;
  const triggeredToday = rules.filter(isTriggeredToday).length;

  async function submit() {
    setErr('');
    const channels = [];
    if (chInapp)    channels.push('inapp');
    if (chDiscord)  channels.push('discord');
    if (chTelegram) channels.push('telegram');
    if (!channels.length) {
      setErr('Pick at least one channel'); return;
    }
    const thrNum = Number(threshold);
    if (!threshold || isNaN(thrNum)) {
      setErr('Threshold must be numeric'); return;
    }
    setBusy(true);
    try {
      await window.api.alerts.create({
        name: name || `${metric} ${op} ${threshold}`,
        metric, op, threshold: thrNum,
        channels,
        cooldown_seconds: Math.max(0, Number(cooldownMin) * 60) || 3600,
      });
      setName(''); setThr('');
      window.__toast?.({ kind: 'system', msg: 'Alert rule created' });
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  }

  const rulesById = React.useMemo(() => {
    const m = {};
    rules.forEach(r => { m[r.id] = r; });
    return m;
  }, [rules]);

  return (
    <>
      <div className="hud-row">
        <HudCard label="Active Rules"        value={`${activeCount} / ${rules.length}`}
                 sub={<><span className="pulse-dot"/><span className="dim">MONITORING</span></>}/>
        <HudCard label="Triggered · 24H"     value={triggeredToday}
                 sub={<><span className="dim">RULES FIRED</span></>} orbitColor="var(--solar)"/>
        <HudCard label="Recent Events"        value={events.length}
                 sub={<><span className="dim">LAST 500 STORED</span></>} orbitColor="var(--plasma)"/>
        <HudCard label="Total Fires"           value={rules.reduce((t, r) => t + (r.trigger_count || 0), 0)}
                 sub={<><span className="dim">ALL TIME</span></>} orbitColor="var(--warn)"/>
      </div>

      <div className="two-col">
        <Panel title="Rules" sub={`${rules.length} configured`}>
          {rules.length === 0 ? (
            <div className="table-empty">NO RULES · CREATE ONE →</div>
          ) : (
            <table className="table">
              <thead><tr>
                <th></th><th>NAME</th><th>CONDITION</th><th>CHANNELS</th>
                <th>LAST FIRE</th><th className="right">#</th><th></th>
              </tr></thead>
              <tbody>
                {rules.map(r => <AlertRow key={r.id} rule={r}/>)}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Create rule" sub="Define condition">
          <div style={{display:'flex', flexDirection:'column', gap:14}}>
            <div className="field">
              <div className="field-label">Name</div>
              <input className="input" placeholder="BTC dip alert" value={name}
                     onChange={e => setName(e.target.value)}/>
            </div>

            <div className="field">
              <div className="field-label">Metric</div>
              <MetricBuilder metric={metric} setMetric={setMetric}/>
            </div>

            <div className="field">
              <div className="field-label">Operator</div>
              <div className="segmented" style={{flexWrap:'wrap'}}>
                {OPS.map(o => (
                  <button key={o.id} className={op === o.id ? 'active' : ''}
                          onClick={() => setOp(o.id)}>{o.label}</button>
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field-label">Threshold</div>
              <input className="input" type="number" step="any" placeholder="50000"
                     value={threshold} onChange={e => setThr(e.target.value)}/>
            </div>

            <div className="field">
              <div className="field-label">Cooldown (minutes)</div>
              <input className="input" type="number" min="0" value={cooldownMin}
                     onChange={e => setCd(e.target.value)}/>
              <div className="field-help">No re-fire within this window after a trigger.</div>
            </div>

            <div className="field">
              <div className="field-label">Channels</div>
              <div className="segmented" style={{flexWrap:'wrap'}}>
                <button className={chInapp    ? 'active' : ''} onClick={() => setChIn(v => !v)}>In-app</button>
                <button className={chDiscord  ? 'active' : ''} onClick={() => setChDc(v => !v)}>Discord</button>
                <button className={chTelegram ? 'active' : ''} onClick={() => setChTg(v => !v)}>Telegram</button>
              </div>
              <div className="field-help">
                Discord/Telegram need DISCORD_WEBHOOK_URL / TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars — otherwise they no-op silently.
              </div>
            </div>

            {err && (
              <div className="onboard-warn" style={{borderLeftColor:'var(--neg)', color:'var(--neg)', background:'rgba(251,113,133,0.06)', borderColor:'rgba(251,113,133,0.25)'}}>
                {err}
              </div>
            )}

            <button className="btn btn-primary" onClick={submit} disabled={busy}
                    style={{justifyContent:'center'}}>
              {busy ? '◌ CREATING' : '⟢ CREATE ALERT'}
            </button>
          </div>
        </Panel>
      </div>

      <Panel title="Recent triggers" sub={`Last ${Math.min(20, events.length)}`}>
        {events.length === 0 ? (
          <div className="table-empty">NO TRIGGERS YET</div>
        ) : (
          <table className="table">
            <thead><tr>
              <th>WHEN</th><th>RULE</th><th>MESSAGE</th><th className="right">VALUE</th>
            </tr></thead>
            <tbody>
              {events.slice(0, 20).map((e, idx) => {
                const rule = rulesById[e.rule_id];
                return (
                  <tr key={e.id || idx}>
                    <td className="dim">
                      {new Date((e.ts || 0) * 1000).toLocaleString('en-US', {month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'})}
                    </td>
                    <td><strong>{rule?.name || e.rule_id}</strong></td>
                    <td className="dim">{e.message || '—'}</td>
                    <td className="right mono">{fmtNum(e.metric_value)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

// expose
Object.assign(window, { AlertsView });
