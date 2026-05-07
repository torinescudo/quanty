// =================================================
// VOID Shell: state hook, sidebar, page header, router
// =================================================
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---- toast system ----
window.__toast = function({ kind = 'system', msg }) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${msg}</span>`;
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; }, 3500);
  setTimeout(() => el.remove(), 3900);
};

// ---- state hook ----
function useApiState() {
  const [s, setS] = useState(() => window.api.state());
  useEffect(() => window.api.subscribe(setS), []);
  return s;
}

// ---- live price hook ----
function useLivePrice(pair) {
  const [p, setP] = useState(window.__livePrices?.[pair]);
  useEffect(() => {
    const onU = (e) => { if (e.detail.pair === pair) setP(e.detail.price); };
    window.addEventListener('priceupdate', onU);
    return () => window.removeEventListener('priceupdate', onU);
  }, [pair]);
  return p;
}
function useAllPrices() {
  const [, force] = useState(0);
  useEffect(() => {
    const onU = () => force(x => x + 1);
    window.addEventListener('priceupdate', onU);
    const t = setInterval(onU, 1000);
    return () => { window.removeEventListener('priceupdate', onU); clearInterval(t); };
  }, []);
  return window.__livePrices || {};
}

// ---- helpers ----
function fmtUsd(v, opts={}) {
  if (v == null || isNaN(v)) return '—';
  const { dp = 2, sign = false } = opts;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (sign) return (v >= 0 ? '+' : '−') + '$' + s;
  return (v < 0 ? '−' : '') + '$' + s;
}
function fmtPct(v, opts={}) {
  if (v == null || isNaN(v)) return '—';
  const { dp = 2 } = opts;
  return (v >= 0 ? '+' : '') + v.toFixed(dp) + '%';
}
function fmtPrice(p) {
  if (p == null) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(4);
}
function fmtAmt(v, dp = 4) {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return Math.floor(d / 1000) + 's';
  if (d < 3_600_000) return Math.floor(d / 60_000) + 'm';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + 'h';
  return Math.floor(d / 86_400_000) + 'd';
}

// ---- Icons ----
const I = {
  dashboard: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>,
  portfolio: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6 6"/></svg>,
  markets: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 17l5-5 4 4 8-9"/><path d="M14 7h7v7"/></svg>,
  trade: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8h13l-3-3M21 16H8l3 3"/></svg>,
  orders: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="4" y="3" width="16" height="18"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>,
  history: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>,
  strategies: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2"/></svg>,
  funding: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="6" width="18" height="13" rx="1"/><path d="M3 10h18M7 15h3"/></svg>,
  keys: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="14" r="4"/><path d="M11 14l9-9M16 6l3 3"/></svg>,
  settings: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4.8a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.4a7 7 0 0 0-2 1.2l-2.4-.8-2 3.5 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.5 2 3.5 2.4-.8a7 7 0 0 0 2 1.2L10 21h4l.5-2.4a7 7 0 0 0 2-1.2l2.4.8 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>,
  backtest: <svg className="nav-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 20V4M3 20h18"/><path d="M7 16l4-6 3 3 6-9"/><circle cx="7" cy="16" r="1.2" fill="currentColor"/><circle cx="11" cy="10" r="1.2" fill="currentColor"/><circle cx="14" cy="13" r="1.2" fill="currentColor"/><circle cx="20" cy="4" r="1.2" fill="currentColor"/></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M9 19a3 3 0 0 0 6 0"/></svg>,
  sliders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="16" height="16"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--bg-void)"/><circle cx="15" cy="12" r="2" fill="var(--bg-void)"/><circle cx="7" cy="17" r="2" fill="var(--bg-void)"/></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14"><circle cx="11" cy="11" r="7"/><path d="M16 16l4 4"/></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="14" height="14"><path d="M5 5l14 14M19 5L5 19"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12"><path d="M12 5v14M5 12h14"/></svg>,
  arrowDown: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12"><path d="M12 4v16M5 13l7 7 7-7"/></svg>,
  arrowUp: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12"><path d="M12 20V4M5 11l7-7 7 7"/></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12"><rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/></svg>,
};

// ---- Brand mark ----
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="13" stroke="var(--accent)" strokeWidth="1.4"/>
      <circle cx="16" cy="16" r="6" stroke="var(--accent)" strokeWidth="1" opacity="0.5"/>
      <circle cx="16" cy="16" r="1.6" fill="var(--accent)"/>
      <line x1="16" y1="3" x2="16" y2="29" stroke="var(--accent)" strokeWidth="0.5" opacity="0.3"/>
      <line x1="3" y1="16" x2="29" y2="16" stroke="var(--accent)" strokeWidth="0.5" opacity="0.3"/>
    </svg>
  );
}

// ---- Sidebar ----
const NAV = [
  { id:'dashboard',  label:'Dashboard',  icon:I.dashboard,  group:'TRADE' },
  { id:'portfolio',  label:'Portfolio',  icon:I.portfolio,  group:'TRADE' },
  { id:'markets',    label:'Markets',    icon:I.markets,    group:'TRADE' },
  { id:'trade',      label:'Trade',      icon:I.trade,      group:'TRADE' },
  { id:'orders',     label:'Orders',     icon:I.orders,     group:'TRADE', badgeFrom:'openOrders' },
  { id:'history',    label:'History',    icon:I.history,    group:'TRADE' },
  { id:'strategies', label:'Strategies', icon:I.strategies, group:'AUTO' },
  { id:'backtest',   label:'Backtest',   icon:I.backtest,   group:'AUTO' },
  { id:'funding',    label:'Funding',    icon:I.funding,    group:'ACCOUNT' },
  { id:'keys',       label:'API Keys',   icon:I.keys,       group:'ACCOUNT' },
  { id:'settings',   label:'Settings',   icon:I.settings,   group:'ACCOUNT' },
];

function Sidebar({ view, setView }) {
  const s = useApiState();
  const groups = useMemo(() => {
    const g = {};
    NAV.forEach(n => { (g[n.group] = g[n.group] || []).push(n); });
    return g;
  }, []);
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <BrandMark/>
        <div className="sidebar-brand-text">
          <div className="sidebar-brand-name">VOID</div>
          <div className="sidebar-brand-sub">QUANT.PLATFORM</div>
        </div>
      </div>

      {Object.entries(groups).map(([g, items]) => (
        <div key={g} className="sidebar-section">
          <div className="sidebar-section-title">{g}</div>
          {items.map(n => {
            const badge = n.badgeFrom ? (s[n.badgeFrom] || []).length : 0;
            return (
              <button
                key={n.id}
                className={`nav-item ${view === n.id ? 'active' : ''}`}
                onClick={() => setView(n.id)}
              >
                {n.icon}
                <span className="nav-item-label">{n.label}</span>
                {badge > 0 && <span className="nav-item-badge">{badge}</span>}
              </button>
            );
          })}
        </div>
      ))}

      <div className="sidebar-account">
        <div className="sidebar-account-row">
          <span className="sidebar-account-label">Account</span>
          <span className={`sidebar-account-mode ${s.connected ? s.mode : 'disconnected'}`}>
            <span className={`pulse-dot ${s.connected ? '' : 'dead'}`}/>
            {s.connected ? s.mode.toUpperCase() : 'OFFLINE'}
          </span>
        </div>
        <div className="sidebar-account-row">
          <span className="sidebar-account-label">UID</span>
          <span className="sidebar-account-value">{s.connected ? 'CB-' + (s.apiKey || '').slice(0,6).toUpperCase() : '—'}</span>
        </div>
      </div>
    </aside>
  );
}

// ---- Page header ----
function PageHeader({ title, subtitle, right, onBell }) {
  const s = useApiState();
  const unread = (s.notifications || []).filter(n => !n.read).length;
  return (
    <header className="page-header">
      <div className="page-header-left">
        <div className="page-title">{title}</div>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      <div className="page-header-right">
        {right}
        <button className="icon-btn" onClick={onBell} title="Notifications">
          {I.bell}
          {unread > 0 && <span className="icon-btn-badge">{unread}</span>}
        </button>
      </div>
    </header>
  );
}

// ---- Notification drawer ----
function NotificationsDrawer({ open, onClose }) {
  const s = useApiState();
  return (
    <div className={`drawer ${open ? 'open' : ''}`}>
      <div className="drawer-head">
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <div className="panel-head-marker"/>
          <div className="panel-head-title">Transmissions</div>
        </div>
        <div style={{display:'flex', gap:8}}>
          <button className="btn btn-sm btn-ghost" onClick={() => window.api.markAllRead()}>MARK READ</button>
          <button className="btn btn-sm btn-ghost" onClick={() => window.api.clearNotifs()}>CLEAR</button>
          <button className="icon-btn" onClick={onClose}>{I.close}</button>
        </div>
      </div>
      <div className="drawer-body">
        {(s.notifications || []).length === 0 && (
          <div style={{padding:'40px 20px', textAlign:'center', color:'var(--text-tertiary)', fontFamily:'JetBrains Mono', fontSize:10, letterSpacing:'0.2em'}}>NO TRANSMISSIONS</div>
        )}
        {(s.notifications || []).map(n => (
          <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
            <div className="notif-icon">
              {n.kind === 'fill' && <span className="pulse-dot"/>}
              {n.kind === 'system' && <span className="pulse-dot warn"/>}
              {n.kind === 'transfer' && <span className="pulse-dot warn"/>}
              {n.kind === 'strategy' && <span className="pulse-dot"/>}
            </div>
            <div className="notif-msg">{n.msg}</div>
            <div className="notif-time">{timeAgo(n.ts)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Modal ----
function Modal({ open, onClose, eyebrow, title, children, footer }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          {eyebrow && <div className="modal-eyebrow">{eyebrow}</div>}
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// expose
Object.assign(window, {
  useApiState, useLivePrice, useAllPrices,
  fmtUsd, fmtPct, fmtPrice, fmtAmt, timeAgo,
  Sidebar, PageHeader, NotificationsDrawer, Modal, I, BrandMark,
});
