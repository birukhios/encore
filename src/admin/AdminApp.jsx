import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, money as formatMoney, timeAgo } from '../shared/api';
import { applyTheme } from '../shared/theme';
import { LogoMark } from '../shared/Logo';
import { Avatar, Glyph, Icon, ModeToggle, Modal, Spinner, usePolling, useToast } from '../shared/ui';
import Auth from './Auth';
import { Bookings, CheckIns, Events, Menu, Orders, Overview, Profile, Tables, Team } from './pages';
import Reports from './Reports';
import Settings from './Settings';
import { Stock, Waiters } from './service';

const PAGES = {
  Overview: { icon: 'grid', title: 'Every detail. One place.', sub: 'Your events, your guests, and everything in between.' },
  Events: { icon: 'calendar', sub: 'Create, publish, and shape your next live experience.' },
  Bookings: { icon: 'ticket', sub: 'Tickets sold online. Scan or type a reference to check guests in.' },
  'Check-ins': { icon: 'success', sub: 'Who has arrived, when, and who let them in.' },
  Reports: { icon: 'chart', sub: 'Sales, best sellers, busy tables and payments — ready to export.' },
  Tables: { icon: 'table', sub: 'A place for every guest. A QR code for every table.' },
  Menu: { icon: 'menu', sub: 'Food and drinks, served at the concerts you choose.' },
  Stock: { icon: 'grid', sub: 'Store supplies like beer, wine, bread and meat, plus menu item stock.' },
  Waiters: { icon: 'team', sub: 'Unique waiter numbers, badges and tips per waiter.' },
  Orders: { icon: 'wallet', sub: 'Keep every order moving, from kitchen to table.' },
  Team: { icon: 'team', sub: 'The people who make the night happen.' },
  Settings: { icon: 'settings', sub: 'Your organization, sales and guest experience.' },
  Profile: { icon: 'team', title: 'Your profile', sub: 'Your photo, name and password.' },
};

const NAV_GROUPS = [
  ['Run the night', ['Overview', 'Orders', 'Bookings', 'Check-ins']],
  ['Insights', ['Reports']],
  ['Set up', ['Events', 'Menu', 'Stock', 'Tables', 'Waiters']],
  ['Workspace', ['Team', 'Settings']],
];

export const ROLE_PAGES = {
  Owner: ['Overview', 'Events', 'Bookings', 'Check-ins', 'Reports', 'Tables', 'Menu', 'Stock', 'Waiters', 'Orders', 'Team', 'Settings'],
  Admin: ['Overview', 'Events', 'Bookings', 'Check-ins', 'Reports', 'Tables', 'Menu', 'Stock', 'Waiters', 'Orders', 'Team', 'Settings'],
  Service: ['Overview', 'Orders'],
  Gate: ['Overview', 'Bookings', 'Check-ins'],
};

export default function AdminApp() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(() => new URLSearchParams(location.search).get('page') || 'Overview');
  const [search, setSearch] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [bannerError, setBannerError] = useState('');
  const [intent, setIntent] = useState(null);
  const [toast, toastNode] = useToast();
  // Latest workspace version, so back-to-back saves never send a stale version.
  const versionRef = useRef(0);
  useEffect(() => { if (session) versionRef.current = session.version; }, [session?.version]);

  useEffect(() => {
    api('me').then(me => { if (me?.user) setSession(me); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const theme = session?.state?.settings?.theme;
    applyTheme({ accent: theme?.accent, mode: theme?.adminMode || 'light' });
  }, [session?.state?.settings?.theme?.accent, session?.state?.settings?.theme?.adminMode]);

  const refresh = async () => {
    try {
      setSession(await api('me'));
      setBannerError('');
    } catch (e) {
      if (e.status === 401 || e.code === 'TENANT_SUSPENDED') setSession(null);
      else setBannerError(e.message);
    }
  };
  usePolling(() => session && refresh(), 20000, [!!session]);

  const role = session?.user.role;
  const pages = ROLE_PAGES[role] || [];
  const current = page === 'Profile' || pages.includes(page) ? page : 'Overview';

  function go(next, nextIntent = null) {
    setIntent(nextIntent);
    setPage(next);
    setSearch('');
    setNavOpen(false);
    history.replaceState(null, '', next === 'Overview' ? '/admin' : '/admin?page=' + encodeURIComponent(next));
    window.scrollTo({ top: 0 });
  }

  const ctx = useMemo(() => {
    if (!session) return null;
    const state = session.state;
    return {
      session, state, role, search, go, toast, refresh, intent,
      canManage: ['Owner', 'Admin'].includes(role),
      money: cents => formatMoney(cents, state.currency),
      guestLink: query => session.guestOrigin + '/?tenant=' + encodeURIComponent(session.user.tenant) + (query || ''),
      matches: (...fields) => !search || fields.join(' ').toLowerCase().includes(search.toLowerCase()),
      async action(op, data, { quiet } = {}) {
        try {
          const result = await api('action', { op, data, version: versionRef.current });
          versionRef.current = result.version;
          setSession(result);
          if (!quiet) toast('Changes saved');
          return result;
        } catch (e) {
          if (e.status === 409) {
            await refresh();
            throw new Error('Someone else just changed this workspace. We refreshed it — please try again.');
          }
          if (e.status === 401 && e.message.startsWith('Please sign in')) setSession(null);
          throw e;
        }
      },
      setSession,
    };
  }, [session, search, intent]);

  if (loading) return <div className="loading"><Spinner />Opening Encore…</div>;
  if (!session) return <Auth onAuth={result => { setSession(result); go('Overview'); if (result.recovery) setRecovery(result.recovery); }} />;

  const { state } = session;
  const activeOrders = state.orders.filter(o => ['Placed', 'Preparing', 'Ready'].includes(o.status)).length;
  const meta = PAGES[current];
  const Page = { Overview, Events, Bookings, 'Check-ins': CheckIns, Reports, Tables, Menu, Stock, Waiters, Orders, Team, Settings, Profile }[current];
  const lowStock = state.menu.filter(i => i.trackStock && i.stock <= i.lowStock).length + (state.inventory || []).filter(i => i.quantity <= i.reorderLevel).length;

  return (
    <div className="admin-app">
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className={'sidebar' + (navOpen ? ' open' : '')} aria-label="Workspace navigation">
        <div className="side-brand">
          {state.settings.theme.logo ? <img className="side-logo" src={state.settings.theme.logo} alt="" /> : <LogoMark size={36} />}
          <span className="grow" style={{ minWidth: 0 }}>
            <b className="side-org">{state.name}</b>
            <small className="side-role">{role}{session.demo ? ' · Demo' : ''}</small>
          </span>
          <button className="icon-btn menu-toggle ghost" aria-label="Close navigation" onClick={() => setNavOpen(false)}><Glyph name="x" /></button>
        </div>
        <nav className="nav">
          {NAV_GROUPS.map(([label, names]) => {
            const visible = names.filter(n => pages.includes(n));
            return visible.length ? (
              <div className="nav-group" key={label}>
                <span className="navlabel">{label}</span>
                {visible.map(name => (
                  <button key={name} className={current === name ? 'active' : ''} aria-current={current === name ? 'page' : undefined} onClick={() => go(name)}>
                    <Icon name={PAGES[name].icon} />
                    <span>{name}</span>
                    {name === 'Orders' && activeOrders > 0 && <span className="count" aria-label={activeOrders + ' active orders'}>{activeOrders}</span>}
                    {name === 'Stock' && lowStock > 0 && <span className="count" aria-label={lowStock + ' items low or out of stock'}>{lowStock}</span>}
                  </button>
                ))}
              </div>
            ) : null;
          })}
        </nav>
        <button className={'side-user' + (current === 'Profile' ? ' active' : '')} onClick={() => go('Profile')}>
          <Avatar name={session.user.name} src={session.user.avatar} size={34} />
          <span className="grow" style={{ minWidth: 0 }}><b>{session.user.name}</b><small>{session.user.email}</small></span>
        </button>
      </aside>

      <div className="shell">
        <header className="topbar">
          <button className="icon-btn menu-toggle" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Icon name="grid" /></button>
          {!['Overview', 'Settings', 'Profile', 'Check-ins', 'Reports', 'Stock', 'Waiters'].includes(current) ? (
            <div className="search">
              <Icon name="search" />
              <input type="search" placeholder={'Search ' + current.toLowerCase() + '…'} aria-label={'Search ' + current} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          ) : <div className="grow" />}
          <div className="row">
            {session.demo && <span className="badge warning demo-badge" title="Sign-in codes are shown on screen and payments are simulated">Demo</span>}
            <ModeToggle />
            <button className="icon-btn" onClick={refresh} aria-label="Refresh workspace"><Icon name="refresh" /></button>
            <Notifications unread={session.unread} onRead={refresh} go={go} />
            <button className="avatar-btn" aria-label="Your profile" onClick={() => go('Profile')}><Avatar name={session.user.name} src={session.user.avatar} size={36} /></button>
          </div>
        </header>
        <main className="main" id="main">
          {bannerError && <div className="error errorbar" role="alert">{bannerError}<button onClick={refresh}>Try again</button></div>}
          <div className="pagehead">
            <div>
              <span className="eyebrow accent">{state.name}</span>
              <h1>{meta.title || current}</h1>
              <p>{meta.sub}</p>
            </div>
            <div className="row" id="page-actions" />
          </div>
          <Page ctx={ctx} />
        </main>
      </div>
      {recovery && (
        <Modal title="Welcome to your workspace." eyebrow="One more thing" label="Save your recovery code"
          footer={<button className="primary block" onClick={() => setRecovery('')}>I saved my recovery code</button>}>
          <p>Save this private recovery code somewhere safe. You will need it if you forget your password. It is only shown once.</p>
          <code className="recovery">{recovery}</code>
        </Modal>
      )}
      {toastNode}
    </div>
  );
}

function Notifications({ unread, onRead, go }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    setError('');
    try {
      setItems(await api('notifications'));
      if (unread) {
        await api('notifications/read', {});
        onRead();
      }
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (!open) return;
    const close = e => { if (!e.target.closest('.popwrap')) setOpen(false); };
    const esc = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="popwrap">
      <button className="icon-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} onClick={toggle}>
        <Icon name="bell" />
        {unread > 0 && <span className="dot-count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notifpanel" role="dialog" aria-label="Notifications">
          <header><h3>Notifications</h3><button className="linklike small" onClick={() => { setOpen(false); go('Orders'); }}>View orders</button></header>
          <div className="notiflist">
            {error && <p className="error" style={{ margin: 12 }}>{error}</p>}
            {!items && !error && <div style={{ padding: 20 }} className="center"><Spinner /></div>}
            {items?.length === 0 && <p className="center small" style={{ padding: 28 }}>You're all caught up. New bookings and orders will appear here.</p>}
            {items?.map(n => (
              <div key={n.id} className={'notif' + (n.read ? '' : ' unread')}>
                <Icon name={n.kind === 'booking' ? 'ticket' : 'menu'} />
                <div className="grow"><b>{n.title}</b><p>{n.body}</p><small>{timeAgo(n.created)}</small></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
