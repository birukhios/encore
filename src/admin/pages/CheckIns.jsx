import React, { useState } from 'react';
import { dateTime, shortDate } from '../../shared/api';
import { exportPdf } from '../pdf';
import { downloadText, guestHistory, slug, toCsv, vatOf } from '../reportData';
import { Avatar, Empty, ErrorText, Field, Icon, Modal } from '../../shared/ui';
import { PageActions, TicketScan } from './common';

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
