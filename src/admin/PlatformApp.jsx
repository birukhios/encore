import React, { useEffect, useMemo, useState } from 'react';
import { api, money as formatMoney, shortDate, timeAgo } from '../shared/api';
import { applyTheme } from '../shared/theme';
import Logo, { LogoMark } from '../shared/Logo';
import { Avatar, Empty, ErrorText, Field, Glyph, Icon, Modal, ModeToggle, Spinner, useToast } from '../shared/ui';
import { DataTable, Delta, Donut, Insights, Kpi, TrendChart, pct } from './charts';
import { PageActions } from './pages';
import { exportPdf } from './pdf';
import { ReportBody, ReportFilters, TABS, Tabs, compact, defaultFilters, periodLabel, reportCsvRows, reportPdfSections } from './Reports';
import { buildPlatform, buildReport, change, downloadText, growthSeries, isoDay, slug, toCsv } from './reportData';

/*
 * Encore platform console: for Encore's own operators, not organizers.
 * Separate sign-in (platform_admins table, 12-hour sessions), read access to every organization,
 * and the ability to suspend/reactivate organizations and end organizer sessions.
 */

const PAGES = {
  Overview: { icon: 'grid', sub: 'The whole platform at a glance.' },
  Organizations: { icon: 'venue', sub: 'Every organizer on Encore — performance, team, and status.' },
  Analytics: { icon: 'chart', sub: 'Cross-organization sales, menu, tables, guests and timing.' },
  Guests: { icon: 'team', sub: 'Guest accounts across all organizations.' },
  Accounts: { icon: 'settings', sub: 'Organizer staff accounts and their sessions.' },
  Activity: { icon: 'clock', sub: 'What organizers and platform admins changed.' },
  System: { icon: 'screen', sub: 'Configuration and health of this deployment.' },
};
const NAV = [['Monitor', ['Overview', 'Analytics']], ['Manage', ['Organizations', 'Guests', 'Accounts']], ['Operations', ['Activity', 'System']]];

export default function PlatformApp() {
  const [me, setMe] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(() => new URLSearchParams(location.search).get('page') || 'Overview');
  const [navOpen, setNavOpen] = useState(false);
  const [toast, toastNode] = useToast();

  useEffect(() => { applyTheme({ mode: 'light' }); }, []);
  useEffect(() => { api('platform/me').then(setMe).catch(() => {}).finally(() => setLoading(false)); }, []);

  async function load() {
    setError('');
    try {
      setData(await api('platform/data'));
    } catch (e) {
      if (e.status === 401) setMe(null);
      else setError(e.message);
    }
  }
  useEffect(() => { if (me) load(); }, [me]);

  function go(next) {
    setPage(next);
    setNavOpen(false);
    history.replaceState(null, '', '/admin/platform' + (next === 'Overview' ? '' : '?page=' + encodeURIComponent(next)));
    window.scrollTo({ top: 0 });
  }

  if (loading) return <div className="loading"><Spinner />Opening Encore Platform…</div>;
  if (!me) return <PlatformSignIn onAuth={setMe} />;

  const current = PAGES[page] ? page : 'Overview';
  const Page = { Overview, Organizations, Analytics, Guests, Accounts, Activity, System }[current];
  const ctx = { data, go, toast, reload: load, me };

  return (
    <div className="admin-app platform">
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
      <aside className={'sidebar' + (navOpen ? ' open' : '')} aria-label="Platform navigation">
        <div className="side-brand">
          <LogoMark size={36} />
          <span className="grow" style={{ minWidth: 0 }}><b className="side-org">Encore Platform</b><small className="side-role">Platform admin{me.system.demo ? ' · Demo' : ''}</small></span>
          <button className="icon-btn menu-toggle ghost" aria-label="Close navigation" onClick={() => setNavOpen(false)}><Glyph name="x" /></button>
        </div>
        <nav className="nav">
          {NAV.map(([label, names]) => (
            <div className="nav-group" key={label}>
              <span className="navlabel">{label}</span>
              {names.map(name => (
                <button key={name} className={current === name ? 'active' : ''} aria-current={current === name ? 'page' : undefined} onClick={() => go(name)}>
                  <Icon name={PAGES[name].icon} /><span>{name}</span>
                  {name === 'Organizations' && data?.tenants.some(t => t.status === 'suspended') && <span className="count" title="Suspended organizations">{data.tenants.filter(t => t.status === 'suspended').length}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-user static">
          <Avatar name={me.admin.name} size={34} />
          <span className="grow" style={{ minWidth: 0 }}><b>{me.admin.name}</b><small>{me.admin.email}</small></span>
          <button className="icon-btn ghost" aria-label="Sign out" title="Sign out" onClick={async () => { await api('platform/signout', {}); setMe(null); setData(null); }}><Icon name="next" /></button>
        </div>
      </aside>
      <div className="shell">
        <header className="topbar">
          <button className="icon-btn menu-toggle" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Icon name="grid" /></button>
          <div className="grow" />
          <div className="row">
            {me.system.demo && <span className="badge warning demo-badge">Demo</span>}
            <ModeToggle />
            <button className="icon-btn" onClick={load} aria-label="Refresh data"><Icon name="refresh" /></button>
          </div>
        </header>
        <main className="main" id="main">
          {error && <div className="error errorbar" role="alert">{error}<button onClick={load}>Try again</button></div>}
          <div className="pagehead">
            <div><span className="eyebrow accent">Encore Platform</span><h1>{current}</h1><p>{PAGES[current].sub}</p></div>
            <div className="row" id="page-actions" />
          </div>
          {data ? <Page ctx={ctx} /> : !error && <div className="loading inline"><Spinner />Loading platform data…</div>}
        </main>
      </div>
      {toastNode}
    </div>
  );
}

function PlatformSignIn({ onAuth }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuth(await api('platform/signin', Object.fromEntries(new FormData(e.currentTarget))));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout platform-auth">
      <section className="auth-art">
        <Logo size={32} />
        <div className="auth-copy">
          <span className="eyebrow">Encore Platform</span>
          <h1>Operate the <br />whole stage.</h1>
          <p>Organizations, guests, sales and system health across Encore.</p>
        </div>
        <small>Restricted to Encore platform administrators.</small>
      </section>
      <section className="auth-main">
        <div className="auth-form">
          <div>
            <span className="eyebrow">Platform administrators only</span>
            <h1>Platform sign-in</h1>
            <p style={{ marginTop: 8 }}>Organizers sign in at <a href="/admin/signin">/admin</a>.</p>
          </div>
          <form className="form" onSubmit={submit}>
            <Field label="Email address" name="email" type="email" autoComplete="username" required />
            <Field label="Password" name="password" type="password" autoComplete="current-password" required />
            <ErrorText>{error}</ErrorText>
            <button className="primary lg-btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<Icon name="next" /></button>
          </form>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

const moneyIn = currency => cents => formatMoney(cents, currency);
const StatusBadge = ({ status }) => <span className={'badge ' + (status === 'suspended' ? 'danger' : 'success')}>{status === 'suspended' ? 'Suspended' : 'Active'}</span>;
const stamp = () => isoDay(new Date());

function usePlatform(data, filters) {
  return useMemo(() => buildPlatform(data.tenants, filters), [data, filters]);
}

// ---------------------------------------------------------------- Overview

function Overview({ ctx }) {
  const { data, go } = ctx;
  const [filters, setFilters] = useState(defaultFilters);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const p = usePlatform(data, filters);
  const money = moneyIn(p.currency);
  const s = p.report.summary;
  const prev = p.report.previous?.summary;
  const d = key => (prev ? change(s[key], prev[key]) : null);
  const start = filters.from ? new Date(filters.from + 'T00:00').getTime() / 1000 : 0;
  const newGuests = data.guests.filter(g => g.created >= start).length;
  const newOrgs = data.tenants.filter(t => t.created >= start).length;
  const dormant = p.orgs.filter(o => o.status !== 'suspended' && Date.now() / 1000 - o.lastActivity > 30 * 86400);
  const guestGrowth = growthSeries(data.guests.map(g => g.created), { from: filters.from, to: filters.to, cumulative: true });
  const findings = [
    p.totals.gmv && { tone: p.totals.topOrgShare > 0.6 ? 'watch' : 'info', title: `${p.ranked[0]?.name} generates ${pct(p.totals.topOrgShare)} of platform sales`, body: p.ranked.length > 3 ? `Top 3 organizations: ${pct(p.totals.top3Share)} of GMV.` : `${p.ranked.length} organization${p.ranked.length === 1 ? '' : 's'} selling in ${p.currency}.` },
    prev?.gross && { tone: d('gross') >= 0 ? 'good' : 'watch', title: `Platform sales ${d('gross') >= 0 ? 'up' : 'down'} ${pct(Math.abs(d('gross')))}`, body: `Compared with ${periodLabel(p.report.previous.from, p.report.previous.to)}.` },
    { tone: 'info', title: `${newGuests} new guest account${newGuests === 1 ? '' : 's'}`, body: `${data.guests.length} guests in total · ${p.totals.multiOrgGuests} bought from more than one organization.` },
    dormant.length && { tone: 'watch', title: `${dormant.length} organization${dormant.length > 1 ? 's' : ''} inactive for 30+ days`, body: dormant.slice(0, 3).map(o => o.name).join(', ') },
    p.totals.suspended && { tone: 'watch', title: `${p.totals.suspended} suspended organization${p.totals.suspended > 1 ? 's' : ''}`, body: 'Their guest pages are hidden and staff cannot sign in.' },
    p.totals.excludedCurrencies.length && { tone: 'info', title: 'Other currencies excluded from totals', body: `Totals are in ${p.currency}. Organizations using ${p.totals.excludedCurrencies.join(', ')} are listed but not added up.` },
    ...p.report.insights.filter(i => !i.title.startsWith('Gross sales')).slice(0, 3),
  ].filter(Boolean);

  async function exportOverview() {
    setBusy(true);
    try {
      await exportPdf({
        filename: `encore-platform-overview-${stamp()}.pdf`, kind: 'Platform report', organization: 'Encore Platform',
        title: 'Platform overview', subtitle: `${periodLabel(filters.from, filters.to)} · Totals in ${p.currency}`,
        sections: [
          { title: 'Platform summary', kpis: [
            ['Gross merchandise value', money(s.gross), prev ? `${d('gross') >= 0 ? '+' : '-'}${pct(Math.abs(d('gross')))} vs previous` : ''], ['Organizations', p.totals.organizations, `${p.totals.active} active · ${p.totals.suspended} suspended`], ['Selling organizations', p.totals.selling, 'With sales in period'],
            ['Tickets sold', s.ticketsSold, `${pct(s.checkinRate)} checked in`], ['Food & drink orders', s.orders, `${money(s.avgOrder)} average`], ['Paying guests', p.totals.guests, `${newGuests} new accounts`],
            ['VAT collected', money(s.vat), 'By organizers'], ['Tips', money(s.tips), `${pct(s.tipParticipation)} of orders`], ['Staff accounts', p.totals.staff, `${data.counts.staffSessions} signed in`],
          ] },
          { title: 'Key findings', table: { head: ['Finding', 'Detail'], body: findings.map(f => [f.title, f.body]) } },
          { title: 'Organization leaderboard', table: { head: ['#', 'Organization', 'Status', 'GMV', 'Share', 'Tickets', 'Orders', 'Rating'], body: p.ranked.map((o, i) => [i + 1, o.name, o.status, money(o.s.gross), pct(o.s.gross / (s.gross || 1)), o.s.ticketsSold, o.s.orders, o.ratings.count ? `${o.ratings.average.toFixed(1)} (${o.ratings.count})` : '—']), align: { 3: 'right', 4: 'right', 5: 'right', 6: 'right' } } },
        ],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageActions><button className="primary" onClick={exportOverview} disabled={busy}><Icon name="download" />{busy ? 'Preparing…' : 'Export PDF'}</button></PageActions>
      <ReportFilters filters={filters} setFilters={setFilters} />
      <div className="kpis">
        <Kpi label="Gross merchandise value" icon="wallet" value={money(s.gross)} delta={d('gross')} hint={`${s.bookings + s.orders} transactions`} spark={p.report.daily.map(r => r.gross)} />
        <Kpi label="Organizations" icon="venue" value={p.totals.organizations} hint={`${p.totals.selling} selling · ${newOrgs} new · ${p.totals.suspended} suspended`} />
        <Kpi label="Paying guests" icon="team" value={p.totals.guests} delta={d('guests')} hint={`${newGuests} new accounts`} />
        <Kpi label="Tickets sold" icon="ticket" value={s.ticketsSold} delta={d('ticketsSold')} hint={`${pct(s.checkinRate)} checked in`} spark={p.report.daily.map(r => r.ticketsSold)} />
        <Kpi label="Food & drink orders" icon="menu" value={s.orders} delta={d('orders')} hint={`${money(s.avgOrder)} average order`} />
        <Kpi label="VAT collected" icon="money" value={money(s.vat)} delta={d('vat')} hint="By organizers" />
        <Kpi label="Tips" icon="money" value={money(s.tips)} delta={d('tips')} hint={`${pct(s.tipParticipation)} of orders tipped`} />
        <Kpi label="Live events" icon="calendar" value={p.totals.liveEvents} hint={`${p.totals.events} events in total`} />
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Platform sales</h2><p>Daily ticket and food & drink sales across organizations ({p.currency}).</p></div><button onClick={() => go('Analytics')}><Icon name="chart" />Analytics</button></div>
        {p.report.daily.length > 1 ? <TrendChart rows={p.report.daily} series={[{ key: 'tickets', label: 'Tickets' }, { key: 'menu', label: 'Food & drinks' }]} format={compact(true)} label="Platform daily sales" /> : <p className="small">Not enough data for a trend yet.</p>}
      </section>
      <div className="report-grid">
        <section className="card"><div className="card-head"><h2>Platform findings</h2></div><Insights items={findings} limit={7} /></section>
        <section className="card">
          <div className="card-head"><div><h2>Sales by organization</h2><p>Share of GMV</p></div></div>
          {s.gross ? <Donut parts={[...p.ranked.slice(0, 5).map(o => ({ label: o.name, value: o.s.gross })), ...(p.ranked.length > 5 ? [{ label: 'Others', value: p.ranked.slice(5).reduce((t, o) => t + o.s.gross, 0) }] : [])]} format={money} /> : <p className="small">No sales in this period.</p>}
        </section>
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Organization leaderboard</h2><p>Select an organization for details.</p></div><button onClick={() => go('Organizations')}>All organizations</button></div>
        <DataTable rank limit={8} sort={{ key: 'gross', dir: 'desc' }} rows={p.orgs.map(o => ({ ...o, gross: o.s.gross, tickets: o.s.ticketsSold, orders: o.s.orders, share: o.currency === p.currency ? o.s.gross / (s.gross || 1) : 0, rating: o.ratings.average || 0 }))} onRow={o => setSelected(o.id)} columns={orgColumns(p)} />
      </section>
      {guestGrowth.length > 1 && (
        <section className="card">
          <div className="card-head"><div><h2>Guest accounts</h2><p>Cumulative sign-ups</p></div></div>
          <TrendChart rows={guestGrowth.map(r => ({ date: r.date, guests: r.value }))} series={[{ key: 'guests', label: 'Guest accounts' }]} height={160} label="Guest accounts over time" />
        </section>
      )}
      {selected && <OrgDetail ctx={ctx} id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function orgColumns(p) {
  return [
    { key: 'name', label: 'Organization', render: o => <span className="org-cell">{o.logo ? <img src={o.logo} alt="" /> : <LogoMark size={28} />}<span><b>{o.name}</b><small>{o.city || '—'} · {o.team} staff</small></span></span> },
    { key: 'status', label: 'Status', render: o => <StatusBadge status={o.status} /> },
    { key: 'gross', label: 'GMV', num: true, render: o => <b>{formatMoney(o.s.gross, o.currency)}</b> },
    { key: 'share', label: 'Share', num: true, render: o => (o.currency === p.currency ? pct(o.share) : o.currency) },
    { key: 'tickets', label: 'Tickets', num: true },
    { key: 'orders', label: 'Orders', num: true },
    { key: 'rating', label: 'Rating', num: true, render: o => (o.ratings.count ? `${o.ratings.average.toFixed(1)} (${o.ratings.count})` : '—') },
    { key: 'lastActivity', label: 'Last sale', num: true, render: o => (o.lastActivity ? timeAgo(o.lastActivity) : 'Never') },
  ];
}

// ---------------------------------------------------------------- Organizations

function Organizations({ ctx }) {
  const { data } = ctx;
  const [filters, setFilters] = useState(defaultFilters);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState(null);
  const p = usePlatform(data, filters);
  const rows = p.orgs
    .filter(o => status === 'all' || o.status === status)
    .filter(o => !query || `${o.name} ${o.city}`.toLowerCase().includes(query.toLowerCase()))
    .map(o => ({ ...o, gross: o.s.gross, tickets: o.s.ticketsSold, orders: o.s.orders, share: o.currency === p.currency ? o.s.gross / (p.report.summary.gross || 1) : 0, rating: o.ratings.average || 0 }));

  function exportCsv() {
    downloadText(`encore-organizations-${stamp()}.csv`, toCsv([
      ['Encore organizations'], ['Period', periodLabel(filters.from, filters.to)], [],
      ['Organization', 'Status', 'Suspension reason', 'City', 'Currency', 'Created', 'Staff', 'Events', 'Live events', 'Menu items', 'Tables', 'Gross', 'Net', 'VAT', 'Tips', 'Tickets sold', 'Check-in rate', 'Orders', 'Average order', 'Paying guests', 'Rating', 'Ratings', 'Last sale'],
      ...p.orgs.map(o => [o.name, o.status, data.tenants.find(t => t.id === o.id).statusNote, o.city, o.currency, o.created ? isoDay(new Date(o.created * 1000)) : '', o.team, o.events, o.liveEvents, o.menu, o.tables,
        formatMoney(o.s.gross, o.currency), formatMoney(o.s.net, o.currency), formatMoney(o.s.vat, o.currency), formatMoney(o.s.tips, o.currency), o.s.ticketsSold, pct(o.s.checkinRate), o.s.orders, formatMoney(o.s.avgOrder, o.currency), o.s.guests,
        o.ratings.average ?? '', o.ratings.count, o.lastActivity ? isoDay(new Date(o.lastActivity * 1000)) : '']),
    ]));
  }

  return (
    <>
      <PageActions><button onClick={exportCsv}><Icon name="download" />CSV</button></PageActions>
      <ReportFilters filters={filters} setFilters={setFilters}>
        <Field label="Search"><input type="search" placeholder="Name or city" value={query} onChange={e => setQuery(e.target.value)} /></Field>
        <Field label="Status"><select value={status} onChange={e => setStatus(e.target.value)}><option value="all">All</option><option value="active">Active</option><option value="suspended">Suspended</option></select></Field>
      </ReportFilters>
      <section className="card">
        <div className="card-head"><h2>{rows.length} organization{rows.length === 1 ? '' : 's'}</h2></div>
        <DataTable rank limit={25} sort={{ key: 'gross', dir: 'desc' }} rows={rows} onRow={o => setSelected(o.id)} columns={orgColumns(p)} empty="No organizations match." />
      </section>
      {selected && <OrgDetail ctx={ctx} id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function OrgDetail({ ctx, id, onClose }) {
  const { data, reload, toast } = ctx;
  const tenant = data.tenants.find(t => t.id === id);
  const [filters, setFilters] = useState(defaultFilters);
  const [view, setView] = useState('Summary');
  const [tab, setTab] = useState('Overview');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const report = useMemo(() => buildReport(tenant, filters), [tenant, filters]);
  if (!tenant) return null;
  const money = moneyIn(tenant.currency);
  const s = report.summary;
  const d = key => (report.previous ? change(s[key], report.previous.summary[key]) : null);

  async function setStatus(status) {
    setBusy(true);
    setError('');
    try {
      await api('platform/tenant/status', { tenant: id, status, note });
      await reload();
      setConfirm(false);
      toast(status === 'suspended' ? `${tenant.name} suspended` : `${tenant.name} reactivated`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function endSessions(user) {
    try {
      await api('platform/user/signout', { user: user.id });
      await reload();
      toast(`${user.name} was signed out`);
    } catch (e) {
      setError(e.message);
    }
  }
  async function exportOrg(kind) {
    const period = periodLabel(filters.from, filters.to);
    if (kind === 'csv') return downloadText(`${slug(tenant.name)}-platform-report-${stamp()}.csv`, toCsv(reportCsvRows(report, money, [[`${tenant.name} — Encore platform report`], ['Period', period], ['Status', tenant.status], ['Currency', tenant.currency]])));
    await exportPdf({ filename: `${slug(tenant.name)}-platform-report-${stamp()}.pdf`, kind: 'Platform report', organization: tenant.name, logo: tenant.logo, title: 'Organization report', subtitle: `${period} · ${tenant.currency} · ${tenant.status === 'suspended' ? 'Suspended' : 'Active'}`, sections: reportPdfSections(report, money) });
  }

  return (
    <Modal wide title={tenant.name} eyebrow={`Organization · ${tenant.city || 'No city'} · ${tenant.currency}`} onClose={onClose}>
      <div className="org-detail">
        <div className="row spread wrap">
          <div className="row wrap"><StatusBadge status={tenant.status} />{tenant.created > 0 && <span className="muted small">Joined {shortDate(tenant.created * 1000)}</span>}<span className="muted small">{tenant.team.length} staff · {tenant.events.length} events · {tenant.menu.length} menu items · {tenant.tables.length} tables</span></div>
          <div className="row"><button onClick={() => exportOrg('csv')}><Icon name="download" />CSV</button><button onClick={() => exportOrg('pdf')}><Icon name="download" />PDF</button></div>
        </div>
        {tenant.status === 'suspended' && <p className="notice warning">Suspended: {tenant.statusNote || 'No reason recorded.'}</p>}
        <Tabs tabs={['Summary', 'Analytics', 'Events', 'Team', 'Status']} value={view} onChange={setView} label="Organization sections" />
        {view === 'Summary' && (
          <>
            <ReportFilters filters={filters} setFilters={setFilters} />
            <div className="kpis">
              <Kpi label="Gross sales" value={money(s.gross)} delta={d('gross')} />
              <Kpi label="Tickets sold" value={s.ticketsSold} delta={d('ticketsSold')} hint={`${pct(s.checkinRate)} checked in`} />
              <Kpi label="Orders" value={s.orders} delta={d('orders')} hint={`${money(s.avgOrder)} average`} />
              <Kpi label="Paying guests" value={s.guests} delta={d('guests')} />
            </div>
            <div className="report-grid">
              <section className="card"><div className="card-head"><h2>Findings</h2></div>{report.insights.length ? <Insights items={report.insights} limit={5} /> : <p className="small">Not enough activity.</p>}</section>
              <section className="card">
                <div className="card-head"><h2>Profile</h2></div>
                <ul className="plain-list">
                  <li><span>Address</span><b>{tenant.address || '—'}</b></li>
                  <li><span>Support</span><b>{tenant.support.email || tenant.support.phone || '—'}</b></li>
                  <li><span>Tax</span><b>{tenant.tax.regime === 'vat' ? `VAT ${tenant.tax.vatRate}%` : 'None'}{tenant.tax.tin ? ` · TIN ${tenant.tax.tin}` : ''}</b></li>
                  <li><span>Rating</span><b>{tenant.ratings.count ? `${tenant.ratings.average.toFixed(1)} from ${tenant.ratings.count}` : '—'}</b></li>
                </ul>
              </section>
            </div>
          </>
        )}
        {view === 'Analytics' && (
          <>
            <ReportFilters filters={filters} setFilters={setFilters} events={tenant.events} />
            <Tabs tabs={TABS} value={tab} onChange={setTab} />
            <ReportBody report={buildReport(tenant, filters)} money={money} tab={tab} />
          </>
        )}
        {view === 'Events' && (
          <DataTable limit={20} sort={{ key: 'date', dir: 'desc' }} rows={tenant.events.map(e => {
            const sold = tenant.bookings.filter(b => b.event === e.id && b.status !== 'Cancelled').reduce((n, b) => n + b.qty, 0);
            return { ...e, sold, fill: sold / (e.capacity || 1) };
          })} columns={[
            { key: 'name', label: 'Event', render: e => <><b>{e.name}</b><small>{e.venue}</small></> },
            { key: 'date', label: 'Date', render: e => shortDate(e.date) },
            { key: 'published', label: 'Status', value: e => (e.published ? 1 : 0), render: e => <span className={'badge ' + (e.published ? 'success' : 'neutral')}>{e.published ? 'Published' : 'Draft'}</span> },
            { key: 'price', label: 'Price', num: true, render: e => money(e.price) },
            { key: 'sold', label: 'Sold', num: true, render: e => `${e.sold}/${e.capacity}` },
            { key: 'fill', label: 'Sell-through', num: true, render: e => pct(e.fill) },
          ]} empty="No events yet." />
        )}
        {view === 'Team' && (
          <div className="list">
            {tenant.team.map(u => (
              <div className="listrow" key={u.id}>
                <Avatar name={u.name} src={u.avatar} size={36} />
                <div className="grow"><b>{u.name}</b><small>{u.email} · {u.role} · {u.lastSeen ? `last sign-in ${timeAgo(u.lastSeen)}` : 'never signed in'}</small></div>
                {u.signedIn ? <button onClick={() => endSessions(u)}>End sessions</button> : <span className="badge neutral">Signed out</span>}
              </div>
            ))}
          </div>
        )}
        {view === 'Status' && (
          <section className="card danger-zone">
            {tenant.status === 'suspended' ? (
              <>
                <h3>Reactivate organization</h3>
                <p className="small">Staff can sign in again and the organization's events and menu become visible to guests.</p>
                <button className="primary" disabled={busy} onClick={() => setStatus('active')}>{busy ? 'Reactivating…' : 'Reactivate'}</button>
              </>
            ) : (
              <>
                <h3>Suspend organization</h3>
                <p className="small">Suspending signs out all of its staff, blocks their sign-in, and hides the organization from guests. Existing receipts stay available to guests. Nothing is deleted.</p>
                <Field label="Reason (recorded in the platform log)"><textarea rows={3} maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder="For example: payment dispute under review" /></Field>
                {!confirm
                  ? <button className="danger" disabled={!note.trim()} onClick={() => setConfirm(true)}>Suspend…</button>
                  : <div className="row wrap"><b>Suspend {tenant.name}?</b><button onClick={() => setConfirm(false)}>Cancel</button><button className="danger" disabled={busy} onClick={() => setStatus('suspended')}>{busy ? 'Suspending…' : 'Yes, suspend'}</button></div>}
              </>
            )}
          </section>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Analytics

function Analytics({ ctx }) {
  const { data } = ctx;
  const [filters, setFilters] = useState(defaultFilters);
  const [orgId, setOrgId] = useState('all');
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState(false);
  const p = usePlatform(data, filters);
  const tenant = data.tenants.find(t => t.id === orgId);
  const report = useMemo(() => (tenant ? buildReport(tenant, filters) : p.report), [tenant, filters, p]);
  const money = moneyIn(tenant ? tenant.currency : p.currency);
  const scope = tenant ? tenant.name : 'All organizations';
  const period = periodLabel(filters.from, filters.to);
  const hasData = report.summary.bookings + report.summary.orders > 0;

  async function exportReport(kind) {
    if (kind === 'csv') return downloadText(`encore-platform-analytics-${slug(scope)}-${stamp()}.csv`, toCsv(reportCsvRows(report, money, [['Encore platform analytics'], ['Scope', scope], ['Period', period], ['Currency', tenant ? tenant.currency : p.currency]])));
    setBusy(true);
    try {
      await exportPdf({ filename: `encore-platform-analytics-${slug(scope)}-${stamp()}.pdf`, kind: 'Platform report', organization: tenant ? tenant.name : 'Encore Platform', logo: tenant?.logo, title: 'Platform analytics', subtitle: `${scope} · ${period} · ${tenant ? tenant.currency : p.currency}`, sections: reportPdfSections(report, money) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageActions>
        <button onClick={() => exportReport('csv')} disabled={!hasData}><Icon name="download" />CSV</button>
        <button className="primary" onClick={() => exportReport('pdf')} disabled={!hasData || busy}><Icon name="download" />{busy ? 'Preparing…' : 'Export PDF'}</button>
      </PageActions>
      <ReportFilters filters={filters} setFilters={setFilters}>
        <Field label="Organization">
          <select value={orgId} onChange={e => setOrgId(e.target.value)}>
            <option value="all">All organizations ({p.currency})</option>
            {data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </ReportFilters>
      <div className="report-context">
        <span><b>{period}</b> · {scope}</span>
        {report.previous && <span className="muted small">Gross sales vs previous period <Delta value={change(report.summary.gross, report.previous.summary.gross)} /></span>}
      </div>
      {hasData ? (
        <>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          <ReportBody report={report} money={money} tab={tab} />
        </>
      ) : <section className="card"><Empty icon="chart" title="No sales in this period" body="Try a wider date range or another organization." /></section>}
    </>
  );
}

// ---------------------------------------------------------------- Guests

function Guests({ ctx }) {
  const { data } = ctx;
  const [query, setQuery] = useState('');
  const currency = buildPlatform(data.tenants).currency;
  const rows = useMemo(() => data.guests.map(g => {
    const orgs = new Set();
    let bookings = 0, orders = 0, spent = 0, last = 0, tickets = 0;
    for (const t of data.tenants) {
      for (const r of [...t.bookings, ...t.orders]) {
        if (r.guest !== g.id) continue;
        orgs.add(t.name);
        last = Math.max(last, r.created);
        if (!r.paid || r.status === 'Cancelled') continue;
        if ('qty' in r) { bookings += 1; tickets += r.qty; } else orders += 1;
        if (t.currency === currency) spent += r.total;
      }
    }
    return { ...g, orgs: [...orgs], orgCount: orgs.size, bookings, orders, tickets, spent, last };
  }), [data]);
  const shown = rows.filter(g => !query || `${g.name} ${g.phone}`.toLowerCase().includes(query.toLowerCase()));
  const active30 = rows.filter(g => g.last > Date.now() / 1000 - 30 * 86400).length;
  const buyers = rows.filter(g => g.bookings + g.orders > 0);

  return (
    <>
      <PageActions>
        <button onClick={() => downloadText(`encore-guests-${stamp()}.csv`, toCsv([['Name', 'Phone', 'Joined', 'Organizations', 'Bookings', 'Tickets', 'Orders', `Spent (${currency})`, 'Last activity'], ...rows.map(g => [g.name, g.phone, isoDay(new Date(g.created * 1000)), g.orgs.join('; '), g.bookings, g.tickets, g.orders, (g.spent / 100).toFixed(2), g.last ? isoDay(new Date(g.last * 1000)) : ''])]))}><Icon name="download" />CSV</button>
      </PageActions>
      <div className="kpis">
        <Kpi label="Guest accounts" value={rows.length} hint={`${rows.filter(g => g.created > Date.now() / 1000 - 30 * 86400).length} joined in 30 days`} />
        <Kpi label="Active in 30 days" value={active30} hint={pct(active30 / (rows.length || 1)) + ' of accounts'} />
        <Kpi label="Have purchased" value={buyers.length} hint={pct(buyers.length / (rows.length || 1)) + ' conversion'} />
        <Kpi label="Multi-organization" value={rows.filter(g => g.orgCount > 1).length} hint="Bought from 2+ organizers" />
        <Kpi label="Lifetime value" value={formatMoney(buyers.length ? Math.round(buyers.reduce((t, g) => t + g.spent, 0) / buyers.length) : 0, currency)} hint="Average per buying guest" />
      </div>
      <section className="card">
        <div className="card-head"><h2>{shown.length} guest{shown.length === 1 ? '' : 's'}</h2><div className="search inline"><Icon name="search" /><input type="search" aria-label="Search guests" placeholder="Name or phone" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
        <DataTable limit={25} sort={{ key: 'spent', dir: 'desc' }} rows={shown} columns={[
          { key: 'name', label: 'Guest', render: g => <><b>{g.name}</b><small>{g.phone}</small></> },
          { key: 'created', label: 'Joined', render: g => shortDate(g.created * 1000) },
          { key: 'orgCount', label: 'Organizations', render: g => <><b>{g.orgCount}</b><small>{g.orgs.join(', ') || '—'}</small></> },
          { key: 'tickets', label: 'Tickets', num: true },
          { key: 'orders', label: 'Orders', num: true },
          { key: 'spent', label: 'Spent', num: true, render: g => <b>{formatMoney(g.spent, currency)}</b> },
          { key: 'last', label: 'Last activity', num: true, render: g => (g.last ? timeAgo(g.last) : '—') },
        ]} empty="No guests match." />
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Accounts

function Accounts({ ctx }) {
  const { data, reload, toast } = ctx;
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('all');
  const [error, setError] = useState('');
  const rows = data.tenants.flatMap(t => t.team.map(u => ({ ...u, org: t.name, orgStatus: t.status })));
  const shown = rows.filter(u => (role === 'all' || u.role === role) && (!query || `${u.name} ${u.email} ${u.org}`.toLowerCase().includes(query.toLowerCase())));
  async function endSessions(u) {
    setError('');
    try {
      await api('platform/user/signout', { user: u.id });
      await reload();
      toast(`${u.name} was signed out`);
    } catch (e) {
      setError(e.message);
    }
  }
  const roles = ['Owner', 'Admin', 'Service', 'Gate'];
  return (
    <>
      <PageActions><button onClick={() => downloadText(`encore-staff-accounts-${stamp()}.csv`, toCsv([['Name', 'Email', 'Organization', 'Role', 'Signed in', 'Last sign-in'], ...rows.map(u => [u.name, u.email, u.org, u.role, u.signedIn ? 'Yes' : 'No', u.lastSeen ? new Date(u.lastSeen * 1000).toISOString() : ''])]))}><Icon name="download" />CSV</button></PageActions>
      <div className="kpis">
        <Kpi label="Staff accounts" value={rows.length} hint={`${data.tenants.length} organizations`} />
        <Kpi label="Signed in now" value={rows.filter(u => u.signedIn).length} />
        {roles.map(r => <Kpi key={r} label={{ Owner: 'Owners', Admin: 'Admins', Service: 'Service staff', Gate: 'Gate staff' }[r]} value={rows.filter(u => u.role === r).length} />)}
      </div>
      <section className="card">
        <div className="card-head">
          <h2>{shown.length} account{shown.length === 1 ? '' : 's'}</h2>
          <div className="row wrap">
            <div className="search inline"><Icon name="search" /><input type="search" aria-label="Search accounts" placeholder="Name, email or organization" value={query} onChange={e => setQuery(e.target.value)} /></div>
            <select aria-label="Role" value={role} onChange={e => setRole(e.target.value)}><option value="all">All roles</option>{roles.map(r => <option key={r}>{r}</option>)}</select>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
        <DataTable limit={25} sort={{ key: 'lastSeen', dir: 'desc' }} rows={shown} columns={[
          { key: 'name', label: 'Name', render: u => <span className="org-cell"><Avatar name={u.name} src={u.avatar} size={30} /><span><b>{u.name}</b><small>{u.email}</small></span></span> },
          { key: 'org', label: 'Organization', render: u => <><b>{u.org}</b>{u.orgStatus === 'suspended' && <small>Suspended</small>}</> },
          { key: 'role', label: 'Role', render: u => <span className="badge neutral">{u.role}</span> },
          { key: 'lastSeen', label: 'Last sign-in', num: true, render: u => (u.lastSeen ? timeAgo(u.lastSeen) : 'Never') },
          { key: 'signedIn', label: 'Session', num: true, value: u => (u.signedIn ? 1 : 0), render: u => (u.signedIn ? <button className="small-btn" onClick={() => endSessions(u)}>End sessions</button> : <span className="muted small">Signed out</span>) },
        ]} empty="No accounts match." />
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Activity

const ACTION_LABELS = {
  settings: 'Updated workspace', config: 'Changed settings', event: 'Saved event', menu: 'Saved menu item', table: 'Saved table', delete: 'Deleted item',
  order_status: 'Updated order status', checkin: 'Checked in booking', checkin_ticket: 'Checked in ticket', settle: 'Recorded payment', cancel: 'Cancelled',
  guest_booking: 'Guest bought tickets', guest_menu: 'Guest placed order', signin: 'Signed in', suspend: 'Suspended organization', reactivate: 'Reactivated organization', end_sessions: 'Ended sessions',
};

function Activity({ ctx }) {
  const { data } = ctx;
  const [view, setView] = useState('Organizers');
  const [org, setOrg] = useState('all');
  const [kind, setKind] = useState('all');
  const audit = data.audit.filter(a => (org === 'all' || a.tenant === org) && (kind === 'all' || (kind === 'guest' ? String(a.user).startsWith('guest:') : !String(a.user).startsWith('guest:'))));
  const byAction = Object.entries(audit.reduce((m, a) => ({ ...m, [a.action]: (m[a.action] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <PageActions>
        <button onClick={() => downloadText(`encore-activity-${stamp()}.csv`, toCsv(view === 'Organizers'
          ? [['When', 'Organization', 'Who', 'Action'], ...audit.map(a => [new Date(a.created * 1000).toISOString(), a.tenantName, a.who, ACTION_LABELS[a.action] || a.action])]
          : [['When', 'Admin', 'Action', 'Target', 'Detail'], ...data.platformAudit.map(a => [new Date(a.created * 1000).toISOString(), a.who, ACTION_LABELS[a.action] || a.action, a.target, a.detail])]))}><Icon name="download" />CSV</button>
      </PageActions>
      <Tabs tabs={['Organizers', 'Platform admins']} value={view} onChange={setView} label="Activity source" />
      {view === 'Organizers' ? (
        <>
          <section className="card report-filters">
            <div className="report-filter-fields">
              <Field label="Organization"><select value={org} onChange={e => setOrg(e.target.value)}><option value="all">All organizations</option>{data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
              <Field label="Actor"><select value={kind} onChange={e => setKind(e.target.value)}><option value="all">Staff and guests</option><option value="staff">Staff only</option><option value="guest">Guests only</option></select></Field>
            </div>
          </section>
          <div className="report-grid">
            <section className="card">
              <div className="card-head"><div><h2>Recent activity</h2><p>Latest {audit.length} of the last 300 events</p></div></div>
              <DataTable limit={20} sort={{ key: 'created', dir: 'desc' }} rows={audit} columns={[
                { key: 'created', label: 'When', render: a => timeAgo(a.created) },
                { key: 'tenantName', label: 'Organization' },
                { key: 'who', label: 'Who' },
                { key: 'action', label: 'Action', render: a => ACTION_LABELS[a.action] || a.action },
              ]} empty="No activity." />
            </section>
            <section className="card">
              <div className="card-head"><h2>By action</h2></div>
              {byAction.length ? <Donut parts={byAction.slice(0, 7).map(([a, n]) => ({ label: ACTION_LABELS[a] || a, value: n }))} /> : <p className="small">No activity.</p>}
            </section>
          </div>
        </>
      ) : (
        <section className="card">
          <DataTable limit={25} sort={{ key: 'created', dir: 'desc' }} rows={data.platformAudit} columns={[
            { key: 'created', label: 'When', render: a => `${shortDate(a.created * 1000)} · ${timeAgo(a.created)}` },
            { key: 'who', label: 'Admin' },
            { key: 'action', label: 'Action', render: a => ACTION_LABELS[a.action] || a.action },
            { key: 'target', label: 'Target', render: a => <><b>{a.target || '—'}</b>{a.detail && <small>{a.detail}</small>}</> },
          ]} empty="No platform admin activity yet." />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- System

function System({ ctx }) {
  const { data } = ctx;
  const sys = data.system;
  const checks = [
    ['Database', sys.database, sys.database === 'PostgreSQL' ? 'good' : 'watch', sys.database === 'PostgreSQL' ? 'Durable managed database.' : 'SQLite: back up the data directory regularly.'],
    ['Environment', sys.production ? 'Production' : 'Development', sys.production ? 'good' : 'info', sys.production ? 'Secure cookies and HTTPS origins enforced.' : 'Not running with ENCORE_ENV=production.'],
    ['Demo mode', sys.demo ? 'On' : 'Off', sys.demo ? 'watch' : 'good', sys.demo ? 'Sign-in codes are shown on screen and payments are simulated. Not for real guests or money.' : 'Real SMS and payment rules apply.'],
    ['SMS delivery', sys.sms.delivers ? 'Connected' : 'Not delivering', sys.sms.delivers ? 'good' : 'watch', sys.sms.label],
    ['Online payments', sys.payments.ready ? 'Connected' : 'Not connected', sys.payments.ready ? 'good' : 'watch', sys.payments.label],
  ];
  const records = data.tenants.reduce((n, t) => n + t.bookings.length + t.orders.length, 0);
  return (
    <>
      <div className="kpis">
        <Kpi label="Organizations" value={data.tenants.length} />
        <Kpi label="Guest accounts" value={data.guests.length} hint={`${data.counts.guestSessions} active guest sessions`} />
        <Kpi label="Staff signed in" value={data.counts.staffSessions} />
        <Kpi label="Bookings & orders" value={records} />
        <Kpi label="Sign-in codes (24 h)" value={data.counts.otpsLastDay} />
        <Kpi label="Uploaded images" value={data.counts.uploads} />
      </div>
      <section className="card">
        <div className="card-head"><h2>Configuration checks</h2><span className="muted small">Server time {new Date(sys.serverTime * 1000).toLocaleString()}</span></div>
        <ul className="insights checks">
          {checks.map(([label, value, tone, body]) => <li key={label} className={tone}><span className="insight-dot" aria-hidden="true" /><div><b>{label}: {value}</b><p>{body}</p></div></li>)}
        </ul>
      </section>
      <section className="card">
        <div className="card-head"><h2>Addresses</h2></div>
        <ul className="plain-list">
          <li><span>Guest app</span><a href={sys.guestOrigin} target="_blank" rel="noreferrer">{sys.guestOrigin}</a></li>
          <li><span>Organizer admin</span><a href={sys.adminOrigin + '/admin'} target="_blank" rel="noreferrer">{sys.adminOrigin}/admin</a></li>
          <li><span>Platform console</span><span>{sys.adminOrigin}/admin/platform</span></li>
        </ul>
      </section>
    </>
  );
}
