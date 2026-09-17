import React, { useEffect, useMemo, useState } from 'react';
import { api, money as formatMoney } from '../shared/api';
import { applyTheme } from '../shared/theme';
import { LogoMark } from '../shared/Logo';
import { Icon, ModeToggle, Modal, Spinner, usePolling, useToast } from '../shared/ui';
import AfroPayCheckout from './AfroPayCheckout';
import PhoneAuth from './PhoneAuth';
import { Account, Bag, BookingSheet, Directory, EventsScreen, HelpScreen, LegalScreen, MenuScreen, NotificationsScreen, ReceiptModal, TableScan, TicketsScreen } from './screens';

const TABS = [['events', 'Events', 'calendar'], ['tickets', 'Tickets', 'ticket'], ['menu', 'Menu', 'menu'], ['bag', 'Bag', 'table']];
const store = {
  get: (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function readUrl() {
  const q = new URLSearchParams(location.search);
  return { tenant: q.get('tenant') || '', table: q.get('table') || '', view: q.get('view') || '', ref: q.get('ref') || '', token: q.get('token') || '' };
}

function BackIcon() {
  return (
    <svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export default function GuestApp() {
  const initial = useMemo(readUrl, []);
  // The URL decides which venue is open: "/" is always the Encore home page.
  const [tenant, setTenant] = useState(initial.tenant);
  const [workspaces, setWorkspaces] = useState(null);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [guest, setGuest] = useState(undefined);
  const [view, setView] = useState(initial.view || (initial.table ? 'menu' : initial.ref ? 'tickets' : 'events'));
  const [records, setRecords] = useState(null);
  const [myEvents, setMyEvents] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [table, setTable] = useState(null);
  const [cart, setCart] = useState({});
  const [tip, setTip] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [auth, setAuth] = useState(null);
  const [legal, setLegal] = useState(false);
  const [toast, toastNode] = useToast();

  // ------------------------------------------------------------ loading
  useEffect(() => {
    api('guest/me').then(r => setGuest(r.guest)).catch(() => setGuest(null));
    api('workspaces').then(setWorkspaces).catch(e => setLoadError(e.message));
  }, []);

  useEffect(() => {
    if (!workspaces) return;
    if (tenant && !workspaces.some(w => w.id === tenant)) { setTenant(''); store.set('encore_tenant', ''); }
  }, [workspaces]);

  async function loadPublic(id = tenant) {
    if (!id) return;
    try {
      const out = await api('public?tenant=' + encodeURIComponent(id));
      setData(out);
      setLoadError('');
      return out;
    } catch (e) {
      setLoadError(e.message);
    }
  }

  useEffect(() => {
    if (!tenant) { setData(null); applyTheme({ mode: 'dark' }); return; }
    store.set('encore_tenant', tenant);
    setData(null);
    setCart(store.get('encore_cart_' + tenant, {}));
    loadPublic(tenant).then(async out => {
      if (!out) return;
      const token = initial.tenant === tenant && initial.table ? initial.table : store.get('encore_table_' + tenant, '');
      if (token) await selectTable(token, { quiet: !initial.table, tenantId: tenant });
    });
  }, [tenant]);

  useEffect(() => { if (data) applyTheme(data.settings.theme); }, [data?.settings.theme.accent, data?.settings.theme.mode]);
  useEffect(() => { if (tenant) store.set('encore_cart_' + tenant, cart); }, [cart]);

  async function loadRecords() {
    if (!guest || !tenant) { setRecords(guest === null ? [] : null); setMyEvents([]); return; }
    try {
      const out = await api('guest/records?tenant=' + encodeURIComponent(tenant));
      setRecords(out.records);
      setMyEvents(out.events);
    } catch (e) {
      if (e.status === 401) setGuest(null);
    }
  }
  async function loadNotifications() {
    if (!guest) return setNotifications([]);
    try { setNotifications(await api('guest/notifications')); } catch { /* keep last list */ }
  }
  useEffect(() => { loadRecords(); loadNotifications(); }, [guest?.id, tenant]);
  usePolling(() => { if (guest && tenant) { loadRecords(); loadNotifications(); loadPublic(); } }, 20000, [guest?.id, tenant]);

  // ------------------------------------------------------------ navigation
  function go(next, { replace } = {}) {
    setView(next);
    const q = new URLSearchParams();
    if (tenant) q.set('tenant', tenant);
    if (next !== 'events') q.set('view', next);
    history[replace ? 'replaceState' : 'pushState']({ view: next }, '', '/?' + q.toString());
    window.scrollTo({ top: 0 });
  }
  useEffect(() => {
    const pop = () => {
      const url = readUrl();
      if (!url.tenant) { setTenant(''); return; }
      setTenant(url.tenant);
      setView(url.view || 'events');
    };
    window.addEventListener('popstate', pop);
    history.replaceState({ view }, '', location.href);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  /** Run `then` now if signed in, otherwise after the guest signs in. */
  function requireAuth(reason, then) {
    if (guest) return then(guest);
    setAuth({ reason, then });
  }

  // ------------------------------------------------------------ tables
  async function selectTable(value, { quiet = false, tenantId = tenant } = {}) {
    let token = '', code = '', target = tenantId;
    try {
      const url = new URL(value);
      token = url.searchParams.get('table') || '';
      target = url.searchParams.get('tenant') || tenantId;
    } catch {
      if (/^[A-Za-z0-9]{6}$/.test(value.trim())) code = value.trim();
      else token = value.trim();
    }
    if (!token && !code) throw new Error('That QR code is not an Encore table code.');
    if (target !== tenantId) {
      location.assign('/?tenant=' + encodeURIComponent(target) + '&table=' + encodeURIComponent(token));
      return;
    }
    try {
      const found = await api('table?tenant=' + encodeURIComponent(target) + (code ? '&code=' + encodeURIComponent(code) : '&token=' + encodeURIComponent(token)));
      setTable(found);
      store.set('encore_table_' + target, found.token);
      if (!quiet) toast('Ordering for ' + found.name);
      return found;
    } catch (e) {
      store.set('encore_table_' + target, '');
      if (quiet) return null;
      throw e;
    }
  }
  function clearTable() {
    setTable(null);
    store.set('encore_table_' + tenant, '');
  }

  // ------------------------------------------------------------ checkout
  async function startCheckout(payload, previous) {
    const quote = await api('quote', { ...payload, tenant });
    setSheet({ type: 'checkout', quote, payload: { ...payload, tenant }, previous });
  }
  async function placeAtVenue(payload, endpoint = 'order') {
    const receipt = await api(endpoint, payload);
    if (payload.kind === 'menu') { setCart({}); setTip(0); }
    setSheet({ type: 'receipt', receipt });
    await Promise.all([loadRecords(), loadNotifications(), loadPublic()]);
  }

  async function signOut() {
    try { await api('guest/signout', {}); } catch { /* already signed out */ }
    setGuest(null);
    setRecords([]);
    setNotifications([]);
    setSheet(null);
    go('events');
    toast('Signed out');
  }

  function goHome() {
    setSheet(null);
    setTable(null);
    setData(null);
    setTenant('');
    store.set('encore_tenant', '');
    history.pushState({ view: 'home' }, '', '/');
    window.scrollTo({ top: 0 });
  }

  const ctx = {
    tenant, data, guest, records, myEvents, notifications, table, cart, tip, view,
    setCart, setTip, go, requireAuth, selectTable, clearTable, startCheckout, toast, setSheet,
    loadRecords, loadNotifications, setNotifications, openLegal: () => setLegal(true),
    money: cents => formatMoney(cents, data?.currency),
  };

  // ------------------------------------------------------------ render
  if (!workspaces && !loadError) return <div className="loading"><Spinner />Opening Encore…</div>;
  const modeToggleCorner = <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 50 }}><ModeToggle /></div>;
  if (!tenant) return <>{modeToggleCorner}<Directory workspaces={workspaces || []} error={loadError} onPick={id => { setTenant(id); setView('events'); history.pushState({ view: 'events' }, '', '/?tenant=' + encodeURIComponent(id)); window.scrollTo({ top: 0 }); }} /></>;
  if (!data) {
    return loadError
      ? <div className="directory"><p className="error errorbar" role="alert">{loadError}<button onClick={() => loadPublic()}>Try again</button></p><button onClick={() => { setTenant(''); store.set('encore_tenant', ''); }}>Choose another organizer</button></div>
      : <div className="loading"><Spinner />Loading…</div>;
  }

  const bagCount = Object.values(cart).reduce((a, b) => a + b, 0);
  const unread = notifications.filter(n => !n.read).length;
  const Screen = { events: EventsScreen, tickets: TicketsScreen, menu: MenuScreen, bag: Bag, notifications: NotificationsScreen, help: HelpScreen, terms: LegalScreen, privacy: LegalScreen }[view] || EventsScreen;

  return (
    <div className="guest-app">
      <header className="guest-top">
        <button className="home-link" onClick={goHome} aria-label="Encore home — all venues" title="All venues">
          <LogoMark size={34} />
        </button>
        <button className="org" onClick={() => go('events')} aria-label={data.name + ' page'}>
          {data.settings.theme.logo && <img src={data.settings.theme.logo} alt="" />}
          <span className="grow" style={{ minWidth: 0 }}><small>{data.demo ? 'DEMO · NO REAL PAYMENTS' : 'LIVE WITH ENCORE'}</small><b>{data.name}</b></span>
        </button>
        <nav className="topnav" aria-label="Guest navigation">
          {TABS.map(([id, label, icon]) => (
            <button key={id} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => go(id)}>
              <Icon name={icon} />{label}
              {id === 'bag' && bagCount > 0 && <span className="dot-count" aria-label={bagCount + ' items'}>{bagCount}</span>}
            </button>
          ))}
        </nav>
        <ModeToggle />
        <button className="icon-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} onClick={() => requireAuth('Get updates on your tickets and orders', () => go('notifications'))}>
          <Icon name="bell" />{unread > 0 && <span className="dot-count">{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button className="icon-btn" aria-label="Account and help" onClick={() => setSheet({ type: 'account' })}>
          {guest ? <span className="avatar" style={{ width: 30, height: 30, fontSize: 13 }}>{guest.name[0]}</span> : <Icon name="more" />}
        </button>
      </header>
      {loadError && <p className="error errorbar" role="alert" style={{ margin: '12px 16px 0' }}>{loadError}<button onClick={() => loadPublic()}>Retry</button></p>}
      <main className="guest-main" id="main">
        <nav className="backbar" aria-label="Back">
          {view === 'events'
            ? <button className="backlink" onClick={goHome}><BackIcon />All venues</button>
            : <button className="backlink" onClick={() => go('events')}><BackIcon />{data.name} events</button>}
        </nav>
        <Screen ctx={ctx} kind={view} />
      </main>
      <nav className="bottomnav" aria-label="Guest navigation, bottom">
        {TABS.map(([id, label, icon]) => (
          <button key={id} className={view === id ? 'active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => go(id)}>
            <Icon name={icon} />
            {label}
            {id === 'bag' && bagCount > 0 && <span className="dot-count" aria-label={bagCount + ' items'}>{bagCount}</span>}
          </button>
        ))}
      </nav>

      {sheet?.type === 'booking' && <BookingSheet ctx={ctx} event={sheet.event} onClose={() => setSheet(null)} />}
      {sheet?.type === 'scan' && <TableScan ctx={ctx} onClose={() => setSheet(null)} />}
      {sheet?.type === 'account' && <Account ctx={ctx} setGuest={setGuest} signOut={signOut} onClose={() => setSheet(null)} switchOrganizer={goHome} />}
      {sheet?.type === 'receipt' && <ReceiptModal ctx={ctx} receipt={sheet.receipt} onClose={() => { setSheet(null); if (view !== 'tickets') go('tickets'); }} />}
      {sheet?.type === 'checkout' && (
        <AfroPayCheckout quote={sheet.quote} payload={sheet.payload} venueEnabled={sheet.payload.kind === 'menu' && data.settings.payments.venue}
          onClose={() => setSheet(null)} onBack={() => setSheet(sheet.previous)}
          demo={data.demo} onPay={payload => placeAtVenue(payload, 'checkout')} onVenue={placeAtVenue} />
      )}
      {auth && (
        <PhoneAuth reason={auth.reason} openTerms={() => setLegal(true)} onClose={() => setAuth(null)}
          onSignedIn={(g, created) => {
            setGuest(g);
            const then = auth.then;
            setAuth(null);
            toast(created ? 'Welcome, ' + g.name.split(' ')[0] + '!' : 'Signed in');
            then?.(g);
          }} />
      )}
      {legal && (
        <Modal sheet title="Terms & Privacy" onClose={() => setLegal(false)} footer={<button className="primary block" onClick={() => setLegal(false)}>Close</button>}>
          <LegalScreen ctx={ctx} kind="terms" embedded />
          <LegalScreen ctx={ctx} kind="privacy" embedded />
        </Modal>
      )}
      {toastNode}
    </div>
  );
}
