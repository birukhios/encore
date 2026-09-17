import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, dateTime, readFileAsBase64, shortDate } from '../shared/api';
import ImageUpload from '../shared/ImageUpload';
import { LogoMark } from '../shared/Logo';
import QR from '../shared/QR';
import { exportPdf } from './pdf';
import { Bars, DataTable, Kpi, TrendChart } from './charts';
import { compact, Suggestions } from './Reports';
import { NewOrder, PrintOrder } from './service';
import { buildReport, change, downloadText, guestHistory, paymentLabel, slug, toCsv, vatOf } from './reportData';
import Scanner from '../shared/Scanner';
import { Avatar, copyText, Empty, ErrorText, Field, Icon, Modal, StarIcon, Toggle } from '../shared/ui';

export function PageActions({ children }) {
  const [node, setNode] = useState(null);
  useEffect(() => setNode(document.getElementById('page-actions')), []);
  return node ? createPortal(children, node) : null;
}

/** Runs an async action, surfaces its error inline, and tracks busy state. */
function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

const paidBadge = r => r.status === 'Cancelled'
  ? <span className="badge neutral">Cancelled</span>
  : r.paid ? <span className="badge success">Paid · {r.settledBy}</span> : <span className="badge warning">Unpaid</span>;

// ---------------------------------------------------------------- Overview

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
          { title: 'Upcoming performances', table: { head: ['Date', 'Event', 'Venue', 'Sold', 'Sell-through', 'Status'], body: upcoming.map(e => [shortDate(e.date), e.name, e.venue, `${soldFor(e.id)}/${e.capacity}`, `${Math.round((soldFor(e.id) / (e.capacity || 1)) * 100)}%`, e.published ? 'Published' : 'Draft']), align: { 3: 'right', 4: 'right' } } },
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
                    <span className={'badge ' + (e.published ? 'success' : 'neutral')}>{e.published ? 'Published' : 'Draft'}</span>
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


// ---------------------------------------------------------------- Events

export function Events({ ctx }) {
  const { state, money, canManage, matches } = ctx;
  const [editing, setEditing] = useState(ctx.intent === 'create' && canManage ? {} : null);
  const events = [...state.events].sort((a, b) => a.date.localeCompare(b.date)).filter(e => matches(e.name, e.venue));
  return (
    <>
      {canManage && <PageActions><button className="primary" onClick={() => setEditing({})}><Icon name="add" />Add event</button></PageActions>}
      {events.length ? (
        <div className="cards">
          {events.map(e => {
            const sold = state.bookings.filter(b => b.event === e.id && b.status !== 'Cancelled').reduce((s, b) => s + b.qty, 0);
            return (
              <article className="eventcard" key={e.id}>
                {e.image ? <img className="cover" src={e.image} alt="" /> : <div className="cover placeholder"><LogoMark size={44} /></div>}
                <div className="eventbody">
                  <div className="row spread">
                    <span className={'badge ' + (e.published ? 'success' : 'neutral')}>{e.published ? 'Published' : 'Draft'}</span>
                    <small className="muted">{dateTime(e.date)}</small>
                  </div>
                  <h2>{e.name}</h2>
                  <p className="small">{e.venue}</p>
                  <p className="description">{e.description}</p>
                  <div className="meter" aria-label={`${sold} of ${e.capacity} reserved`}><span style={{ width: Math.min(100, (sold / e.capacity) * 100) + '%' }} /></div>
                  <div className="eventfoot">
                    <div className="price"><small>{sold}/{e.capacity} reserved</small><b>{e.price ? money(e.price) : 'Free'}</b></div>
                    {canManage && <button onClick={() => setEditing(e)}><Icon name="pencil" />Edit</button>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="card">
          <Empty title={ctx.search ? 'No matching events' : 'Your lineup starts here'} body={ctx.search ? 'Try a different search.' : 'Create a concert to start taking reservations.'} action={canManage && !ctx.search ? 'Add event' : null} onAction={() => setEditing({})} />
        </section>
      )}
      {editing && <EventForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EventForm({ ctx, item, onClose }) {
  const [image, setImage] = useState(item.image || '');
  const [published, setPublished] = useState(!!item.published);
  const { busy, error, run } = useRunner();
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    run(async () => { await ctx.action('event', { ...v, id: item.id, image, published }); onClose(); });
  };
  const remove = () => {
    if (!confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    run(async () => { await ctx.action('delete', { kind: 'event', id: item.id }); onClose(); });
  };
  return (
    <Modal title={item.id ? 'Edit event' : 'Create event'} eyebrow={ctx.state.name} onClose={onClose} wide
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="event-form" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</button>
      </>}>
      <form id="event-form" className="form" onSubmit={submit}>
        <ImageUpload value={image} onChange={setImage} />
        <Field label="Event name" name="name" defaultValue={item.name} maxLength={120} required />
        <div className="formrow">
          <Field label="Date & time" type="datetime-local" name="date" defaultValue={item.date} required />
          <Field label="Venue" name="venue" defaultValue={item.venue} maxLength={150} required />
        </div>
        <Field label="About this event"><textarea name="description" defaultValue={item.description} maxLength={1000} required /></Field>
        <div className="formrow">
          <Field label={`Ticket price (${ctx.state.currency})`} name="price" type="number" step="0.01" min="0" defaultValue={(item.price || 0) / 100} required hint="Use 0 for free entry." />
          <Field label="Capacity" name="capacity" type="number" min="1" max="100000" defaultValue={item.capacity || 200} required />
        </div>
        <Toggle label="Publish to guest app" description="Guests can see and reserve this event." checked={published} onChange={setPublished} />
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Bookings

export function Bookings({ ctx }) {
  const { state, money, canManage, role, matches } = ctx;
  const [filter, setFilter] = useState('Ready for entry');
  const [settling, setSettling] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [rowError, setRowError] = useState('');
  const filters = {
    'Ready for entry': b => b.status === 'Reserved' && b.paid,
    'Awaiting payment': b => b.status === 'Reserved' && !b.paid,
    'Checked in': b => b.status === 'Checked in',
    Cancelled: b => b.status === 'Cancelled',
    All: () => true,
  };
  const rows = [...state.bookings].reverse().filter(filters[filter]).filter(b => matches(b.name, b.ref, b.phone, b.eventName));
  const act = async (op, data) => {
    setRowError('');
    try { await ctx.action(op, data); } catch (e) { setRowError(e.message); }
  };
  return (
    <>
      <PageActions><button className="primary" onClick={() => setScanning(true)}><Icon name="ticket" />Scan ticket</button></PageActions>
      <section className="card">
        <div className="card-head">
          <div className="segmented" role="tablist" aria-label="Filter bookings">
            {Object.keys(filters).map(f => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f} <span className="muted">{state.bookings.filter(filters[f]).length}</span>
              </button>
            ))}
          </div>
        </div>
        <ErrorText>{rowError}</ErrorText>
        {rows.length ? rows.map(b => (
          <div className="recordrow" key={b.id}>
            <div className="row spread wrap">
              <div className="row">
                <span className="avatar">{b.name[0]}</span>
                <div><b>{b.name}</b><div className="meta"><span>{b.phone}</span><span>{b.ref}</span></div></div>
              </div>
              <div className="row wrap">{paidBadge(b)}<span className="badge neutral">{b.status}</span></div>
            </div>
            <div className="row spread wrap">
              <div className="meta">
                <span><b>{b.eventName}</b></span>
                <span>{b.qty} ticket{b.qty > 1 ? 's' : ''} · {b.tickets.filter(t => t.used).length} admitted</span>
                <span>{money(b.total)}</span>
                <span>Reserved {dateTime(b.created * 1000)}</span>
              </div>
              <div className="actions">
                {b.status === 'Reserved' && !b.paid && ['Owner', 'Admin'].includes(role) && <button onClick={() => confirm(`Cancel booking ${b.ref}?`) && act('cancel', { id: b.id })}>Cancel</button>}
                {b.status === 'Reserved' && b.paid && <button className="primary" onClick={() => act('checkin', { id: b.id })}>Check in {b.tickets.filter(t => !t.used).length > 1 ? 'all' : ''}</button>}
              </div>
            </div>
          </div>
        )) : <Empty icon="ticket" title="Nothing here yet" body="Tickets bought online appear here. Scan each ticket's QR code or type its reference number to check guests in." />}
      </section>
      {settling && <SettleModal ctx={ctx} record={settling} onClose={() => setSettling(null)} />}
      {scanning && <TicketScan ctx={ctx} onClose={() => setScanning(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- Check-ins

const clock = seconds => new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function CheckIns({ ctx }) {
  const { state } = ctx;
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [sort, setSort] = useState('recent');
  const [rowError, setRowError] = useState('');
  const [guest, setGuest] = useState(null);
  const events = [...state.events].sort((a, b) => a.date.localeCompare(b.date));
  const withTickets = events.filter(e => state.bookings.some(b => b.event === e.id && b.paid && b.status !== 'Cancelled'));
  const soon = withTickets.find(e => new Date(e.date) >= new Date(Date.now() - 12 * 3600 * 1000)) || withTickets[withTickets.length - 1];
  const [eventId, setEventId] = useState(soon ? soon.id : 'all');

  const tickets = state.bookings
    .filter(b => b.paid && b.status !== 'Cancelled' && (eventId === 'all' || b.event === eventId))
    .flatMap(b => b.tickets.map(t => ({ ...t, booking: b, key: b.id + ':' + t.serial })));
  const arrived = tickets.filter(t => t.used).length;
  const pct = tickets.length ? Math.round((arrived / tickets.length) * 100) : 0;
  const q = query.trim().toLowerCase().replace(/^en-/, '');
  const rows = tickets
    .filter(t => status === 'All' || (status === 'Checked in' ? t.used : !t.used))
    .filter(t => {
      if (!q) return true;
      if ([t.booking.name, t.booking.ref.replace(/^EN-/, '')].join(' ').toLowerCase().includes(q)) return true;
      const digits = q.replace(/\D/g, '').replace(/^(?:251|0)/, '');  // 0911…, 251911…, +251 911… all match
      return digits.length >= 3 && t.booking.phone.replace(/\D/g, '').includes(digits);
    })
    .sort((a, b) => sort === 'name' ? a.booking.name.localeCompare(b.booking.name) || a.serial - b.serial
      : sort === 'booked' ? b.booking.created - a.booking.created
      : (b.usedAt || 0) - (a.usedAt || 0) || a.booking.name.localeCompare(b.booking.name));

  const checkIn = async t => {
    setRowError('');
    try { await ctx.action('checkin_ticket', { code: `${t.booking.ref}:${t.serial}:${t.token}` }, { quiet: true }); ctx.toast(`${t.booking.name} checked in`); }
    catch (e) { setRowError(e.message); }
  };
  const exportCsv = () => {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Name', 'Phone', 'Reference', 'Ticket', 'Event', 'Status', 'Checked in at', 'Checked in by']]
      .concat(rows.map(t => [t.booking.name, t.booking.phone, t.booking.ref, `${t.serial} of ${t.booking.qty}`, t.booking.eventName,
        t.used ? 'Checked in' : 'Not arrived', t.usedAt ? new Date(t.usedAt * 1000).toISOString() : '', t.usedBy || '']));
    const url = URL.createObjectURL(new Blob([lines.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `check-ins-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageActions>
        <button onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export CSV</button>
        <button className="primary" onClick={() => setScanning(true)}><Icon name="ticket" />Scan ticket</button>
      </PageActions>
      <section className="card checkin-summary">
        <Field label="Event">
          <select value={eventId} onChange={e => setEventId(e.target.value)}>
            <option value="all">All events</option>
            {events.map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
          </select>
        </Field>
        <div className="checkin-stats">
          <div><strong>{tickets.length}</strong><small>Tickets sold</small></div>
          <div><strong className="ok">{arrived}</strong><small>Checked in</small></div>
          <div><strong>{tickets.length - arrived}</strong><small>Not arrived</small></div>
        </div>
        <div className="arrival" aria-label={`${pct}% arrived`}>
          <div className="meter"><span style={{ width: pct + '%' }} /></div>
          <b>{pct}%</b>
        </div>
      </section>
      <section className="card">
        <div className="checkin-toolbar">
          <label className="search checkin-search">
            <Icon name="search" />
            <input type="search" placeholder="Search name, phone or reference" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search checked-in guests" />
          </label>
          <div className="segmented" role="tablist" aria-label="Arrival status">
            {['All', 'Checked in', 'Not arrived'].map(f => (
              <button key={f} role="tab" aria-selected={status === f} className={status === f ? 'active' : ''} onClick={() => setStatus(f)}>
                {f} <span className="muted">{f === 'All' ? tickets.length : f === 'Checked in' ? arrived : tickets.length - arrived}</span>
              </button>
            ))}
          </div>
          <label className="checkin-sort">
            <span className="visually-hidden">Sort</span>
            <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort guests">
              <option value="recent">Latest check-in</option>
              <option value="name">Name A–Z</option>
              <option value="booked">Newest booking</option>
            </select>
          </label>
        </div>
        <ErrorText>{rowError}</ErrorText>
        {rows.length ? (
          <div className="checkin-list" role="list">
            {rows.map(t => (
              <div className="checkin-row" role="listitem" key={t.key}>
                <Avatar name={t.booking.name} size={38} />
                <button className="checkin-who" onClick={() => setGuest(t.booking)} aria-label={`Open ${t.booking.name}'s tickets, orders and payments`}>
                  <b>{t.booking.name}</b>
                  <small>{t.booking.phone} · {t.booking.ref} · Ticket {t.serial} of {t.booking.qty}</small>
                  {eventId === 'all' && <small>{t.booking.eventName}</small>}
                </button>
                <div className="checkin-when">
                  {t.used ? (
                    <>
                      <span className="badge success"><Icon name="check" size="sm" />Checked in</span>
                      <small>{clock(t.usedAt)}{t.usedBy ? ` · by ${t.usedBy}` : ''}</small>
                    </>
                  ) : (
                    <>
                      <span className="badge neutral">Not arrived</span>
                      <button className="primary" onClick={() => checkIn(t)}>Check in</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="success" title={tickets.length ? 'No guests match' : 'No tickets yet'}
            body={tickets.length ? 'Try another search or status.' : 'Paid tickets for this event will be listed here, ready to check in.'} />
        )}
      </section>
      {scanning && <TicketScan ctx={ctx} onClose={() => setScanning(false)} />}
      {guest && <GuestDetail ctx={ctx} person={guest} onClose={() => setGuest(null)} />}
    </>
  );
}

function GuestDetail({ ctx, person, onClose }) {
  const { state, money } = ctx;
  const [tab, setTab] = useState('Tickets');
  const [exporting, setExporting] = useState(false);
  const h = guestHistory(state, { guest: person.guest, phone: person.phone });
  const file = `${slug(person.name)}-${new Date().toISOString().slice(0, 10)}`;
  const ticketRows = h.bookings.flatMap(b => b.tickets.map(t => [b.eventName, b.ref, `${t.serial} of ${b.qty}`, t.used ? `Checked in ${new Date(t.usedAt * 1000).toLocaleString()}${t.usedBy ? ' by ' + t.usedBy : ''}` : b.status === 'Cancelled' ? 'Cancelled' : 'Not arrived']));
  const orderRows = h.orders.map(o => [dateTime(o.created * 1000), o.ref, o.tableName || 'Counter', o.items, o.status, money(o.total)]);
  const paymentRows = h.payments.map(p => [dateTime(p.created * 1000), p.ref, p.kind, p.method, money(p.vat), money(p.tip), money(p.amount)]);
  const exportCsv = () => downloadText(file + '.csv', toCsv([
    [person.name, person.phone], ['Total spent', money(h.totals.spent)], [],
    ['Tickets'], ['Event', 'Reference', 'Ticket', 'Status'], ...ticketRows, [],
    ['Orders'], ['When', 'Reference', 'Table', 'Items', 'Status', 'Total'], ...orderRows, [],
    ['Payments'], ['When', 'Reference', 'Type', 'Method', 'VAT', 'Tip', 'Amount'], ...paymentRows,
  ]));
  const exportGuestPdf = async () => {
    setExporting(true);
    try {
      await exportPdf({
        filename: file + '.pdf', title: person.name, subtitle: `${person.phone} · Guest history`, organization: state.name, logo: state.settings.theme.logo,
        sections: [
          { title: 'Summary', kpis: [['Total spent', money(h.totals.spent)], ['Tickets', h.totals.tickets], ['Checked in', h.totals.checkedIn], ['Orders', h.totals.orders], ['Bookings', h.bookings.length], ['Payments', h.payments.length]] },
          { title: 'Tickets', table: { head: ['Event', 'Reference', 'Ticket', 'Status'], body: ticketRows } },
          { title: 'Orders', table: { head: ['When', 'Reference', 'Table', 'Items', 'Status', 'Total'], body: orderRows, align: { 5: 'right' } } },
          { title: 'Payments', table: { head: ['When', 'Reference', 'Type', 'Method', 'VAT', 'Tip', 'Amount'], body: paymentRows, align: { 4: 'right', 5: 'right', 6: 'right' } } },
        ],
      });
    } finally {
      setExporting(false);
    }
  };
  return (
    <Modal wide title={person.name} eyebrow="Guest" onClose={onClose}
      footer={<><button onClick={exportCsv}><Icon name="download" />CSV</button><button className="primary" onClick={exportGuestPdf} disabled={exporting}><Icon name="download" />{exporting ? 'Preparing…' : 'Export PDF'}</button></>}>
      <div className="guest-head">
        <Avatar name={person.name} size={52} />
        <div className="grow"><b>{person.phone}</b><small className="muted">Guest since {shortDate(Math.min(...[...h.bookings, ...h.orders].map(r => r.created)) * 1000)}</small></div>
      </div>
      <div className="guest-totals">
        <div><strong>{money(h.totals.spent)}</strong><small>Total spent</small></div>
        <div><strong>{h.totals.tickets}</strong><small>Tickets</small></div>
        <div><strong>{h.totals.checkedIn}</strong><small>Checked in</small></div>
        <div><strong>{h.totals.orders}</strong><small>Orders</small></div>
      </div>
      <div className="segmented" role="tablist" aria-label="Guest history">
        {[['Tickets', ticketRows.length], ['Orders', h.orders.length], ['Payments', h.payments.length]].map(([t, n]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t} <span className="muted">{n}</span></button>
        ))}
      </div>
      {tab === 'Tickets' && (h.bookings.length ? h.bookings.map(b => (
        <div className="history-card" key={b.id}>
          <div className="row spread wrap"><b>{b.eventName}</b><span className="muted small">{b.ref} · {dateTime(b.created * 1000)}</span></div>
          <div className="history-tickets">
            {b.tickets.map(t => (
              <span key={t.serial} className={'badge ' + (t.used ? 'success' : 'neutral')}>
                Ticket {t.serial}: {t.used ? `in ${new Date(t.usedAt * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : b.status === 'Cancelled' ? 'cancelled' : 'not arrived'}
              </span>
            ))}
          </div>
          <div className="meta"><span>{money(b.subtotal)} tickets</span>{b.tax && <span>{b.tax.label} {money(vatOf(b))}</span>}<b style={{ color: 'var(--ink)' }}>Total {money(b.total)}</b></div>
        </div>
      )) : <p className="small">No tickets.</p>)}
      {tab === 'Orders' && (h.orders.length ? h.orders.map(o => (
        <div className="history-card" key={o.id}>
          <div className="row spread wrap"><b>{o.tableName || 'Counter pickup'}</b><span className="badge neutral">{o.status}</span></div>
          <p style={{ color: 'var(--ink)' }}>{o.items}</p>
          <div className="meta"><span>{o.ref}</span><span>{dateTime(o.created * 1000)}</span><span>Items {money(o.subtotal)}</span>{o.service && <span>Service {money(o.service.amount)}</span>}{o.tax && <span>{o.tax.label} {money(vatOf(o))}</span>}<span>Tip {money(o.tip || 0)}</span><b style={{ color: 'var(--ink)' }}>Total {money(o.total)}</b></div>
        </div>
      )) : <p className="small">No food or drink orders.</p>)}
      {tab === 'Payments' && (h.payments.length ? (
        <div className="table-scroll">
          <table className="report-table">
            <thead><tr><th>When</th><th>Reference</th><th>Type</th><th>Method</th><th className="num">VAT</th><th className="num">Tip</th><th className="num">Amount</th></tr></thead>
            <tbody>{h.payments.map(p => (
              <tr key={p.ref}><td>{dateTime(p.created * 1000)}</td><td>{p.ref}</td><td>{p.kind}</td><td>{p.method}</td><td className="num">{money(p.vat)}</td><td className="num">{money(p.tip)}</td><td className="num"><b>{money(p.amount)}</b></td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="small">No payments.</p>)}
    </Modal>
  );
}

function SettleModal({ ctx, record, onClose }) {
  const [method, setMethod] = useState('Cash');
  const { busy, error, run } = useRunner();
  return (
    <Modal title="Record payment" eyebrow={record.ref} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => run(async () => { await ctx.action('settle', { id: record.id, method }); onClose(); })}>{busy ? 'Saving…' : `Confirm ${ctx.money(record.total)} received`}</button></>}>
      <p><b style={{ color: 'var(--ink)' }}>{record.name}</b> · {record.qty ? `${record.qty} ticket${record.qty > 1 ? 's' : ''} for ${record.eventName}` : record.items}</p>
      <p className="notice">Collect <b>{ctx.money(record.total)}</b> in person before confirming. This records the payment — it does not charge the guest.</p>
      <Field label="Paid by">
        <select value={method} onChange={e => setMethod(e.target.value)}>
          <option>Cash</option><option>Card at venue</option>
        </select>
      </Field>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

function TicketScan({ ctx, onClose }) {
  const [result, setResult] = useState(null);
  const [manual, setManual] = useState('');
  const [attempt, setAttempt] = useState(0);
  const { busy, error, setError, run } = useRunner();
  const check = code => run(async () => {
    const out = await ctx.action('checkin_ticket', { code: code.trim() }, { quiet: true });
    setResult(out.result);
  });
  const again = () => { setResult(null); setError(''); setManual(''); setAttempt(a => a + 1); };
  return (
    <Modal title="Scan ticket" eyebrow="Entrance" onClose={onClose}>
      {result ? (
        <div className="stack center" style={{ justifyItems: 'center' }}>
          <span className="empty" style={{ padding: 0 }}><Icon name="success" /></span>
          <h2>Welcome, {result.name}</h2>
          <p>Ticket {result.serial} of {result.qty} · {result.event} · {result.ref}</p>
          {result.remaining > 0 && <p className="notice">{result.remaining} more ticket{result.remaining > 1 ? 's' : ''} on this booking. Enter the reference again to admit the next guest.</p>}
          <button className="primary block lg-btn" onClick={again}>Scan next ticket</button>
        </div>
      ) : error ? (
        <div className="stack">
          <p className="error" role="alert">{error}</p>
          <button className="primary block" onClick={again}>Try again</button>
        </div>
      ) : (
        <>
          <Scanner key={attempt} onResult={check} hint="Point the camera at the guest's ticket QR" />
          <form className="codeentry" onSubmit={e => { e.preventDefault(); if (manual) check(manual); }}>
            <input aria-label="Ticket reference number" placeholder="Or type reference, e.g. EN-ABC123" value={manual} onChange={e => setManual(e.target.value)} autoCapitalize="characters" style={{ textTransform: 'none', letterSpacing: 0 }} />
            <button className="primary" disabled={busy || !manual.trim()}>Check in</button>
          </form>
          <p className="footnote">Each ticket can be used once. A reference number admits the booking's tickets one at a time.</p>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- Tables

export function Tables({ ctx }) {
  const { state, matches } = ctx;
  const [editing, setEditing] = useState(null);
  const [qr, setQr] = useState(null);
  const [eventFilter, setEventFilter] = useState('All');
  const tables = state.tables.filter(t => eventFilter === 'All' || t.event === eventFilter).filter(t => matches(t.name, t.code));
  const eventName = id => state.events.find(e => e.id === id)?.name || 'Concert removed';
  return (
    <>
      <PageActions><button className="primary" onClick={() => setEditing({})} disabled={!state.events.length}><Icon name="add" />Add table</button></PageActions>
      <section className="card">
        <div className="card-head">
          <div className="chips">
            {['All', ...state.events.map(e => e.id)].map(id => (
              <button key={id} className={'chip' + (eventFilter === id ? ' active' : '')} onClick={() => setEventFilter(id)}>{id === 'All' ? 'All concerts' : eventName(id)}</button>
            ))}
          </div>
          <span className="badge neutral">{tables.length} tables</span>
        </div>
        {!state.events.length ? (
          <Empty icon="calendar" title="Create a concert first" body="Every table belongs to a concert, so guests order from the right menu." action="Go to events" onAction={() => ctx.go('Events')} />
        ) : tables.length ? (
          <>
            <div className="stage">STAGE</div>
            <div className="floor">
              {tables.map(t => (
                <div className={'tablecard ' + t.status.toLowerCase()} key={t.id}>
                  <div className="row spread"><h3>{t.name}</h3><span className={'badge ' + (t.status === 'Available' ? 'success' : 'neutral')}>{t.status}</span></div>
                  <small className="muted">{t.seats} seats · Code <b style={{ color: 'var(--ink)' }}>{t.code}</b></small>
                  <small className="muted">{eventName(t.event)}</small>
                  <div className="row">
                    <button onClick={() => setEditing(t)}>Edit</button>
                    <button className="primary" onClick={() => setQr(t)}>QR code</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : <Empty icon="table" title="A seat at your next show" body="Add tables to a concert. Each table gets a permanent QR code and a short code guests can type." action="Add table" onAction={() => setEditing({})} />}
      </section>
      {editing && <TableForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
      {qr && (
        <Modal title={qr.name} eyebrow="Scan. Order. Enjoy." onClose={() => setQr(null)}
          footer={<><button onClick={() => window.print()}>Print</button><button className="primary" onClick={() => setQr(null)}>Done</button></>}>
          <div className="printable stack center" style={{ justifyItems: 'center' }}>
            <p>{eventName(qr.event)}</p>
            <QR value={ctx.guestLink('&table=' + encodeURIComponent(qr.token))} name={qr.name + ' QR code'} />
            <p className="small">Can't scan? Enter table code</p>
            <span className="tablecode">{qr.code}</span>
          </div>
          <p className="footnote noprint">Place this on the table. The code stays the same for this table and concert. Guests' phones must be able to reach {new URL(ctx.session.guestOrigin).host}.</p>
        </Modal>
      )}
    </>
  );
}

function TableForm({ ctx, item, onClose }) {
  const { state } = ctx;
  const { busy, error, run } = useRunner();
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    run(async () => { await ctx.action('table', { ...v, event: item.event || v.event, id: item.id }); onClose(); });
  };
  const remove = () => confirm(`Delete ${item.name}? Its QR code will stop working.`) && run(async () => { await ctx.action('delete', { kind: 'table', id: item.id }); onClose(); });
  return (
    <Modal title={item.id ? 'Edit table' : 'Add table'} eyebrow={state.name} onClose={onClose}
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="table-form" disabled={busy}>{busy ? 'Saving…' : 'Save table'}</button>
      </>}>
      <form id="table-form" className="form" onSubmit={submit}>
        <Field label="Table name" name="name" defaultValue={item.name || 'Table ' + (state.tables.length + 1)} maxLength={120} required />
        <Field label="Concert" hint={item.id ? 'A table stays linked to its concert so printed QR codes never change meaning.' : undefined}>
          <select name="event" defaultValue={item.event} required disabled={!!item.id}>
            <option value="">Choose concert</option>
            {state.events.map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
          </select>
        </Field>
        <div className="formrow">
          <Field label="Seats" name="seats" type="number" min="1" max="30" defaultValue={item.seats || 4} required />
          <Field label="Status">
            <select name="status" defaultValue={item.status || 'Available'}><option>Available</option><option>Reserved</option><option>Blocked</option></select>
          </Field>
        </div>
        <p className="footnote">Blocked tables cannot place orders.</p>
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Menu

export function Menu({ ctx }) {
  const { state, money, matches } = ctx;
  const [editing, setEditing] = useState(null);
  const [category, setCategory] = useState('All');
  const categories = ['All', ...state.settings.menu.categories.filter(c => state.menu.some(i => i.category === c))];
  const items = state.menu.filter(i => category === 'All' || i.category === category).filter(i => matches(i.name, i.category, i.description));
  const servedAt = i => !i.events?.length ? 'All concerts' : i.events.map(id => state.events.find(e => e.id === id)?.name).filter(Boolean).join(', ');
  return (
    <>
      <PageActions><button className="primary" onClick={() => setEditing({})}><Icon name="add" />Add menu item</button></PageActions>
      {state.menu.length > 0 && <div className="chips">{categories.map(c => <button key={c} className={'chip' + (category === c ? ' active' : '')} onClick={() => setCategory(c)}>{c}</button>)}</div>}
      {items.length ? (
        <div className="menugrid">
          {items.map(i => (
            <article className="menuitem" key={i.id}>
              {i.image ? <img className="thumb" src={i.image} alt="" /> : <div className="thumb"><Icon name="menu" size="lg" /></div>}
              <div className="grow">
                <small className="muted">{i.category}</small>
                <h3>{i.name}</h3>
                <p>{servedAt(i)}</p>
                <div className="row" style={{ marginTop: 6 }}><b>{money(i.price)}</b>{!i.available && <span className="badge neutral">Unavailable</span>}</div>
              </div>
              <button onClick={() => setEditing(i)} aria-label={'Edit ' + i.name}><Icon name="pencil" /></button>
            </article>
          ))}
        </div>
      ) : (
        <section className="card"><Empty icon="menu" title={ctx.search ? 'No matching items' : 'Something delicious is on the way'} body="Add food and drinks with photos, prices and the concerts where they're served." action={ctx.search ? null : 'Add menu item'} onAction={() => setEditing({})} /></section>
      )}
      {editing && <MenuForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function MenuForm({ ctx, item, onClose }) {
  const { state } = ctx;
  const [image, setImage] = useState(item.image || '');
  const [available, setAvailable] = useState(item.available !== false);
  const [allEvents, setAllEvents] = useState(!item.events?.length);
  const [events, setEvents] = useState(item.events || []);
  const [trackStock, setTrackStock] = useState(!!item.trackStock);
  const { busy, error, run } = useRunner();
  const categories = state.settings.menu.categories;
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    if (!allEvents && !events.length) return run(async () => { throw new Error('Choose at least one concert, or serve this item at all concerts.'); });
    run(async () => { await ctx.action('menu', { ...v, id: item.id, image, available, trackStock, events: allEvents ? [] : events }); onClose(); });
  };
  const remove = () => confirm(`Delete ${item.name}?`) && run(async () => { await ctx.action('delete', { kind: 'menu', id: item.id }); onClose(); });
  return (
    <Modal title={item.id ? 'Edit menu item' : 'Add menu item'} eyebrow={state.name} onClose={onClose} wide
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="menu-form" disabled={busy}>{busy ? 'Saving…' : 'Save item'}</button>
      </>}>
      <form id="menu-form" className="form" onSubmit={submit}>
        <ImageUpload label="Photo" value={image} onChange={setImage} />
        <div className="formrow">
          <Field label="Item name" name="name" defaultValue={item.name} maxLength={120} required />
          <Field label="Category" hint={<button type="button" className="linklike small" onClick={() => { onClose(); ctx.go('Settings'); history.replaceState(null, '', '/admin?page=Settings&section=categories'); }}>Manage categories</button>}>
            <select name="category" defaultValue={item.category || categories[0]} required>{categories.map(c => <option key={c}>{c}</option>)}</select>
          </Field>
        </div>
        <Field label="Description"><textarea name="description" defaultValue={item.description} maxLength={500} required /></Field>
        <Field label={`Price (${state.currency})`} name="price" type="number" step="0.01" min="0" defaultValue={(item.price || 0) / 100} required />
        <Toggle label="Available to order" description="Turn off to hide the item from guests." checked={available} onChange={setAvailable} />
        <div>
          <Toggle label="Track stock" description="Orders reduce stock automatically and guests can't order more than you have. Manage counts on the Stock page." checked={trackStock} onChange={setTrackStock} />
          {trackStock && (
            <div className="formrow" style={{ paddingTop: 6 }}>
              {item.trackStock
                ? <Field label="In stock"><input value={item.stock} readOnly aria-describedby="stock-hint" /><small id="stock-hint">Change counts on the Stock page so every change is logged.</small></Field>
                : <Field label="Opening stock" name="stock" type="number" min="0" step="1" defaultValue={0} required />}
              <Field label="Low-stock alert at" name="lowStock" type="number" min="0" step="1" defaultValue={item.lowStock ?? 5} required hint="Guests see “Only N left” at or below this." />
            </div>
          )}
        </div>
        <div>
          <Toggle label="Served at all concerts" description="Turn off to choose specific concerts. Guests at a table only see that concert's menu." checked={allEvents} onChange={setAllEvents} />
          {!allEvents && (
            <div className="stack" style={{ paddingTop: 6 }}>
              {state.events.length ? state.events.map(e => (
                <label className="checkline" key={e.id}>
                  <input type="checkbox" checked={events.includes(e.id)} onChange={ev => setEvents(ev.target.checked ? [...events, e.id] : events.filter(x => x !== e.id))} />
                  <span>{e.name} <span className="muted">· {shortDate(e.date)}</span></span>
                </label>
              )) : <p className="footnote">Create a concert first.</p>}
            </div>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Orders

export function Orders({ ctx }) {
  const { state, money, matches } = ctx;
  const [filter, setFilter] = useState('Active');
  const [settling, setSettling] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [taking, setTaking] = useState(false);
  const [rowError, setRowError] = useState('');
  const canTakeOrders = ['Owner', 'Admin', 'Service'].includes(ctx.role);
  const filters = {
    Active: o => ['Placed', 'Preparing', 'Ready'].includes(o.status),
    Unpaid: o => !o.paid && o.status !== 'Cancelled',
    Delivered: o => o.status === 'Delivered',
    Cancelled: o => o.status === 'Cancelled',
    All: () => true,
  };
  const next = { Placed: 'Preparing', Preparing: 'Ready', Ready: 'Delivered' };
  const rows = [...state.orders].reverse().filter(filters[filter]).filter(o => matches(o.ref, o.name, o.tableName, o.items));
  const act = async (op, data) => {
    setRowError('');
    try { await ctx.action(op, data); } catch (e) { setRowError(e.message); }
  };
  return (
    <section className="card">
      {canTakeOrders && <PageActions><button className="primary" onClick={() => setTaking(true)}><Icon name="add" />New order</button></PageActions>}
      <div className="card-head">
        <div className="segmented" role="tablist" aria-label="Filter orders">
          {Object.keys(filters).map(f => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f} <span className="muted">{state.orders.filter(filters[f]).length}</span>
            </button>
          ))}
        </div>
        <button onClick={ctx.refresh}><Icon name="refresh" />Refresh</button>
      </div>
      <ErrorText>{rowError}</ErrorText>
      {rows.length ? rows.map(o => (
        <div className="recordrow" key={o.id}>
          <div className="row spread wrap">
            <div>
              <h3>{o.tableName || 'Counter pickup'} <span className="muted small">· {o.ref}</span></h3>
              <div className="meta"><span>{o.name}</span>{o.phone && <span>{o.phone}</span>}<span>{dateTime(o.created * 1000)}</span>{o.waiterName && <span>Waiter #{o.waiterNumber} {o.waiterName}</span>}{o.takenBy && <span>Taken by {o.takenBy}</span>}</div>
            </div>
            <div className="row wrap">{paidBadge(o)}<span className="badge dark">{o.status}</span></div>
          </div>
          <p style={{ color: 'var(--ink)' }}>{o.items}</p>
          <div className="row spread wrap">
            <div className="meta"><span>Items {money(o.subtotal)}</span>{o.tax && <span>{o.tax.label} {o.tax.included ? 'incl.' : '+'} {money(o.tax.amount)}</span>}<span>Tip {money(o.tip || 0)}</span><b style={{ color: 'var(--ink)' }}>Total {money(o.total)}</b></div>
            <div className="actions">
              <button onClick={() => setPrinting(o)} aria-label={`Print order ${o.ref}`}><Icon name="download" />Print</button>
              {['Placed', 'Preparing'].includes(o.status) && !o.paid && <button onClick={() => confirm(`Cancel order ${o.ref}?`) && act('cancel', { id: o.id })}>Cancel</button>}
              {o.status !== 'Cancelled' && !o.paid && <button onClick={() => setSettling(o)}>Record payment</button>}
              {next[o.status] && <button className="primary" onClick={() => act('order_status', { id: o.id, status: next[o.status] })}>Mark {next[o.status].toLowerCase()}</button>}
            </div>
          </div>
        </div>
      )) : <Empty icon="menu" title={filter === 'Active' ? 'All caught up' : 'Nothing here'} body="Table and counter orders appear here with items, tip, payment and preparation status. Guests are notified as you update them." />}
      {settling && <SettleModal ctx={ctx} record={settling} onClose={() => setSettling(null)} />}
      {printing && <PrintOrder ctx={ctx} order={state.orders.find(o => o.id === printing.id) || printing} onClose={() => setPrinting(null)} />}
      {taking && <NewOrder ctx={ctx} onClose={() => setTaking(false)} onCreated={order => { setTaking(false); setFilter('Active'); if (order) setPrinting(order); }} />}
    </section>
  );
}

// ---------------------------------------------------------------- Team

export function Team({ ctx }) {
  const { session, state, role } = ctx;
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState('');
  const { busy, error, run } = useRunner();
  const remove = m => confirm(`Remove ${m.name} from ${state.name}? They will be signed out immediately.`) &&
    run(async () => { ctx.setSession(await api('team/remove', { id: m.id })); ctx.toast(m.name + ' was removed'); });
  const invite = e => {
    e.preventDefault();
    run(async () => { setLink((await api('invite', Object.fromEntries(new FormData(e.currentTarget)))).url); });
  };
  return (
    <>
      {ctx.canManage && <PageActions><button className="primary" onClick={() => { setInviting(true); setLink(''); }}><Icon name="add" />Invite member</button></PageActions>}
      <section className="card">
        <div className="card-head"><h2>{state.name} team</h2><span className="badge neutral">{session.team.length} members</span></div>
        <ErrorText>{!inviting && error}</ErrorText>
        <div className="list">
          {session.team.map(m => (
            <div className="listrow" key={m.id}>
              <Avatar name={m.name} src={m.avatar} />
              <div className="grow"><b>{m.name}{m.id === session.user.id && <span className="muted"> (you)</span>}</b><small>{m.email}</small></div>
              <span className="badge neutral">{m.role}</span>
              {role === 'Owner' && m.role !== 'Owner' && <button className="ghost danger-text" onClick={() => remove(m)} disabled={busy}>Remove</button>}
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Roles</h3>
        <div className="list" style={{ marginTop: 8 }}>
          {[['Owner & Admin', 'Everything: events, menu, tables, orders, bookings, team and settings.'], ['Service', 'Order queue: prepare, deliver, record payment and cancel orders.'], ['Gate', 'Bookings: check guests in and scan tickets.']].map(([r, d]) => (
            <div className="listrow" key={r}><b style={{ width: 130 }}>{r}</b><p className="small grow">{d}</p></div>
          ))}
        </div>
      </section>
      {inviting && (
        <Modal title={link ? 'Your invitation is ready' : 'Invite a teammate'} eyebrow={state.name} onClose={() => setInviting(false)}
          footer={link
            ? <><button onClick={async () => ctx.toast(await copyText(link) ? 'Invitation link copied' : 'Select and copy the link')}>Copy link</button><button className="primary" onClick={() => setInviting(false)}>Done</button></>
            : <><button onClick={() => setInviting(false)}>Cancel</button><button className="primary" form="invite-form" disabled={busy}>{busy ? 'Creating…' : 'Create invitation'}</button></>}>
          {link ? (
            <>
              <p>Send this private link to your teammate. It works once, for the invited email address, for seven days.</p>
              <input aria-label="Invitation link" readOnly value={link} onFocus={e => e.target.select()} />
            </>
          ) : (
            <form id="invite-form" className="form" onSubmit={invite}>
              <Field label="Email address" name="email" type="email" autoComplete="off" required />
              <Field label="Role"><select name="role"><option>Admin</option><option>Service</option><option>Gate</option></select></Field>
              <ErrorText>{error}</ErrorText>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Profile

export function Profile({ ctx }) {
  const { session } = ctx;
  const profile = useRunner();
  const password = useRunner();
  const [name, setName] = useState(session.user.name);
  const saveProfile = patch => profile.run(async () => {
    ctx.setSession(await api('profile', { name, avatar: session.user.avatar, ...patch }));
    ctx.toast(patch.avatar !== undefined ? (patch.avatar ? 'Photo updated' : 'Photo removed') : 'Profile updated');
  });
  return (
    <div className="grid-2">
      <section className="card stack lg">
        <div className="profile-card">
          <label className="avatar-upload" title="Change photo">
            <Avatar name={session.user.name} src={session.user.avatar} size={88} />
            <span className="avatar-upload-badge"><Icon name="pencil" size="sm" /></span>
            <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload profile photo" disabled={profile.busy}
              onChange={async e => {
                const file = e.target.files[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 5000000) return profile.setError('Choose a photo smaller than 5 MB.');
                const { url } = await profile.run(async () => api('upload', { data: await readFileAsBase64(file) })) || {};
                if (url) saveProfile({ avatar: url });
              }} />
          </label>
          <div className="grow">
            <h2>{session.user.name}</h2>
            <p>{session.user.role} · {session.state.name}</p>
            {session.user.avatar && <button className="linklike small" onClick={() => saveProfile({ avatar: '' })} disabled={profile.busy}>Remove photo</button>}
          </div>
        </div>
        <form className="form" onSubmit={e => { e.preventDefault(); saveProfile({}); }}>
          <Field label="Full name" value={name} onChange={e => setName(e.target.value)} maxLength={100} required />
          <Field label="Email address" value={session.user.email} readOnly hint="Contact your workspace owner to change your sign-in email." />
          <ErrorText>{profile.error}</ErrorText>
          <div className="row"><button className="primary" disabled={profile.busy || !name.trim() || name === session.user.name}>Save name</button></div>
        </form>
        <hr />
        <button className="ghost danger-text" style={{ justifySelf: 'start' }} onClick={async () => { try { await api('signout', {}); } finally { location.assign('/admin/signin'); } }}>Sign out</button>
      </section>
      <section className="card">
        <h2>Password & security</h2>
        <p style={{ margin: '6px 0 16px' }}>Changing your password signs you out everywhere.</p>
        <form className="form" onSubmit={e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); password.run(async () => { await api('password', v); location.assign('/admin/signin'); }); }}>
          <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
          <Field label="New password" name="password" type="password" minLength={12} autoComplete="new-password" required hint="At least 12 characters." />
          <ErrorText>{password.error}</ErrorText>
          <div className="row"><button className="primary" disabled={password.busy}>Change password</button></div>
        </form>
      </section>
    </div>
  );
}
