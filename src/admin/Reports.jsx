import React, { useMemo, useState } from 'react';
import { shortDate } from '../shared/api';
import { Empty, ErrorText, Field, Icon } from '../shared/ui';
import { PageActions } from './pages';
import { exportPdf } from './pdf';
import { buildReport, downloadText, slug, toCsv } from './reportData';

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => iso(new Date(Date.now() - n * 86400000));
const PRESETS = [['7d', 'Last 7 days', () => [daysAgo(6), iso(new Date())]], ['30d', 'Last 30 days', () => [daysAgo(29), iso(new Date())]], ['all', 'All time', () => ['', '']]];
const pct = n => `${Math.round(n * 100)}%`;
const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

function Bars({ rows, value, label, money, max }) {
  const top = max ?? Math.max(1, ...rows.map(value));
  return (
    <div className="bars" role="list">
      {rows.map((r, i) => (
        <div className="bar-row" role="listitem" key={i}>
          <span className="bar-label">{label(r)}</span>
          <span className="bar-track" aria-hidden="true"><span style={{ width: `${(value(r) / top) * 100}%` }} /></span>
          <b className="bar-value">{money ? money(value(r)) : value(r)}</b>
        </div>
      ))}
    </div>
  );
}

export default function Reports({ ctx }) {
  const { state, money } = ctx;
  const [preset, setPreset] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [eventId, setEventId] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const report = useMemo(() => buildReport(state, { from, to, eventId }), [state, from, to, eventId]);
  const s = report.summary;
  const eventName = eventId === 'all' ? 'All events' : state.events.find(e => e.id === eventId)?.name;
  const period = from || to ? `${from ? shortDate(from + 'T00:00') : 'Start'} – ${to ? shortDate(to + 'T00:00') : 'Today'}` : 'All time';
  const busiestHours = report.byHour.filter(h => h.orders).sort((a, b) => b.orders - a.orders).slice(0, 6).sort((a, b) => a.hour - b.hour);

  const choosePreset = id => {
    setPreset(id);
    const [f, t] = PRESETS.find(p => p[0] === id)[2]();
    setFrom(f);
    setTo(t);
  };

  const kpis = [
    ['Gross sales', money(s.gross)], ['Net sales (excl. VAT & tips)', money(s.net)], ['VAT collected', money(s.vat)],
    ['Ticket sales', money(s.ticketSales)], ['Tickets sold', s.ticketsSold], ['Check-in rate', pct(s.checkinRate)],
    ['Food & drink sales', money(s.menuSales)], ['Orders', s.orders], ['Average order', money(s.avgOrder)],
    ['Tips', money(s.tips)], ['Bookings', s.bookings], ['Cancelled / unpaid', s.refundsOrCancelled],
  ];

  function exportCsv() {
    const rows = [
      [`${state.name} — Encore report`], ['Period', period], ['Event', eventName], [],
      ['Summary'], ...kpis.map(([k, v]) => [k, v]), [],
      ['Sales by event'], ['Event', 'Date', 'Tickets sold', 'Checked in', 'Ticket sales', 'Orders', 'Food & drink sales', 'Tips', 'VAT', 'Gross'],
      ...report.byEvent.map(e => [e.name, shortDate(e.date), e.ticketsSold, e.checkedIn, money(e.ticketSales), e.orders, money(e.menuSales), money(e.tips), money(e.vat), money(e.gross)]), [],
      ['Best-selling items'], ['Item', 'Category', 'Quantity', 'Orders', 'Revenue'],
      ...report.bestSellers.map(i => [i.name, i.category, i.qty, i.orders, money(i.revenue)]), [],
      ['Busiest tables'], ['Table', 'Event', 'Orders', 'Items', 'Tips', 'Revenue'],
      ...report.busyTables.map(t => [t.name, t.event, t.orders, t.items, money(t.tips), money(t.revenue)]), [],
      ['Orders by hour'], ['Hour', 'Orders', 'Revenue'], ...report.byHour.filter(h => h.orders).map(h => [hourLabel(h.hour), h.orders, money(h.revenue)]), [],
      ['Payment methods'], ['Method', 'Transactions', 'Amount'], ...report.payments.map(p => [p.method, p.count, money(p.amount)]), [],
      ['Daily sales'], ['Date', 'Ticket sales', 'Food & drink sales', 'Gross'], ...report.daily.map(d => [d.date, money(d.tickets), money(d.menu), money(d.gross)]),
    ];
    downloadText(`${slug(state.name)}-report-${iso(new Date())}.csv`, toCsv(rows));
  }

  async function exportReportPdf() {
    setBusy(true);
    setError('');
    try {
      await exportPdf({
        filename: `${slug(state.name)}-report-${iso(new Date())}.pdf`,
        title: 'Sales & operations report',
        subtitle: `${period} · ${eventName} · Currency ${state.currency}`,
        organization: state.name,
        logo: state.settings.theme.logo,
        sections: [
          { title: 'Summary', kpis },
          { title: 'Sales by event', table: { head: ['Event', 'Tickets', 'In', 'Ticket sales', 'Orders', 'F&B sales', 'VAT', 'Gross'], body: report.byEvent.map(e => [e.name, e.ticketsSold, e.checkedIn, money(e.ticketSales), e.orders, money(e.menuSales), money(e.vat), money(e.gross)]), align: { 1: 'right', 2: 'right', 3: 'right', 4: 'right', 5: 'right', 6: 'right', 7: 'right' } } },
          { title: 'Best-selling items', table: { head: ['#', 'Item', 'Category', 'Qty', 'Orders', 'Revenue'], body: report.bestSellers.slice(0, 20).map((i, n) => [n + 1, i.name, i.category, i.qty, i.orders, money(i.revenue)]), align: { 3: 'right', 4: 'right', 5: 'right' } } },
          { title: 'Busiest tables', table: { head: ['#', 'Table', 'Event', 'Orders', 'Items', 'Tips', 'Revenue'], body: report.busyTables.slice(0, 20).map((t, n) => [n + 1, t.name, t.event, t.orders, t.items, money(t.tips), money(t.revenue)]), align: { 3: 'right', 4: 'right', 5: 'right', 6: 'right' } } },
          { title: 'Busiest hours', table: { head: ['Hour', 'Orders', 'Revenue'], body: busiestHours.map(h => [hourLabel(h.hour), h.orders, money(h.revenue)]), align: { 1: 'right', 2: 'right' } } },
          { title: 'Payment methods', table: { head: ['Method', 'Transactions', 'Amount'], body: report.payments.map(p => [p.method, p.count, money(p.amount)]), align: { 1: 'right', 2: 'right' } } },
          { title: 'Notes', note: `Sales include paid, non-cancelled bookings and orders only. VAT is shown as calculated by Encore from your VAT settings${state.settings.tax.tin ? ` (TIN ${state.settings.tax.tin})` : ''}; Encore reports are not fiscal receipts. Tips are not taxed.` },
        ],
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
      <section className="card report-filters">
        <div className="segmented" role="tablist" aria-label="Period">
          {PRESETS.map(([id, label]) => <button key={id} role="tab" aria-selected={preset === id} className={preset === id ? 'active' : ''} onClick={() => choosePreset(id)}>{label}</button>)}
        </div>
        <div className="report-filter-fields">
          <Field label="From" type="date" value={from} max={to || undefined} onChange={e => { setFrom(e.target.value); setPreset('custom'); }} />
          <Field label="To" type="date" value={to} min={from || undefined} onChange={e => { setTo(e.target.value); setPreset('custom'); }} />
          <Field label="Event">
            <select value={eventId} onChange={e => setEventId(e.target.value)}>
              <option value="all">All events</option>
              {state.events.map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
            </select>
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
      </section>

      {!hasData ? (
        <section className="card"><Empty icon="chart" title="No sales in this period" body="Paid bookings and orders will appear here. Try a wider date range or another event." /></section>
      ) : (
        <>
          <div className="stats report-kpis">
            {kpis.map(([label, value]) => <article className="stat" key={label}><span className="muted small">{label}</span><strong>{value}</strong></article>)}
          </div>

          {report.daily.length > 1 && (
            <section className="card">
              <div className="card-head"><h2>Daily sales</h2><span className="muted small">{period}</span></div>
              <div className="daily-chart" role="img" aria-label="Daily gross sales">
                {report.daily.map(d => {
                  const top = Math.max(...report.daily.map(x => x.gross));
                  return (
                    <div className="daily-col" key={d.date} title={`${d.date}: ${money(d.gross)}`}>
                      <span className="daily-bar" style={{ height: `${Math.max(4, (d.gross / top) * 100)}%` }} />
                      <small>{new Date(d.date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head"><h2>Sales by event</h2></div>
            <div className="table-scroll">
              <table className="report-table">
                <thead><tr><th>Event</th><th className="num">Tickets</th><th className="num">Checked in</th><th className="num">Ticket sales</th><th className="num">Orders</th><th className="num">Food & drinks</th><th className="num">VAT</th><th className="num">Gross</th></tr></thead>
                <tbody>
                  {report.byEvent.map(e => (
                    <tr key={e.id}>
                      <td><b>{e.name}</b><small>{shortDate(e.date)} · {e.ticketsSold}/{e.capacity} sold</small></td>
                      <td className="num">{e.ticketsSold}</td><td className="num">{e.ticketsSold ? pct(e.checkedIn / e.ticketsSold) : '—'}</td>
                      <td className="num">{money(e.ticketSales)}</td><td className="num">{e.orders}</td><td className="num">{money(e.menuSales)}</td>
                      <td className="num">{money(e.vat)}</td><td className="num"><b>{money(e.gross)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid-2 report-grid">
            <section className="card">
              <div className="card-head"><h2>Best-selling items</h2><span className="muted small">By quantity</span></div>
              {report.bestSellers.length
                ? <Bars rows={report.bestSellers.slice(0, 10)} value={r => r.qty} label={r => <><b>{r.name}</b><small>{r.category} · {money(r.revenue)}</small></>} />
                : <p className="small">No food or drink orders in this period.</p>}
            </section>
            <section className="card">
              <div className="card-head"><h2>Busiest tables</h2><span className="muted small">By orders</span></div>
              {report.busyTables.length
                ? <Bars rows={report.busyTables.slice(0, 10)} value={r => r.orders} label={r => <><b>{r.name}</b><small>{r.event} · {r.items} items · {money(r.revenue)}</small></>} />
                : <p className="small">No table orders in this period.</p>}
            </section>
            <section className="card">
              <div className="card-head"><h2>Busiest hours</h2><span className="muted small">Orders placed</span></div>
              {busiestHours.length
                ? <Bars rows={busiestHours} value={r => r.orders} label={r => <b>{hourLabel(r.hour)}</b>} />
                : <p className="small">No orders in this period.</p>}
            </section>
            <section className="card">
              <div className="card-head"><h2>Payment methods</h2></div>
              <Bars rows={report.payments} value={r => r.amount} money={money} label={r => <><b>{r.method}</b><small>{r.count} transaction{r.count > 1 ? 's' : ''}</small></>} />
            </section>
          </div>
        </>
      )}
    </>
  );
}
