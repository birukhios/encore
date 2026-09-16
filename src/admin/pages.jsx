import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, dateTime, shortDate } from '../shared/api';
import ImageUpload from '../shared/ImageUpload';
import QR from '../shared/QR';
import Scanner from '../shared/Scanner';
import { copyText, Empty, ErrorText, Field, Icon, Modal, Toggle } from '../shared/ui';

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
  : r.paid ? <span className="badge success">Paid · {r.settledBy}</span> : <span className="badge warning">Pay at venue</span>;

// ---------------------------------------------------------------- Overview

export function Overview({ ctx }) {
  const { state, money, go, canManage, role, session } = ctx;
  const records = [...state.bookings, ...state.orders];
  const collected = records.filter(r => r.paid && r.status !== 'Cancelled').reduce((s, r) => s + r.total, 0);
  const outstanding = records.filter(r => !r.paid && r.status !== 'Cancelled').reduce((s, r) => s + r.total, 0);
  const upcoming = [...state.events].sort((a, b) => a.date.localeCompare(b.date)).filter(e => new Date(e.date) >= new Date(Date.now() - 86400000));
  const cfg = state.settings;
  const steps = [
    ['Create your first event', state.events.some(e => e.published), 'Events'],
    ['Add food & drinks', state.menu.length > 0, 'Menu'],
    ['Set up table QR codes', state.tables.length > 0, 'Tables'],
    ['Brand your guest app', !!(cfg.theme.logo || cfg.theme.cover || cfg.theme.accent !== '#E61E32'), 'Settings'],
    ['Add help & support contacts', !!(cfg.support.email || cfg.support.phone), 'Settings'],
    ['Publish your terms', !!cfg.legal.terms, 'Settings'],
    ['Set up taxes (VAT/TOT and TIN)', cfg.tax.regime === 'none' || !!cfg.tax.tin, 'Settings'],
    ['Add your location & photos', !!(cfg.profile.address || cfg.profile.photos.length), 'Settings'],
  ];
  return (
    <>
      {canManage && <PageActions><button className="primary" onClick={() => go('Events', 'create')}><Icon name="add" />Create event</button></PageActions>}
      <div className="stats">
        {[
          ['Collected at venue', money(collected), 'wallet', money(outstanding) + ' awaiting payment'],
          ['Live events', state.events.filter(e => e.published).length, 'calendar', state.events.length + ' in total'],
          ['Tickets reserved', state.bookings.filter(b => b.status !== 'Cancelled').reduce((s, b) => s + b.qty, 0), 'ticket', state.bookings.filter(b => b.status === 'Checked in').length + ' bookings checked in'],
          ['Active orders', state.orders.filter(o => ['Placed', 'Preparing', 'Ready'].includes(o.status)).length, 'menu', 'In the kitchen & on the floor'],
        ].map(([label, value, icon, sub]) => (
          <article className="stat" key={label}>
            <div className="row"><span>{label}</span><Icon name={icon} /></div>
            <strong>{value}</strong>
            <small>{sub}</small>
          </article>
        ))}
      </div>
      <div className="grid-2">
        <section className="card">
          <div className="card-head"><h2>Your next performances</h2>{role !== 'Service' && role !== 'Gate' && <button onClick={() => go('Events')}>View events</button>}</div>
          {upcoming.length ? (
            <div className="list">
              {upcoming.slice(0, 5).map(e => {
                const d = new Date(e.date);
                const sold = state.bookings.filter(b => b.event === e.id && b.status !== 'Cancelled').reduce((s, b) => s + b.qty, 0);
                return (
                  <div className="listrow" key={e.id}>
                    <div className="datebox"><b>{d.getDate()}</b><small>{d.toLocaleString('en', { month: 'short' })}</small></div>
                    <div className="grow">
                      <h3>{e.name}</h3>
                      <small>{e.venue} · {sold}/{e.capacity} reserved</small>
                    </div>
                    <span className={'badge ' + (e.published ? 'success' : 'neutral')}>{e.published ? 'Published' : 'Draft'}</span>
                  </div>
                );
              })}
            </div>
          ) : <Empty title="Your first event awaits" body="Add the lineup, date, venue and a striking cover image." action={canManage ? 'Create event' : null} onAction={() => go('Events', 'create')} />}
        </section>
        {canManage && (
          <section className="card checklist">
            <span className="eyebrow accent">Ready for showtime</span>
            <h2 style={{ marginBottom: 8 }}>Set the stage.</h2>
            {steps.map(([label, done, to]) => (
              <button key={label} onClick={() => go(to)}>
                <span className={'step' + (done ? ' done' : '')}><Icon name={done ? 'check' : 'clock'} /></span>
                <span>{label}</span>
                <Icon name="next" />
              </button>
            ))}
            {!session.sms.delivers && <p className="notice warning small" style={{ marginTop: 10 }}>Guest SMS: {session.sms.label}.</p>}
          </section>
        )}
      </div>
      <section className="card">
        <div className="card-head"><h2>Latest activity</h2>{pagesFor(role).includes('Orders') && <button onClick={() => go('Orders')}>View orders</button>}</div>
        {records.length ? (
          <div className="list">
            {records.sort((a, b) => b.created - a.created).slice(0, 8).map(r => (
              <div className="listrow" key={r.id}>
                <span className="avatar">{r.name[0]}</span>
                <div className="grow">
                  <b>{r.name} · {r.qty ? r.eventName : r.tableName || 'Counter pickup'}</b>
                  <small>{r.ref} · {r.qty ? `${r.qty} ticket${r.qty > 1 ? 's' : ''}` : r.items} · {dateTime(r.created * 1000)}</small>
                </div>
                {paidBadge(r)}
              </div>
            ))}
          </div>
        ) : <Empty icon="bell" title="The best is yet to come" body="Bookings and table orders appear here as guests reserve." />}
      </section>
    </>
  );
}

const pagesFor = role => ({ Service: ['Overview', 'Orders'], Gate: ['Overview', 'Bookings'] }[role] || ['Overview', 'Events', 'Bookings', 'Tables', 'Menu', 'Orders']);

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
                {e.image ? <img className="cover" src={e.image} alt="" /> : <div className="cover placeholder"><Icon name="brand" /></div>}
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
  const [filter, setFilter] = useState('Unpaid');
  const [settling, setSettling] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [rowError, setRowError] = useState('');
  const filters = {
    Unpaid: b => b.status === 'Reserved' && !b.paid,
    'Ready for entry': b => b.status === 'Reserved' && b.paid,
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
                {b.status === 'Reserved' && !b.paid && canManage && <button className="primary" onClick={() => setSettling(b)}>Record payment</button>}
                {b.status === 'Reserved' && b.paid && <button className="primary" onClick={() => act('checkin', { id: b.id })}>Check in all</button>}
              </div>
            </div>
          </div>
        )) : <Empty icon="ticket" title={filter === 'Unpaid' ? 'No payments waiting' : 'Nothing here yet'} body="Guest reservations appear here. Record payment at the door, then check guests in or scan their tickets." />}
      </section>
      {settling && <SettleModal ctx={ctx} record={settling} onClose={() => setSettling(null)} />}
      {scanning && <TicketScan ctx={ctx} onClose={() => setScanning(false)} />}
    </>
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
          <option>Cash</option><option>Card at venue</option><option>Bank transfer</option>
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
          <p>Ticket {result.serial} of {result.qty} · {result.event}</p>
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
            <input aria-label="Ticket code" placeholder="Or paste ticket code" value={manual} onChange={e => setManual(e.target.value)} style={{ textTransform: 'none', letterSpacing: 0 }} />
            <button className="primary" disabled={busy || !manual}>Check</button>
          </form>
          <p className="footnote">Tickets must be paid before entry. Each ticket can be scanned once.</p>
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
  const { busy, error, run } = useRunner();
  const categories = state.settings.menu.categories;
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    if (!allEvents && !events.length) return run(async () => { throw new Error('Choose at least one concert, or serve this item at all concerts.'); });
    run(async () => { await ctx.action('menu', { ...v, id: item.id, image, available, events: allEvents ? [] : events }); onClose(); });
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
        <Toggle label="Available to order" description="Turn off when an item sells out." checked={available} onChange={setAvailable} />
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
  const [rowError, setRowError] = useState('');
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
              <div className="meta"><span>{o.name}</span><span>{o.phone}</span><span>{dateTime(o.created * 1000)}</span></div>
            </div>
            <div className="row wrap">{paidBadge(o)}<span className="badge dark">{o.status}</span></div>
          </div>
          <p style={{ color: 'var(--ink)' }}>{o.items}</p>
          <div className="row spread wrap">
            <div className="meta"><span>Items {money(o.subtotal)}</span>{o.tax && <span>{o.tax.label} {o.tax.included ? 'incl.' : '+'} {money(o.tax.amount)}</span>}<span>Tip {money(o.tip || 0)}</span><b style={{ color: 'var(--ink)' }}>Total {money(o.total)}</b></div>
            <div className="actions">
              {['Placed', 'Preparing'].includes(o.status) && !o.paid && <button onClick={() => confirm(`Cancel order ${o.ref}?`) && act('cancel', { id: o.id })}>Cancel</button>}
              {o.status !== 'Cancelled' && !o.paid && <button onClick={() => setSettling(o)}>Record payment</button>}
              {next[o.status] && <button className="primary" onClick={() => act('order_status', { id: o.id, status: next[o.status] })}>Mark {next[o.status].toLowerCase()}</button>}
            </div>
          </div>
        </div>
      )) : <Empty icon="menu" title={filter === 'Active' ? 'All caught up' : 'Nothing here'} body="Table and counter orders appear here with items, tip, payment and preparation status. Guests are notified as you update them." />}
      {settling && <SettleModal ctx={ctx} record={settling} onClose={() => setSettling(null)} />}
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
              <span className="avatar">{m.name[0]}</span>
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
  return (
    <div className="grid-2">
      <section className="card">
        <div className="row" style={{ marginBottom: 18 }}>
          <span className="avatar lg">{session.user.name[0]}</span>
          <div><h2>{session.user.name}</h2><p>{session.user.role} · {session.state.name}</p></div>
        </div>
        <form className="form" onSubmit={e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.currentTarget)); profile.run(async () => { ctx.setSession(await api('profile', v)); ctx.toast('Profile updated'); }); }}>
          <Field label="Full name" name="name" defaultValue={session.user.name} maxLength={100} required />
          <Field label="Email address" value={session.user.email} readOnly hint="Contact your workspace owner to change your sign-in email." />
          <ErrorText>{profile.error}</ErrorText>
          <div className="row"><button className="primary" disabled={profile.busy}>Save profile</button></div>
        </form>
        <hr />
        <button onClick={async () => { try { await api('signout', {}); } finally { location.assign('/admin/signin'); } }}>Sign out</button>
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
