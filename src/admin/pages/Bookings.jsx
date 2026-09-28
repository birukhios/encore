import React, { useState } from 'react';
import { dateTime } from '../../shared/api';
import { Empty, ErrorText, Icon } from '../../shared/ui';
import { PageActions, paidBadge, SellTickets, SettleModal, TicketScan } from './common';

export function Bookings({ ctx }) {
  const { state, money, canManage, role, matches } = ctx;
  const [filter, setFilter] = useState('Ready for entry');
  const [settling, setSettling] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [selling, setSelling] = useState(false);
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
      <PageActions>
        <button onClick={() => setSelling(true)}><Icon name="add" />Sell tickets</button>
        <button className="primary" onClick={() => setScanning(true)}><Icon name="ticket" />Scan ticket</button>
      </PageActions>
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
                {b.status === 'Reserved' && !b.paid && <button className="primary" onClick={() => setSettling(b)}>Take payment</button>}
                {b.status === 'Reserved' && b.paid && <button className="primary" onClick={() => act('checkin', { id: b.id })}>Check in {b.tickets.filter(t => !t.used).length > 1 ? 'all' : ''}</button>}
              </div>
            </div>
          </div>
        )) : <Empty icon="ticket" title="Nothing here yet" body="Tickets bought online appear here. Scan each ticket's QR code or type its reference number to check guests in." />}
      </section>
      {settling && <SettleModal ctx={ctx} record={settling} onClose={() => setSettling(null)} />}
      {scanning && <TicketScan ctx={ctx} onClose={() => setScanning(false)} />}
      {selling && <SellTickets ctx={ctx} onClose={() => setSelling(false)} />}
    </>
  );
}
