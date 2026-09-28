import React, { useMemo, useState } from 'react';
import { dateTime, shortDate } from '../../shared/api';
import { eventStatus } from '../../shared/eventStatus';
import { exportPdf } from '../pdf';
import { Bars, DataTable, Kpi, TrendChart } from '../charts';
import { compact, Suggestions } from '../Reports';
import { buildReport, change, paymentLabel, slug, WALLET_NAMES } from '../reportData';
import { Empty, Icon, StarIcon } from '../../shared/ui';
import { PageActions, paidBadge } from './common';

export function Overview({ ctx }) {
  const { state, money, go, canManage, role, session } = ctx;
  const [exporting, setExporting] = useState(false);
  const [range, setRange] = useState(7);
  const today = new Date();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const report = useMemo(() => buildReport(state, { from: iso(new Date(Date.now() - (range - 1) * 86400000)), to: iso(today) }), [state, range]);
  const month = useMemo(() => buildReport(state, { from: iso(new Date(Date.now() - 29 * 86400000)), to: iso(today) }), [state]);
  const s = report.summary;
  const prev = report.previous?.summary;
  const delta = key => (prev ? change(s[key], prev[key]) : null);
  const live = ['Placed', 'Preparing', 'Ready'].map(status => [status, state.orders.filter(o => o.status === status).length]);
  const activeOrders = live.reduce((n, [, c]) => n + c, 0);
  const upcoming = [...state.events].sort((a, b) => a.date.localeCompare(b.date)).filter(e => new Date(e.date) >= new Date(Date.now() - 86400000));
  const soldFor = id => state.bookings.filter(b => b.event === id && b.status !== 'Cancelled').reduce((n, b) => n + b.qty, 0);
  const records = [...state.bookings, ...state.orders].sort((a, b) => b.created - a.created);
  const cfg = state.settings;
  const steps = [
    ['Create your first event', state.events.some(e => e.published), 'Events'],
    ['Add food & drinks', state.menu.length > 0, 'Menu'],
    ['Set up table QR codes', state.tables.length > 0, 'Tables'],
    ['Add your logo, location & photos', !!(cfg.theme.logo && (cfg.profile.address || cfg.profile.city) && cfg.profile.photos.length), 'Settings'],
    ['Add help & support contacts', !!(cfg.support.email || cfg.support.phone), 'Settings'],
    ['Publish your terms', !!cfg.legal.terms, 'Settings'],
    ['Set up VAT and TIN', cfg.tax.regime === 'none' || !!cfg.tax.tin, 'Settings'],
  ];
  const done = steps.filter(x => x[1]).length;
  const next = upcoming[0];
  const periodName = range === 7 ? 'last 7 days' : 'last 30 days';

  async function exportDashboard() {
    setExporting(true);
    try {
      const m = month.summary;
      const vs = (a, b) => { const c = change(a, b); return c === null ? '' : `${c >= 0 ? '+' : '-'}${Math.round(Math.abs(c) * 100)}% vs previous 30 days`; };
      const mp = month.previous.summary;
      await exportPdf({
        filename: `${slug(state.name)}-dashboard-${iso(today)}.pdf`,
        title: 'Dashboard summary',
        subtitle: `Last 30 days · ${state.events.filter(e => e.published).length} live events · ${state.currency}`,
        organization: state.name,
        logo: cfg.theme.logo,
        sections: [
          { title: 'Last 30 days', kpis: [
            ['Gross sales', money(m.gross), vs(m.gross, mp.gross)], ['Net sales', money(m.net), 'Excludes VAT and tips'], ['VAT collected', money(m.vat), vs(m.vat, mp.vat)],
            ['Tickets sold', m.ticketsSold, vs(m.ticketsSold, mp.ticketsSold)], ['Check-in rate', `${Math.round(m.checkinRate * 100)}%`, `${m.checkedIn} checked in`], ['Food & drink orders', m.orders, `Average ${money(m.avgOrder)}`],
            ['Tips', money(m.tips), `${Math.round(m.tipParticipation * 100)}% of orders tipped`], ['Paying guests', m.guests, `${money(m.spendPerGuest)} per guest`],
            ['Guest rating', session.ratings.count ? `${session.ratings.average.toFixed(1)} / 5` : 'No ratings', session.ratings.count ? `${session.ratings.count} ratings` : ''],
          ] },
          { title: 'Upcoming performances', table: { head: ['Date', 'Event', 'Venue', 'Sold', 'Sell-through', 'Status'], body: upcoming.map(e => [shortDate(e.date), e.name, e.venue, `${soldFor(e.id)}/${e.capacity}`, `${Math.round((soldFor(e.id) / (e.capacity || 1)) * 100)}%`, eventStatus(e, { soldOut: soldFor(e.id) >= e.capacity }).label]), align: { 3: 'right', 4: 'right' } } },
          ...(month.suggestions.length ? [{ title: 'Suggestions to grow sales', table: { head: ['#', 'Suggestion', 'Why'], body: month.suggestions.slice(0, 5).map((x, n) => [n + 1, x.title, x.body]) } }] : []),
          { title: 'Best sellers', table: { head: ['#', 'Item', 'Category', 'Qty', 'Revenue'], body: month.bestSellers.slice(0, 8).map((i, n) => [n + 1, i.name, i.category, i.qty, money(i.revenue)]), align: { 3: 'right', 4: 'right' } } },
          { title: 'Top tipped tables', table: { head: ['#', 'Table', 'Event', 'Tips', 'Tipped orders', 'Avg tip'], body: month.topTipped.slice(0, 8).map((t, n) => [n + 1, t.name, t.event, money(t.tips), `${t.tippedOrders}/${t.orders}`, money(t.avgTip)]), align: { 3: 'right', 4: 'right', 5: 'right' } } },
          { title: 'Latest activity', table: { head: ['When', 'Guest', 'Reference', 'Details', 'Payment', 'Total'], body: records.slice(0, 10).map(x => [dateTime(x.created * 1000), x.name, x.ref, x.qty ? `${x.qty} ticket(s) · ${x.eventName}` : `${x.tableName || 'Counter'} · ${x.items}`, paymentLabel(x), money(x.total)]), align: { 5: 'right' } } },
        ],
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageActions>
        {canManage && <button onClick={exportDashboard} disabled={exporting}><Icon name="download" />{exporting ? 'Preparing…' : 'Export PDF'}</button>}
        {canManage && <button className="primary" onClick={() => go('Events', 'create')}><Icon name="add" />Create event</button>}
      </PageActions>

      {canManage && done < steps.length && (
        <section className="card setup-strip">
          <div className="setup-progress" aria-hidden="true"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
          <div className="row spread wrap">
            <div><b>Finish setting up · {done} of {steps.length} done</b><p className="small">Next: {steps.find(x => !x[1])[0]}</p></div>
            <div className="setup-chips">
              {steps.filter(x => !x[1]).slice(0, 3).map(([label, , to]) => <button key={label} onClick={() => go(to)}>{label}<Icon name="next" /></button>)}
            </div>
          </div>
        </section>
      )}

      {canManage && (
        <>
          <div className="section-bar">
            <h2>Performance</h2>
            <div className="segmented" role="group" aria-label="Dashboard period">
              {[[7, '7 days'], [30, '30 days']].map(([n, label]) => <button key={n} aria-pressed={range === n} className={range === n ? 'active' : ''} onClick={() => setRange(n)}>{label}</button>)}
            </div>
          </div>
          <div className="kpis">
            <Kpi label="Gross sales" icon="wallet" value={money(s.gross)} delta={delta('gross')} hint={`vs previous ${range} days`} spark={report.daily.map(d => d.gross)} />
            <Kpi label="Tickets sold" icon="ticket" value={s.ticketsSold} delta={delta('ticketsSold')} hint={`${Math.round(s.checkinRate * 100)}% checked in`} spark={report.daily.map(d => d.ticketsSold)} />
            <Kpi label="Food & drink orders" icon="menu" value={s.orders} delta={delta('orders')} hint={`${money(s.avgOrder)} average`} spark={report.daily.map(d => d.orders)} />
            <Kpi label="Tips" icon="money" value={money(s.tips)} delta={delta('tips')} hint={`${Math.round(s.tipParticipation * 100)}% of orders tipped`} spark={report.daily.map(d => d.tips)} />
          </div>
        </>
      )}

      <div className="dash-grid">
        {canManage && (
          <section className="card dash-trend">
            <div className="card-head">
              <div><h2>Sales, {periodName}</h2><p>{money(s.ticketSales)} tickets · {money(s.menuSales)} food & drinks</p></div>
              <button onClick={() => go('Reports')}><Icon name="chart" />Full report</button>
            </div>
            {s.gross
              ? <TrendChart rows={report.daily} series={[{ key: 'tickets', label: 'Tickets' }, { key: 'menu', label: 'Food & drinks' }]} format={compact(true)} height={200} label="Daily sales" />
              : <Empty icon="chart" title="No sales in this period" body="Paid bookings and orders will show here as a daily trend." />}
          </section>
        )}

        {canManage && <PaymentsPanel ctx={ctx} />}

        {role !== 'Gate' && (
          <section className="card dash-live">
            <div className="card-head"><div><h2>Live service</h2><p>{activeOrders ? `${activeOrders} order${activeOrders > 1 ? 's' : ''} in progress` : 'No orders in progress'}</p></div><button onClick={() => go('Orders')}>Orders</button></div>
            <div className="pipeline">
              {live.map(([status, count]) => (
                <button key={status} className={'pipe ' + status.toLowerCase()} onClick={() => go('Orders')}>
                  <strong>{count}</strong><span>{status}</span>
                </button>
              ))}
            </div>
            {next && (
              <div className="next-event">
                <span className="eyebrow accent">Next up</span>
                <b>{next.name}</b>
                <small>{dateTime(next.date)} · {next.venue}</small>
                <div className="meter" aria-label={`${soldFor(next.id)} of ${next.capacity} sold`}><span style={{ width: Math.min(100, (soldFor(next.id) / (next.capacity || 1)) * 100) + '%' }} /></div>
                <small>{soldFor(next.id)} of {next.capacity} sold · {state.bookings.filter(b => b.event === next.id).flatMap(b => b.tickets || []).filter(t => t.used).length} checked in</small>
              </div>
            )}
          </section>
        )}

        <section className="card">
          <div className="card-head"><h2>Upcoming performances</h2>{canManage && <button onClick={() => go('Events')}>View events</button>}</div>
          {upcoming.length ? (
            <div className="list">
              {upcoming.slice(0, 5).map(e => {
                const d = new Date(e.date);
                const sold = soldFor(e.id);
                return (
                  <div className="listrow" key={e.id}>
                    <div className="datebox"><b>{d.getDate()}</b><small>{d.toLocaleString('en', { month: 'short' })}</small></div>
                    <div className="grow">
                      <h3>{e.name}</h3>
                      <small>{e.venue} · {sold}/{e.capacity} sold</small>
                      <div className="meter slim"><span style={{ width: Math.min(100, (sold / (e.capacity || 1)) * 100) + '%' }} /></div>
                    </div>
                    {(st => <span className={'badge ' + st.tone}>{st.label}</span>)(eventStatus(e, { soldOut: sold >= e.capacity }))}
                  </div>
                );
              })}
            </div>
          ) : <Empty title="Your first event awaits" body="Add the lineup, date, venue and a striking cover image." action={canManage ? 'Create event' : null} onAction={() => go('Events', 'create')} />}
        </section>

        {canManage && (
          <section className="card">
            <div className="card-head"><div><h2>Suggestions to grow sales</h2><p>From the last 30 days</p></div><button onClick={() => go('Reports')}>All suggestions</button></div>
            <Suggestions items={month.suggestions} limit={3} />
          </section>
        )}

        {canManage && (
          <section className="card">
            <div className="card-head"><div><h2>Top tipped tables</h2><p>Last 30 days</p></div><button onClick={() => go('Reports')}>Details</button></div>
            <DataTable limit={5} rank sort={{ key: 'tips', dir: 'desc' }} rows={month.topTipped} empty="No tips in the last 30 days." columns={[
              { key: 'name', label: 'Table', render: t => <><b>{t.name}</b><small>{t.event}</small></> },
              { key: 'tips', label: 'Tips', num: true, render: t => <b>{money(t.tips)}</b> },
              { key: 'tippedOrders', label: 'Tipped', num: true, render: t => `${t.tippedOrders}/${t.orders}` },
              { key: 'avgTip', label: 'Avg tip', num: true, render: t => money(t.avgTip) },
            ]} />
          </section>
        )}

        {canManage && (
          <section className="card">
            <div className="card-head"><div><h2>Best sellers</h2><p>Last 30 days, by quantity</p></div></div>
            {month.bestSellers.length
              ? <Bars rows={month.bestSellers.slice(0, 5)} value={r => r.qty} format={(v, r) => `${v} · ${money(r.revenue)}`} label={r => <><b>{r.name}</b><small>{r.category}</small></>} />
              : <p className="small">No food or drink orders in the last 30 days.</p>}
          </section>
        )}

        <section className="card">
          <div className="card-head"><h2>Guest ratings</h2>{session.ratings.count > 0 && <span className="row"><span className="stars" aria-hidden="true">{[1, 2, 3, 4, 5].map(i => <StarIcon key={i} filled={session.ratings.average >= i ? 1 : session.ratings.average >= i - 0.5 ? 0.5 : 0} />)}</span><b>{session.ratings.average.toFixed(1)}</b><span className="muted small">({session.ratings.count})</span></span>}</div>
          {session.ratings.recent?.length ? (
            <div className="list">{session.ratings.recent.slice(0, 4).map((r, i) => (
              <div className="listrow" key={i}><span className="stars" role="img" aria-label={`${r.stars} of 5 stars`}>{[1, 2, 3, 4, 5].map(i => <StarIcon key={i} size={14} filled={r.stars >= i ? 1 : 0} />)}</span><div className="grow"><b>{r.name}</b><small>{r.comment}</small></div></div>
            ))}</div>
          ) : <p className="small">{session.ratings.count ? 'No written reviews yet.' : 'Guests who book or order with you can rate your organization.'}</p>}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Latest activity</h2>{role !== 'Gate' && <button onClick={() => go('Orders')}>View orders</button>}</div>
        {records.length ? (
          <div className="list">
            {records.slice(0, 10).map(r => (
              <div className="listrow" key={r.id}>
                <span className="avatar">{r.name[0]}</span>
                <div className="grow">
                  <b>{r.name} · {r.qty ? r.eventName : r.tableName || 'Counter pickup'}</b>
                  <small>{r.ref} · {r.qty ? `${r.qty} ticket${r.qty > 1 ? 's' : ''}` : r.items} · {dateTime(r.created * 1000)}</small>
                </div>
                <b className="activity-amount">{money(r.total)}</b>
                {paidBadge(r)}
              </div>
            ))}
          </div>
        ) : <Empty icon="bell" title="The best is yet to come" body="Bookings and table orders appear here as guests book." />}
      </section>
    </>
  );
}

function PaymentsPanel({ ctx }) {
  const { state, money, go } = ctx;
  const [eventId, setEventId] = useState('');
  const inScope = r => !eventId || r.event === eventId;
  const everything = [...state.bookings, ...state.orders].filter(inScope);
  const all = everything.filter(r => r.status !== 'Cancelled');
  const paid = all.filter(r => r.paid);
  const atVenue = r => r.settledBy === 'Cash';
  const sum = rows => rows.reduce((n, r) => n + (r.total || 0), 0);
  const methods = Object.entries(paid.reduce((m, r) => {
    const key = atVenue(r) ? r.settledBy : r.wallet ? `${WALLET_NAMES[r.wallet] || r.wallet} (Afropay)` : 'Online (Afropay)';
    m[key] = (m[key] || 0) + r.total;
    return m;
  }, {})).sort((a, b) => b[1] - a[1]);
  const eventName = id => state.events.find(e => e.id === id)?.name || 'Other orders';
  const events = Object.entries(paid.reduce((m, r) => { const k = r.event || ''; m[k] = (m[k] || 0) + r.total; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const pending = all.filter(r => !r.paid);
  const status = [
    ['Paid online', paid.filter(r => !atVenue(r)).length, 'success'],
    ['Paid at the venue', paid.filter(atVenue).length, 'success'],
    ['Pending payment', pending.length, 'warning'],
    ['Cancelled', everything.filter(r => r.status === 'Cancelled').length, 'neutral'],
  ];
  return (
    <section className="card">
      <div className="card-head">
        <div><h2>Payments collected</h2><p>{eventId ? 'This event' : 'All events, all time'} · {paid.length} paid bookings and orders</p></div>
        <select aria-label="Show payments for" value={eventId} onChange={e => setEventId(e.target.value)} style={{ maxWidth: 220 }}>
          <option value="">All events</option>
          {[...state.events].sort((a, b) => b.date.localeCompare(a.date)).map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
        </select>
      </div>
      <strong style={{ fontSize: 28, display: 'block', margin: '4px 0 12px' }}>{money(sum(paid))}</strong>
      <div className="list">
        {methods.map(([m, v]) => <div className="listrow" key={m}><span className="grow">{m}</span><b>{money(v)}</b></div>)}
        {!methods.length && <p className="small">No payments recorded yet.</p>}
      </div>
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        <span className="badge neutral">Cash at venue · {money(sum(paid.filter(atVenue)))}</span>
        <span className="badge neutral">Afropay wallets · {money(sum(paid.filter(r => !atVenue(r))))}</span>
      </div>
      {!eventId && events.length > 0 && <>
        <h3 style={{ marginTop: 14 }}>By event</h3>
        <div className="list">{events.map(([id, v]) => <div className="listrow" key={id || 'none'}><span className="grow">{eventName(id)}</span><b>{money(v)}</b></div>)}</div>
      </>}
      <h3 style={{ marginTop: 14 }}>Payment status</h3>
      <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
        {status.map(([label, n, tone]) => <span key={label} className={'badge ' + tone}>{label} · {n}</span>)}
      </div>
      {pending.length > 0 && <p className="small" style={{ marginTop: 8 }}>{money(sum(pending))} not yet paid.</p>}
    </section>
  );
}
