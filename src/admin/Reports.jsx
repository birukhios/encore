import React, { useMemo, useState } from 'react';
import { dateTime, shortDate } from '../shared/api';
import { Empty, ErrorText, Field, Icon } from '../shared/ui';
import { Bars, DataTable, Delta, Donut, Heatmap, Insights, Kpi, TrendChart, hourLabel, pct } from './charts';
import { PageActions } from './pages';
import { exportPdf } from './pdf';
import { buildReport, change, DAY_NAMES, downloadText, isoDay, paymentLabel, slug, toCsv } from './reportData';

const daysAgo = n => isoDay(new Date(Date.now() - n * 86400000));
export const PRESETS = [
  ['today', 'Today', () => [isoDay(new Date()), isoDay(new Date())]],
  ['7d', '7 days', () => [daysAgo(6), isoDay(new Date())]],
  ['30d', '30 days', () => [daysAgo(29), isoDay(new Date())]],
  ['90d', '90 days', () => [daysAgo(89), isoDay(new Date())]],
  ['all', 'All time', () => ['', '']],
];
export const TABS = ['Overview', 'Sales', 'Menu', 'Tables & tips', 'Guests', 'Timing'];

/** Compact axis labels: 12,500 → 12.5K (money in cents when `cents`). */
export const compact = (cents = true) => v => {
  const n = cents ? v / 100 : v;
  const short = (x, unit) => `${x.toFixed(x >= 10 ? 0 : 1).replace(/\.0$/, '')}${unit}`;
  return n >= 1e6 ? short(n / 1e6, 'M') : n >= 1e3 ? short(n / 1e3, 'K') : `${Math.round(n)}`;
};

export function periodLabel(from, to) {
  return from || to ? `${from ? shortDate(from + 'T00:00') : 'Start'} – ${to ? shortDate(to + 'T00:00') : 'Today'}` : 'All time';
}

/** Filter bar shared by organizer reports and the platform console. */
export function ReportFilters({ filters, setFilters, events, children }) {
  const { preset, from, to, eventId } = filters;
  const choose = id => {
    const [f, t] = PRESETS.find(p => p[0] === id)[2]();
    setFilters({ ...filters, preset: id, from: f, to: t });
  };
  return (
    <section className="card report-filters">
      <div className="segmented" role="group" aria-label="Period">
        {PRESETS.map(([id, label]) => <button key={id} aria-pressed={preset === id} className={preset === id ? 'active' : ''} onClick={() => choose(id)}>{label}</button>)}
      </div>
      <div className="report-filter-fields">
        <Field label="From" type="date" value={from} max={to || undefined} onChange={e => setFilters({ ...filters, from: e.target.value, preset: 'custom' })} />
        <Field label="To" type="date" value={to} min={from || undefined} onChange={e => setFilters({ ...filters, to: e.target.value, preset: 'custom' })} />
        {events && (
          <Field label="Event">
            <select value={eventId} onChange={e => setFilters({ ...filters, eventId: e.target.value })}>
              <option value="all">All events</option>
              {events.map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
            </select>
          </Field>
        )}
        {children}
      </div>
    </section>
  );
}

export function Suggestions({ items, limit = 8 }) {
  if (!items.length) return <p className="small">Suggestions appear once there are enough sales to analyse.</p>;
  return (
    <ol className="suggestions">
      {items.slice(0, limit).map((x, i) => (
        <li key={i} className={x.priority}>
          <div className="suggestion-top"><span className={'badge ' + (x.priority === 'high' ? 'danger' : 'neutral')}>{x.priority === 'high' ? 'High impact' : x.area}</span>{x.metric && <small>{x.metric}</small>}</div>
          <b>{x.title}</b>
          <p>{x.body}</p>
        </li>
      ))}
    </ol>
  );
}

export function LatestActivity({ records, money }) {
  if (!records.length) return <p className="small">No bookings or orders in this period.</p>;
  return (
    <div className="table-scroll">
      <table className="report-table">
        <thead><tr><th>When</th><th>Guest</th><th>Details</th><th>Payment</th><th className="num">Total</th></tr></thead>
        <tbody>
          {records.map(r => (
            <tr key={r.id || r.ref}>
              <td>{dateTime(r.created * 1000)}</td>
              <td><b>{r.name}</b><small>{r.ref}</small></td>
              <td>{r.qty ? `${r.qty} ticket${r.qty > 1 ? 's' : ''} · ${r.eventName}` : `${r.tableName || 'Counter pickup'} · ${r.items}`}</td>
              <td>{paymentLabel(r)}</td>
              <td className="num"><b>{money(r.total)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange, label = 'Report sections' }) {
  return (
    <div className="report-tabs" role="tablist" aria-label={label}>
      {tabs.map(t => <button key={t} role="tab" aria-selected={value === t} className={value === t ? 'active' : ''} onClick={() => onChange(t)}>{t}</button>)}
    </div>
  );
}

/** The analysis itself; `money` formats cents. Used by organizer Reports and platform Analytics. */
export function ReportBody({ report, money, tab }) {
  const s = report.summary;
  const p = report.previous?.summary;
  const d = key => (p ? change(s[key], p[key]) : null);
  const axis = compact(true);
  const busiestHours = report.byHour.filter(h => h.orders).sort((a, b) => b.orders - a.orders).slice(0, 8);
  const spark = key => (report.daily.length > 1 ? report.daily.map(r => r[key]) : null);
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map(i => report.byWeekday[i]);

  if (tab === 'Overview') return (
    <>
      <div className="kpis">
        <Kpi label="Gross sales" value={money(s.gross)} delta={d('gross')} hint={`${s.bookings + s.orders} paid transactions`} spark={spark('gross')} />
        <Kpi label="Net sales" value={money(s.net)} delta={d('net')} hint="Excludes VAT and tips" />
        <Kpi label="Tickets sold" value={s.ticketsSold} delta={d('ticketsSold')} hint={s.capacity ? `${pct(s.sellThrough)} of capacity` : 'No capacity data'} spark={spark('ticketsSold')} />
        <Kpi label="Check-in rate" value={pct(s.checkinRate)} delta={d('checkinRate')} hint={`${s.checkedIn} of ${s.ticketsSold} tickets used`} />
        <Kpi label="Food & drink sales" value={money(s.menuSales)} delta={d('menuSales')} hint={`${s.orders} orders · ${pct(s.menuShare)} of sales`} spark={spark('menu')} />
        <Kpi label="Average order" value={money(s.avgOrder)} delta={d('avgOrder')} hint={`${s.itemsPerOrder.toFixed(1)} items per order`} />
        <Kpi label="Tips" value={money(s.tips)} delta={d('tips')} hint={`${pct(s.tipParticipation)} of orders tipped`} />
        <Kpi label="Paying guests" value={s.guests} delta={d('guests')} hint={`${money(s.spendPerGuest)} per guest`} />
      </div>
      {!p && <p className="small muted compare-hint">Choose a date range, such as 30 days, to compare with the previous period.</p>}
      <section className="card">
        <div className="card-head"><div><h2>Sales trend</h2><p>Ticket and food & drink sales per day, before VAT and tips.</p></div></div>
        {report.daily.length > 1
          ? <TrendChart rows={report.daily} series={[{ key: 'tickets', label: 'Tickets' }, { key: 'menu', label: 'Food & drinks' }]} format={axis} label="Daily sales" />
          : <p className="small">Sales on more than one day are needed to draw a trend.</p>}
      </section>
      <section className="card">
        <div className="card-head"><div><h2>Suggestions to grow sales</h2><p>Based on this period's data, most important first.</p></div></div>
        <Suggestions items={report.suggestions} />
      </section>
      <div className="report-grid">
        <section className="card">
          <div className="card-head"><h2>Key findings</h2></div>
          {report.insights.length ? <Insights items={report.insights} /> : <p className="small">More sales are needed before patterns stand out.</p>}
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Where the money comes from</h2><p>Gross sales broken down.</p></div></div>
          <Donut parts={[{ label: 'Tickets', value: s.ticketSales }, { label: 'Food & drinks', value: s.menuSales }, { label: 'Service charge', value: s.service }, { label: 'VAT', value: s.vat }, { label: 'Tips', value: s.tips }].filter(x => x.label !== 'Service charge' || x.value)} format={money} />
        </section>
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Latest activity</h2><p>The 10 most recent bookings and orders in this period.</p></div></div>
        <LatestActivity records={report.latest} money={money} />
      </section>
    </>
  );

  if (tab === 'Sales') return (
    <>
      <div className="kpis">
        <Kpi label="Ticket sales" value={money(s.ticketSales)} delta={d('ticketSales')} hint={`${money(s.avgTicketPrice)} average ticket`} />
        <Kpi label="Sell-through" value={pct(s.sellThrough)} delta={d('sellThrough')} hint={`${s.ticketsSold} of ${s.capacity} seats`} />
        <Kpi label="Average booking" value={`${s.avgBookingSize.toFixed(1)} tickets`} delta={d('avgBookingSize')} hint={`${s.bookings} bookings`} />
        <Kpi label="VAT collected" value={money(s.vat)} delta={d('vat')} hint="Payable to the tax authority" />
        <Kpi label="Cancelled" value={s.cancelled} delta={d('cancelled')} invert hint={`${s.unpaid} unpaid`} />
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Event performance</h2><p>Sort by any column. Per-guest figures use checked-in guests.</p></div></div>
        <DataTable rank sort={{ key: 'gross', dir: 'desc' }} rows={report.byEvent} columns={[
          { key: 'name', label: 'Event', render: e => <><b>{e.name}</b><small>{shortDate(e.date)}</small></> },
          { key: 'ticketsSold', label: 'Sold', num: true, render: e => `${e.ticketsSold}/${e.capacity}` },
          { key: 'sellThrough', label: 'Sell-through', num: true, render: e => pct(e.sellThrough) },
          { key: 'noShowRate', label: 'No-show', num: true, render: e => (e.ticketsSold ? pct(e.noShowRate) : '—') },
          { key: 'ticketSales', label: 'Tickets', num: true, render: e => money(e.ticketSales) },
          { key: 'menuSales', label: 'F&B', num: true, render: e => money(e.menuSales) },
          { key: 'fnbPerAttendee', label: 'F&B / guest', num: true, render: e => money(e.fnbPerAttendee) },
          { key: 'vat', label: 'VAT', num: true, render: e => money(e.vat) },
          { key: 'gross', label: 'Gross', num: true, render: e => <b>{money(e.gross)}</b> },
        ]} />
      </section>
      <div className="report-grid">
        <section className="card">
          <div className="card-head"><h2>Payment methods</h2></div>
          <Donut parts={report.payments.map(x => ({ label: x.method, value: x.amount }))} format={money} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Sales by weekday</h2></div>
          <Bars rows={weekdays} value={r => r.gross} format={v => money(v)} label={r => <><b>{r.day}</b><small>{r.bookings} bookings · {r.orders} orders</small></>} />
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2>Daily breakdown</h2></div>
        <DataTable limit={14} sort={{ key: 'date', dir: 'desc' }} rows={report.daily.filter(r => r.gross)} columns={[
          { key: 'date', label: 'Date', render: r => shortDate(r.date + 'T00:00') },
          { key: 'ticketsSold', label: 'Tickets', num: true },
          { key: 'orders', label: 'Orders', num: true },
          { key: 'tickets', label: 'Ticket sales', num: true, render: r => money(r.tickets) },
          { key: 'menu', label: 'F&B sales', num: true, render: r => money(r.menu) },
          { key: 'tips', label: 'Tips', num: true, render: r => money(r.tips) },
          { key: 'vat', label: 'VAT', num: true, render: r => money(r.vat) },
          { key: 'gross', label: 'Gross', num: true, render: r => <b>{money(r.gross)}</b> },
        ]} />
      </section>
    </>
  );

  if (tab === 'Menu') return (
    <>
      <div className="kpis">
        <Kpi label="Food & drink sales" value={money(s.menuSales)} delta={d('menuSales')} />
        <Kpi label="Items sold" value={s.itemsSold} delta={d('itemsSold')} hint={`${s.itemsPerOrder.toFixed(1)} per order`} />
        <Kpi label="F&B per guest" value={money(s.fnbPerAttendee)} delta={d('fnbPerAttendee')} hint="Per checked-in guest" />
        <Kpi label="Attach rate" value={pct(s.attachRate)} delta={d('attachRate')} hint="Ticket holders who ordered" />
        <Kpi label="Revenue concentration" value={pct(report.pareto.share)} hint={`From the top ${report.pareto.items} item${report.pareto.items === 1 ? '' : 's'}`} />
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Best-selling items</h2><p>Attach: share of orders with the item. Share: of food & drink revenue.</p></div></div>
        <DataTable rank sort={{ key: 'qty', dir: 'desc' }} rows={report.bestSellers} columns={[
          { key: 'name', label: 'Item', render: i => <><b>{i.name}</b><small>{i.category}</small></> },
          { key: 'qty', label: 'Qty', num: true },
          { key: 'orders', label: 'Orders', num: true },
          { key: 'attach', label: 'Attach', num: true, render: i => pct(i.attach) },
          { key: 'revenue', label: 'Revenue', num: true, render: i => money(i.revenue) },
          { key: 'share', label: 'Share', num: true, render: i => pct(i.share, 1) },
        ]} empty="No food or drink orders in this period." />
      </section>
      <div className="report-grid">
        <section className="card">
          <div className="card-head"><h2>Category mix</h2></div>
          {report.categories.length ? <Donut parts={report.categories.map(c => ({ label: c.category, value: c.revenue }))} format={money} /> : <p className="small">No categories sold yet.</p>}
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Slow movers</h2><p>Available items with the fewest sales.</p></div></div>
          {report.slowMovers.length ? (
            <ul className="plain-list">
              {report.slowMovers.map(i => <li key={i.name}><span><b>{i.name}</b><small>{i.category} · {money(i.price)}</small></span><span className={'badge ' + (i.qty ? 'neutral' : 'warning')}>{i.qty ? `${i.qty} sold` : 'No sales'}</span></li>)}
            </ul>
          ) : <p className="small">No available menu items.</p>}
        </section>
      </div>
    </>
  );

  if (tab === 'Tables & tips') return (
    <>
      <div className="kpis">
        <Kpi label="Tips" value={money(s.tips)} delta={d('tips')} />
        <Kpi label="Tip rate" value={pct(s.tipRate, 1)} delta={d('tipRate')} hint="Tips ÷ food & drink sales" />
        <Kpi label="Orders with a tip" value={pct(s.tipParticipation)} delta={d('tipParticipation')} />
        <Kpi label="Average tip" value={money(s.avgTip)} delta={d('avgTip')} hint="When a tip was given" />
        {s.service > 0 && <Kpi label="Service charge" value={money(s.service)} delta={d('service')} hint="Included in gross and net sales" />}
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Tips by waiter</h2><p>Credited when guests or staff enter a waiter number.{s.service ? ` Service charge collected: ${money(s.service)}.` : ''}</p></div></div>
        <DataTable rank sort={{ key: 'tips', dir: 'desc' }} rows={report.byWaiter} empty="No food & drink orders in this period." columns={[
          { key: 'name', label: 'Waiter', render: w => <><b>{w.number ? `#${w.number} · ` : ''}{w.name}</b></> },
          { key: 'orders', label: 'Orders', num: true },
          { key: 'tipped', label: 'Tipped', num: true, render: w => `${w.tipped}/${w.orders}` },
          { key: 'avgTip', label: 'Avg tip', num: true, render: w => money(w.avgTip) },
          { key: 'sales', label: 'F&B sales', num: true, render: w => money(w.sales) },
          { key: 'service', label: 'Service charge', num: true, render: w => money(w.service) },
          { key: 'tips', label: 'Tips', num: true, render: w => <b>{money(w.tips)}</b> },
        ]} />
      </section>
      <section className="card">
        <div className="card-head"><div><h2>Top tipped tables</h2><p>Where guests tip the most. Useful for recognizing service staff.</p></div></div>
        <DataTable rank sort={{ key: 'tips', dir: 'desc' }} rows={report.topTipped} columns={[
          { key: 'name', label: 'Table', render: t => <><b>{t.name}</b><small>{t.event}</small></> },
          { key: 'tips', label: 'Tips', num: true, render: t => <b>{money(t.tips)}</b> },
          { key: 'tippedOrders', label: 'Tipped orders', num: true, render: t => `${t.tippedOrders}/${t.orders}` },
          { key: 'avgTip', label: 'Avg tip', num: true, render: t => money(t.avgTip) },
          { key: 'tipRate', label: 'Tip rate', num: true, render: t => pct(t.tipRate, 1) },
          { key: 'revenue', label: 'Revenue', num: true, render: t => money(t.revenue) },
        ]} empty="No tips in this period." />
      </section>
      <section className="card">
        <div className="card-head"><div><h2>Busiest tables</h2><p>By number of paid orders.</p></div></div>
        <DataTable rank sort={{ key: 'orders', dir: 'desc' }} rows={report.busyTables} columns={[
          { key: 'name', label: 'Table', render: t => <><b>{t.name}</b><small>{t.event}</small></> },
          { key: 'orders', label: 'Orders', num: true },
          { key: 'items', label: 'Items', num: true },
          { key: 'avgOrder', label: 'Avg order', num: true, render: t => money(t.avgOrder) },
          { key: 'tips', label: 'Tips', num: true, render: t => money(t.tips) },
          { key: 'revenue', label: 'Revenue', num: true, render: t => <b>{money(t.revenue)}</b> },
        ]} empty="No table orders in this period." />
      </section>
    </>
  );

  if (tab === 'Guests') return (
    <>
      <div className="kpis">
        <Kpi label="Paying guests" value={s.guests} delta={d('guests')} />
        <Kpi label="Returning guests" value={pct(report.guests.repeatRate)} hint={`${report.guests.repeat} came back`} />
        <Kpi label="Spend per guest" value={money(s.spendPerGuest)} delta={d('spendPerGuest')} />
        <Kpi label="Top 10 guests" value={pct(report.guests.top10Share)} hint="Share of gross sales" />
      </div>
      <div className="report-grid">
        <section className="card">
          <div className="card-head"><div><h2>Guest segments</h2><p>What each guest paid for.</p></div></div>
          <Donut parts={[{ label: 'Tickets and food & drinks', value: report.guests.both }, { label: 'Tickets only', value: report.guests.ticketOnly }, { label: 'Food & drinks only', value: report.guests.orderOnly }]} center={String(report.guests.unique)} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Guest behaviour</h2></div>
          <ul className="plain-list">
            <li><span>Attach rate</span><b>{pct(s.attachRate)}</b></li>
            <li><span>Average booking size</span><b>{s.avgBookingSize.toFixed(1)} tickets</b></li>
            <li><span>Check-in rate</span><b>{pct(s.checkinRate)}</b></li>
            <li><span>Orders with a tip</span><b>{pct(s.tipParticipation)}</b></li>
          </ul>
        </section>
      </div>
      <section className="card">
        <div className="card-head"><div><h2>Top guests</h2><p>By total spent in this period.</p></div></div>
        <DataTable rank sort={{ key: 'spent', dir: 'desc' }} rows={report.topGuests} columns={[
          { key: 'name', label: 'Guest', render: g => <><b>{g.name}</b><small>{g.phone}</small></> },
          { key: 'events', label: 'Events', num: true },
          { key: 'tickets', label: 'Tickets', num: true },
          { key: 'orders', label: 'Orders', num: true },
          { key: 'tips', label: 'Tips', num: true, render: g => money(g.tips) },
          { key: 'last', label: 'Last purchase', num: true, render: g => shortDate(g.last * 1000) },
          { key: 'spent', label: 'Spent', num: true, render: g => <b>{money(g.spent)}</b> },
        ]} />
      </section>
    </>
  );

  return (
    <>
      <section className="card">
        <div className="card-head"><div><h2>When guests order</h2><p>Paid food & drink orders by weekday and hour.</p></div></div>
        <Heatmap grid={report.heatmap} />
      </section>
      <div className="report-grid">
        <section className="card">
          <div className="card-head"><h2>Busiest hours</h2></div>
          {busiestHours.length ? <Bars rows={busiestHours} value={r => r.orders} format={(v, r) => `${v} · ${money(r.revenue)}`} label={r => <b>{hourLabel(r.hour)}</b>} /> : <p className="small">No orders in this period.</p>}
        </section>
        <section className="card">
          <div className="card-head"><h2>Busiest weekdays</h2></div>
          <Bars rows={weekdays} value={r => r.orders + r.bookings} label={r => <><b>{r.day}</b><small>{r.bookings} bookings · {r.orders} orders</small></>} />
        </section>
      </div>
    </>
  );
}

/** PDF sections for a full report. */
export function reportPdfSections(report, money, { taxNote = '' } = {}) {
  const s = report.summary;
  const p = report.previous?.summary;
  const vs = key => {
    const c = p ? change(s[key], p[key]) : null;
    return c === null ? '' : `${c >= 0 ? '+' : '-'}${pct(Math.abs(c))} vs previous period`;
  };
  const right = (...cols) => Object.fromEntries(cols.map(c => [c, 'right']));
  return [
    { title: 'Summary', kpis: [
      ['Gross sales', money(s.gross), vs('gross')], ['Net sales (excl. VAT & tips)', money(s.net), vs('net')], ['VAT collected', money(s.vat), vs('vat')],
      ['Tickets sold', s.ticketsSold, `${pct(s.sellThrough)} sell-through`], ['Check-in rate', pct(s.checkinRate), `${s.checkedIn} checked in`], ['Ticket sales', money(s.ticketSales), vs('ticketSales')],
      ['Food & drink sales', money(s.menuSales), vs('menuSales')], ['Average order', money(s.avgOrder), `${s.itemsPerOrder.toFixed(1)} items per order`], ['Attach rate', pct(s.attachRate), 'Ticket holders who ordered'],
      ['Tips', money(s.tips), `${pct(s.tipParticipation)} of orders tipped`], ['Paying guests', s.guests, `${pct(report.guests.repeatRate)} returning`], ['Spend per guest', money(s.spendPerGuest), vs('spendPerGuest')],
    ] },
    ...(report.suggestions.length ? [{ title: 'Suggestions to grow sales', table: { head: ['#', 'Priority', 'Suggestion', 'Why'], body: report.suggestions.map((x, n) => [n + 1, x.priority === 'high' ? 'High' : 'Medium', x.title, `${x.body}${x.metric ? ` (${x.metric})` : ''}`]) } }] : []),
    ...(report.insights.length ? [{ title: 'Key findings', table: { head: ['Finding', 'Detail'], body: report.insights.map(i => [i.title, i.body]) } }] : []),
    { title: 'Event performance', table: { head: ['Event', 'Sold', 'Sell-through', 'No-show', 'Ticket sales', 'F&B sales', 'VAT', 'Gross'], body: report.byEvent.map(e => [`${e.name}\n${shortDate(e.date)}`, `${e.ticketsSold}/${e.capacity}`, pct(e.sellThrough), e.ticketsSold ? pct(e.noShowRate) : '—', money(e.ticketSales), money(e.menuSales), money(e.vat), money(e.gross)]), align: right(1, 2, 3, 4, 5, 6, 7) } },
    { title: 'Best-selling items', table: { head: ['#', 'Item', 'Category', 'Qty', 'Attach', 'Revenue', 'Share'], body: report.bestSellers.slice(0, 25).map((i, n) => [n + 1, i.name, i.category, i.qty, pct(i.attach), money(i.revenue), pct(i.share, 1)]), align: right(3, 4, 5, 6) } },
    { title: 'Category mix', table: { head: ['Category', 'Items', 'Qty', 'Revenue', 'Share'], body: report.categories.map(c => [c.category, c.items, c.qty, money(c.revenue), pct(c.share, 1)]), align: right(1, 2, 3, 4) } },
    { title: 'Slow movers', table: { head: ['Item', 'Category', 'Price', 'Sold'], body: report.slowMovers.map(i => [i.name, i.category, money(i.price), i.qty]), align: right(2, 3) } },
    { title: 'Tips by waiter', table: { head: ['#', 'Waiter', 'Orders', 'Tipped', 'Avg tip', 'Service charge', 'Tips'], body: report.byWaiter.map((w, n) => [n + 1, `${w.number ? `#${w.number} ` : ''}${w.name}`, w.orders, `${w.tipped}/${w.orders}`, money(w.avgTip), money(w.service), money(w.tips)]), align: right(2, 3, 4, 5, 6) } },
    { title: 'Top tipped tables', table: { head: ['#', 'Table', 'Event', 'Tips', 'Tipped orders', 'Avg tip', 'Tip rate'], body: report.topTipped.slice(0, 20).map((t, n) => [n + 1, t.name, t.event, money(t.tips), `${t.tippedOrders}/${t.orders}`, money(t.avgTip), pct(t.tipRate, 1)]), align: right(3, 4, 5, 6) } },
    { title: 'Busiest tables', table: { head: ['#', 'Table', 'Event', 'Orders', 'Items', 'Avg order', 'Revenue'], body: report.busyTables.slice(0, 20).map((t, n) => [n + 1, t.name, t.event, t.orders, t.items, money(t.avgOrder), money(t.revenue)]), align: right(3, 4, 5, 6) } },
    { title: 'Top guests', table: { head: ['#', 'Guest', 'Phone', 'Events', 'Tickets', 'Orders', 'Spent'], body: report.topGuests.slice(0, 20).map((g, n) => [n + 1, g.name, g.phone || '', g.events, g.tickets, g.orders, money(g.spent)]), align: right(3, 4, 5, 6) } },
    { title: 'Busiest hours', table: { head: ['Hour', 'Orders', 'Revenue'], body: report.byHour.filter(h => h.orders).sort((a, b) => b.orders - a.orders).slice(0, 10).map(h => [hourLabel(h.hour), h.orders, money(h.revenue)]), align: right(1, 2) } },
    { title: 'Payment methods', table: { head: ['Method', 'Transactions', 'Amount', 'Share'], body: report.payments.map(x => [x.method, x.count, money(x.amount), pct(x.share)]), align: right(1, 2, 3) } },
    { title: 'Latest activity', table: { head: ['When', 'Guest', 'Reference', 'Details', 'Payment', 'Total'], body: report.latest.map(x => [dateTime(x.created * 1000), x.name, x.ref, x.qty ? `${x.qty} ticket(s) · ${x.eventName}` : `${x.tableName || 'Counter'} · ${x.items}`, paymentLabel(x), money(x.total)]), align: right(5) } },
    { title: 'Daily sales', table: { head: ['Date', 'Tickets', 'Orders', 'Ticket sales', 'F&B sales', 'Tips', 'VAT', 'Gross'], body: report.daily.filter(r => r.gross).map(r => [r.date, r.ticketsSold, r.orders, money(r.tickets), money(r.menu), money(r.tips), money(r.vat), money(r.gross)]), align: right(1, 2, 3, 4, 5, 6, 7) } },
    { title: 'Notes', note: `Sales include paid, non-cancelled bookings and orders only. Net sales exclude VAT and tips; service charge is included. Attach rate is the share of ticket holders who also ordered food or drinks at the same event. Comparisons use the period of equal length immediately before.${taxNote} Encore reports are not fiscal receipts.` },
  ];
}

export function reportCsvRows(report, money, header) {
  const s = report.summary;
  const metrics = [['Gross sales', 'gross', money], ['Net sales', 'net', money], ['VAT', 'vat', money], ['Ticket sales', 'ticketSales', money], ['Food & drink sales', 'menuSales', money], ['Tips', 'tips', money], ['Service charge', 'service', money],
    ['Tickets sold', 'ticketsSold'], ['Checked in', 'checkedIn'], ['Check-in rate', 'checkinRate', pct], ['Sell-through', 'sellThrough', pct], ['Bookings', 'bookings'], ['Orders', 'orders'],
    ['Items sold', 'itemsSold'], ['Average order', 'avgOrder', money], ['Average tip', 'avgTip', money], ['Tip rate', 'tipRate', pct], ['Orders with a tip', 'tipParticipation', pct],
    ['Paying guests', 'guests'], ['Spend per guest', 'spendPerGuest', money], ['Attach rate', 'attachRate', pct], ['Cancelled', 'cancelled'], ['Unpaid', 'unpaid']];
  return [
    ...header, [],
    ['Summary'], ['Metric', 'This period', 'Previous period', 'Change'],
    ...metrics.map(([label, key, f = v => v]) => {
      const before = report.previous?.summary[key];
      const c = report.previous ? change(s[key], before) : null;
      return [label, f(s[key]), report.previous ? f(before) : '', c === null ? '' : pct(c, 1)];
    }),
    [], ['Suggestions to grow sales'], ['Priority', 'Area', 'Suggestion', 'Why', 'Metric'], ...report.suggestions.map(x => [x.priority, x.area, x.title, x.body, x.metric]),
    [], ['Key findings'], ...report.insights.map(i => [i.title, i.body]),
    [], ['Latest activity'], ['When', 'Guest', 'Reference', 'Details', 'Payment', 'Total'], ...report.latest.map(x => [new Date(x.created * 1000).toISOString(), x.name, x.ref, x.qty ? `${x.qty} ticket(s) · ${x.eventName}` : `${x.tableName || 'Counter'} · ${x.items}`, paymentLabel(x), money(x.total)]),
    [], ['Event performance'], ['Event', 'Date', 'Capacity', 'Tickets sold', 'Sell-through', 'Checked in', 'No-show rate', 'Ticket sales', 'Orders', 'F&B sales', 'F&B per guest', 'Tips', 'VAT', 'Gross'],
    ...report.byEvent.map(e => [e.name, e.date, e.capacity, e.ticketsSold, pct(e.sellThrough), e.checkedIn, pct(e.noShowRate), money(e.ticketSales), e.orders, money(e.menuSales), money(e.fnbPerAttendee), money(e.tips), money(e.vat), money(e.gross)]),
    [], ['Menu items'], ['Item', 'Category', 'Price', 'Quantity', 'Orders', 'Attach rate', 'Revenue', 'Revenue share'],
    ...[...report.bestSellers, ...report.slowMovers.filter(i => !i.qty)].map(i => [i.name, i.category, money(i.price || 0), i.qty, i.orders, pct(i.attach), money(i.revenue), pct(i.share, 1)]),
    [], ['Categories'], ['Category', 'Items sold', 'Quantity', 'Revenue', 'Share'], ...report.categories.map(c => [c.category, c.items, c.qty, money(c.revenue), pct(c.share, 1)]),
    [], ['Tips by waiter'], ['Waiter number', 'Waiter', 'Orders', 'Orders with a tip', 'Average tip', 'F&B sales', 'Service charge', 'Tips'],
    ...report.byWaiter.map(w => [w.number, w.name, w.orders, w.tipped, money(w.avgTip), money(w.sales), money(w.service), money(w.tips)]),
    [], ['Tables'], ['Table', 'Event', 'Orders', 'Items', 'Average order', 'Tips', 'Tipped orders', 'Average tip', 'Tip rate', 'Revenue'],
    ...report.busyTables.map(t => [t.name, t.event, t.orders, t.items, money(t.avgOrder), money(t.tips), t.tippedOrders, money(t.avgTip), pct(t.tipRate, 1), money(t.revenue)]),
    [], ['Guests'], ['Guest', 'Phone', 'Events', 'Bookings', 'Tickets', 'Orders', 'Tips', 'Spent', 'First purchase', 'Last purchase'],
    ...report.topGuests.map(g => [g.name, g.phone, g.events, g.bookings, g.tickets, g.orders, money(g.tips), money(g.spent), isoDay(new Date(g.first * 1000)), isoDay(new Date(g.last * 1000))]),
    [], ['Orders by weekday and hour'], ['Day', ...Array.from({ length: 24 }, (_, h) => `${h}:00`)], ...[1, 2, 3, 4, 5, 6, 0].map(dd => [DAY_NAMES[dd], ...report.heatmap[dd]]),
    [], ['Payment methods'], ['Method', 'Transactions', 'Amount', 'Share'], ...report.payments.map(x => [x.method, x.count, money(x.amount), pct(x.share)]),
    [], ['Daily sales'], ['Date', 'Tickets sold', 'Orders', 'Ticket sales', 'F&B sales', 'Tips', 'VAT', 'Gross'], ...report.daily.map(r => [r.date, r.ticketsSold, r.orders, money(r.tickets), money(r.menu), money(r.tips), money(r.vat), money(r.gross)]),
  ];
}

export const defaultFilters = () => ({ preset: '30d', from: daysAgo(29), to: isoDay(new Date()), eventId: 'all' });

export default function Reports({ ctx }) {
  const { state, money } = ctx;
  const [filters, setFilters] = useState(defaultFilters);
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const report = useMemo(() => buildReport(state, filters), [state, filters]);
  const s = report.summary;
  const eventName = filters.eventId === 'all' ? 'All events' : state.events.find(e => e.id === filters.eventId)?.name;
  const period = periodLabel(filters.from, filters.to);
  const taxNote = state.settings.tax.tin ? ` VAT follows your VAT settings (TIN ${state.settings.tax.tin}).` : '';

  function exportCsv() {
    const rows = reportCsvRows(report, money, [[`${state.name} — Encore analytics report`], ['Period', period], ['Event', eventName], ['Currency', state.currency], ['Generated', new Date().toLocaleString()]]);
    downloadText(`${slug(state.name)}-report-${isoDay(new Date())}.csv`, toCsv(rows));
  }

  async function exportReportPdf() {
    setBusy(true);
    setError('');
    try {
      await exportPdf({
        filename: `${slug(state.name)}-report-${isoDay(new Date())}.pdf`,
        title: 'Sales & operations report',
        subtitle: `${period} · ${eventName} · ${state.currency}${report.previous ? ` · Compared with ${periodLabel(report.previous.from, report.previous.to)}` : ''}`,
        organization: state.name,
        logo: state.settings.theme.logo,
        sections: reportPdfSections(report, money, { taxNote }),
      });
    } catch (e) {
      setError('The PDF could not be created: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  const hasData = s.bookings + s.orders > 0;
  return (
    <>
      <PageActions>
        <button onClick={exportCsv} disabled={!hasData}><Icon name="download" />CSV</button>
        <button className="primary" onClick={exportReportPdf} disabled={!hasData || busy}><Icon name="download" />{busy ? 'Preparing PDF…' : 'Export PDF'}</button>
      </PageActions>
      <ReportFilters filters={filters} setFilters={setFilters} events={state.events} />
      <ErrorText>{error}</ErrorText>
      <div className="report-context">
        <span><b>{period}</b> · {eventName}</span>
        {report.previous && <span className="muted small">Gross sales vs {periodLabel(report.previous.from, report.previous.to)} <Delta value={change(s.gross, report.previous.summary.gross)} /></span>}
      </div>
      {!hasData ? (
        <section className="card"><Empty icon="chart" title="No sales in this period" body="Paid bookings and orders will appear here. Try a wider date range or another event." /></section>
      ) : (
        <>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          <div role="tabpanel" aria-label={tab} className="report-panel">
            <ReportBody report={report} money={money} tab={tab} />
          </div>
        </>
      )}
    </>
  );
}
