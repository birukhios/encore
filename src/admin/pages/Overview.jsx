import React, { useMemo, useState } from 'react';
import { dateTime, shortDate } from '../../shared/api';
import { eventStatus } from '../../shared/eventStatus';
import { exportPdf } from '../pdf';
import { Bars, Donut, Kpi, TrendChart } from '../charts';
import { compact } from '../Reports';
import { buildReport, change, paymentLabel, slug } from '../reportData';
import { Empty, Icon } from '../../shared/ui';
import { PageActions, paidBadge } from './common';

export function Overview({ ctx }) {
  const { state, money, go, canManage, role, session } = ctx;
  const [exporting, setExporting] = useState(false);
  const [range, setRange] = useState(7);
  const [eventId, setEventId] = useState('');
  const today = new Date();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const report = useMemo(() => buildReport(state, { from: iso(new Date(Date.now() - (range - 1) * 86400000)), to: iso(today), eventId: eventId || undefined }), [state, range, eventId]);
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
  const periodName = { 1: 'today', 7: 'last 7 days', 30: 'last 30 days' }[range];
  const scope = eventId ? state.events.find(e => e.id === eventId)?.name : 'all events';
  const busyHours = report.byHour.filter(h => h.orders + h.bookings > 0);

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
          <div className="section-bar dash-filters">
            <div className="segmented" role="group" aria-label="Dashboard period">
              {[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([n, label]) => <button key={n} aria-pressed={range === n} className={range === n ? 'active' : ''} onClick={() => setRange(n)}>{label}</button>)}
            </div>
            <select aria-label="Event" value={eventId} onChange={e => setEventId(e.target.value)}>
              <option value="">All events</option>
              {[...state.events].sort((a, b) => b.date.localeCompare(a.date)).map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
            </select>
          </div>
          <div className="kpis">
            <Kpi label="Sales" icon="wallet" value={money(s.gross)} delta={delta('gross')} hint={`${periodName} · ${scope}`} spark={report.daily.map(d => d.gross)} />
            <Kpi label="Tickets sold" icon="ticket" value={s.ticketsSold} delta={delta('ticketsSold')} hint={`${Math.round(s.checkinRate * 100)}% checked in`} spark={report.daily.map(d => d.ticketsSold)} />
            <Kpi label="Food & drink orders" icon="menu" value={s.orders} delta={delta('orders')} hint={`${money(s.avgOrder)} average`} spark={report.daily.map(d => d.orders)} />
            <Kpi label="Orders in progress" icon="clock" value={activeOrders} hint={live.map(([st, n]) => `${n} ${st.toLowerCase()}`).join(' · ')} />
          </div>

          <div className="dash-grid">
            <section className="card dash-trend">
              <div className="card-head">
                <div><h2>Sales, {periodName}</h2><p>{money(s.ticketSales)} tickets · {money(s.menuSales)} food & drinks</p></div>
                <button onClick={() => go('Reports')}><Icon name="chart" />Full report</button>
              </div>
              {s.gross
                ? <TrendChart rows={report.daily} series={[{ key: 'tickets', label: 'Tickets' }, { key: 'menu', label: 'Food & drinks' }]} format={compact(true)} height={200} label="Daily sales" />
                : <Empty icon="chart" title="No sales in this period" body="Paid bookings and orders show here as a daily trend." />}
            </section>

            <section className="card">
              <div className="card-head"><div><h2>How guests paid</h2><p>Cash at the venue and each Afropay wallet</p></div></div>
              {report.payments.length
                ? <Donut parts={report.payments.map(p => ({ label: p.method, value: p.amount }))} format={money} center={compact(true)(s.gross)} />
                : <p className="small">No payments in this period.</p>}
            </section>

            <section className="card">
              <div className="card-head"><div><h2>Tickets sold by event</h2><p>Sold of capacity</p></div><button onClick={() => go('Events')}>Events</button></div>
              {upcoming.length
                ? <Bars rows={upcoming.slice(0, 6)} value={e => soldFor(e.id)} max={Math.max(1, ...upcoming.slice(0, 6).map(e => e.capacity))} format={(v, e) => `${v}/${e.capacity}`} label={e => <><b>{e.name}</b><small>{shortDate(e.date)}</small></>} />
                : <Empty title="No upcoming events" body="Create an event to start selling tickets." action="Create event" onAction={() => go('Events', 'create')} />}
            </section>

            <section className="card">
              <div className="card-head"><div><h2>Best sellers</h2><p>Food & drinks, {periodName}</p></div><button onClick={() => go('Menu')}>Menu</button></div>
              {report.bestSellers.length
                ? <Bars rows={report.bestSellers.slice(0, 5)} value={r => r.qty} format={(v, r) => `${v} · ${money(r.revenue)}`} label={r => <><b>{r.name}</b><small>{r.category}</small></>} />
                : <p className="small">No food or drink orders in this period.</p>}
            </section>

            <section className="card">
              <div className="card-head"><div><h2>Busiest hours</h2><p>Orders and bookings by hour, {periodName}</p></div></div>
              {busyHours.length
                ? <Bars rows={busyHours} value={h => h.orders + h.bookings} format={v => String(v)} label={h => <b>{String(h.hour).padStart(2, '0')}:00</b>} />
                : <p className="small">Nothing yet in this period.</p>}
            </section>
          </div>
        </>
      )}

      {!canManage && role !== 'Gate' && (
        <section className="card dash-live">
          <div className="card-head"><div><h2>Live service</h2><p>{activeOrders ? `${activeOrders} order${activeOrders > 1 ? 's' : ''} in progress` : 'No orders in progress'}</p></div><button onClick={() => go('Orders')}>Orders</button></div>
          <div className="pipeline">
            {live.map(([status, count]) => (
              <button key={status} className={'pipe ' + status.toLowerCase()} onClick={() => go('Orders')}><strong>{count}</strong><span>{status}</span></button>
            ))}
          </div>
        </section>
      )}

      {!canManage && next && (
        <section className="card next-event">
          <span className="eyebrow accent">Next up</span>
          <b>{next.name}</b>
          <small>{dateTime(next.date)} · {next.venue}</small>
          <div className="meter" aria-label={`${soldFor(next.id)} of ${next.capacity} sold`}><span style={{ width: Math.min(100, (soldFor(next.id) / (next.capacity || 1)) * 100) + '%' }} /></div>
          <small>{soldFor(next.id)} of {next.capacity} sold · {state.bookings.filter(b => b.event === next.id).flatMap(b => b.tickets || []).filter(t => t.used).length} checked in</small>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2>Latest activity</h2>{role !== 'Gate' && <button onClick={() => go('Orders')}>View orders</button>}</div>
        {records.length ? (
          <div className="list">
            {records.slice(0, 6).map(r => (
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
