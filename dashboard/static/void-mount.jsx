// =============================================================
// VOID Mount — top-level App, view router, drawer wiring
// =============================================================

function BridgeBanner({ state }) {
  if (state?.bridgeOnline !== false) return null;
  const anyLoading = Object.values(state?.loading || {}).some(Boolean);
  return (
    <div className="bridge-banner" role="status">
      <span className="pulse-dot dead"/>
      <span className="bridge-banner-msg">
        Bridge offline · reconnecting{anyLoading ? '…' : '...'}
      </span>
      <span className="bridge-banner-hint">
        Trading endpoints will resume automatically when freqtrade is reachable.
      </span>
    </div>
  );
}

function App() {
  const s = useApiState();
  const [view, setView] = useState(() => s.connected ? 'dashboard' : 'onboard');
  const [drawer, setDrawer] = useState(false);

  // Expose for cross-view nav
  useEffect(() => { window.__setView = setView; }, []);
  useEffect(() => { document.body.dataset.view = view; }, [view]);

  // If not connected, show onboard (unless user navigated to keys)
  if (!s.connected && view !== 'onboard') {
    return <OnboardView setView={setView}/>;
  }
  if (view === 'onboard') return <OnboardView setView={setView}/>;

  const titles = {
    dashboard: { t: 'Dashboard', sub: '⟢ Mission control' },
    portfolio: { t: 'Portfolio', sub: '⟢ Holdings & allocation' },
    markets:   { t: 'Markets',   sub: '⟢ Live instruments' },
    trade:     { t: 'Trade',     sub: '⟢ Order desk' },
    orders:    { t: 'Orders',    sub: '⟢ Open & queued' },
    history:   { t: 'History',   sub: '⟢ Fills & transfers' },
    strategies:{ t: 'Strategies',sub: '⟢ Algorithmic operators' },
    backtest:  { t: 'Backtest',  sub: '⟢ Historical simulator' },
    alerts:    { t: 'Alerts',    sub: '⟢ Metric watchdogs' },
    funding:   { t: 'Funding',   sub: '⟢ Deposits & withdrawals' },
    keys:      { t: 'API Keys',  sub: '⟢ Coinbase uplink' },
    settings:  { t: 'Settings',  sub: '⟢ Trading preferences' },
  };
  const meta = titles[view] || { t: view, sub: '' };

  // header right (live equity)
  const port = window.api.portfolio();
  const headerRight = (
    <>
      <div className="header-stat">
        <span className="header-stat-label">Equity</span>
        <span className="header-stat-value">{fmtUsd(port.totalUsd, {dp:0})}</span>
      </div>
      <div className="header-divider"/>
      <div className="header-stat">
        <span className="header-stat-label">Mode</span>
        <span className="header-stat-value" style={{color: s.mode === 'live' ? 'var(--neg)' : 'var(--solar)'}}>{s.mode.toUpperCase()}</span>
      </div>
      <div className="header-divider"/>
    </>
  );

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView}/>
      <div className="main">
        <PageHeader title={meta.t} subtitle={meta.sub} right={headerRight} onBell={() => setDrawer(true)}/>
        <BridgeBanner state={s}/>
        <div className="page-body">
          {view === 'dashboard'  && <DashboardView/>}
          {view === 'portfolio'  && <PortfolioView/>}
          {view === 'markets'    && <MarketsView/>}
          {view === 'trade'      && <TradeView/>}
          {view === 'orders'     && <OrdersView/>}
          {view === 'history'    && <HistoryView/>}
          {view === 'strategies' && <StrategiesView/>}
          {view === 'backtest'   && <BacktestView/>}
          {view === 'alerts'     && <AlertsView/>}
          {view === 'funding'    && <FundingView/>}
          {view === 'keys'       && <KeysView setView={setView}/>}
          {view === 'settings'   && <SettingsView/>}
        </div>
      </div>
      <NotificationsDrawer open={drawer} onClose={() => setDrawer(false)}/>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app-root')).render(<App/>);
