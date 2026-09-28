import React, { useState } from 'react';
import { dateTime } from '../../shared/api';
import { NewOrder, PrintOrder } from '../service';
import { Empty, ErrorText, Icon, Modal } from '../../shared/ui';
import { PageActions, paidBadge, SettleModal } from './common';

export function Orders({ ctx }) {
  const { state, money, matches } = ctx;
  const cashier = ctx.role === 'Cashier';
  const [filter, setFilter] = useState(() => cashier || (ctx.role === 'Service' && ctx.state.settings.ordering.cashierConfirm) ? 'Cashier' : 'Active');
  const [settling, setSettling] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [taking, setTaking] = useState(false);
  const [rowError, setRowError] = useState('');
  const [moving, setMoving] = useState(null); // { order, to, back } awaiting confirmation
  const canTakeOrders = ['Owner', 'Admin', 'Service'].includes(ctx.role);
  const cashierQueue = state.settings.ordering.cashierConfirm || state.orders.some(o => o.status === 'Awaiting cashier');
  // A cashier's list comes from the server already narrowed to the open queue and the orders they handled.
  const filters = cashier ? {
    Cashier: o => o.status === 'Awaiting cashier',
    'Sent to kitchen': o => o.status !== 'Awaiting cashier' && o.status !== 'Cancelled',
    Cancelled: o => o.status === 'Cancelled',
  } : {
    ...(cashierQueue ? { Cashier: o => o.status === 'Awaiting cashier' } : {}),
    Active: o => ['Placed', 'Preparing', 'Ready'].includes(o.status),
    Unpaid: o => !o.paid && o.status !== 'Cancelled',
    Delivered: o => o.status === 'Delivered',
    Cancelled: o => o.status === 'Cancelled',
    All: () => true,
  };
  const next = { Placed: 'Preparing', Preparing: 'Ready', Ready: 'Delivered' };
  const back = { Preparing: 'Placed', Ready: 'Preparing', Delivered: 'Ready' };
  const rows = [...state.orders].reverse().filter(filters[filter]).filter(o => matches(o.ref, o.name, o.tableName, o.items));
  const act = async (op, data) => {
    setRowError('');
    try { return await ctx.action(op, data); } catch (e) { setRowError(e.message); return null; }
  };
  // Confirming sends the order to the kitchen; the receipt printed now is the one handed to the waiter.
  const confirmAndPrint = async o => {
    const result = await act('confirm_order', { id: o.id });
    if (result) setPrinting(result.state.orders.find(x => x.id === o.id) || o);
  };
  const mine = o => o.claimedById === ctx.session.user.id;
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
            <div className="row wrap">{o.status === 'Awaiting cashier' && o.claimedBy && <span className="badge neutral">{mine(o) ? 'You are handling this' : `Handled by ${o.claimedBy}`}</span>}{paidBadge(o)}<span className="badge dark">{o.status === 'Awaiting cashier' ? 'Waiting for cashier' : o.status}</span></div>
          </div>
          <p style={{ color: 'var(--ink)' }}>{o.items}</p>
          <div className="row spread wrap">
            <div className="meta"><span>Items {money(o.subtotal)}</span>{o.tax && <span>{o.tax.label} {o.tax.included ? 'incl.' : '+'} {money(o.tax.amount)}</span>}<span>Tip {money(o.tip || 0)}</span><b style={{ color: 'var(--ink)' }}>Total {money(o.total)}</b></div>
            <div className="actions">
              {o.status !== 'Awaiting cashier' && <button onClick={() => setPrinting(o)} aria-label={`Print order ${o.ref}`}><Icon name="download" />Print</button>}
              {(cashier ? ['Awaiting cashier'] : ['Awaiting cashier', 'Placed', 'Preparing']).includes(o.status) && !o.paid && <button onClick={() => confirm(`Cancel order ${o.ref}?`) && act('cancel', { id: o.id })}>Cancel</button>}
              {o.status === 'Awaiting cashier' && !o.claimedBy && <button onClick={() => act('claim', { id: o.id })}>Claim</button>}
              {o.status !== 'Cancelled' && !o.paid && (!cashier || o.status === 'Awaiting cashier') && <button onClick={() => setSettling(o)}>Record payment</button>}
              {o.status === 'Awaiting cashier' && <button className="primary" disabled={!o.paid} title={o.paid ? '' : 'Record the payment first'} onClick={() => confirmAndPrint(o)}>Confirm & print</button>}
              {canTakeOrders && back[o.status] && <button onClick={() => setMoving({ order: o, to: back[o.status], back: true })}>Back to {back[o.status].toLowerCase()}</button>}
              {!cashier && next[o.status] && <button className="primary" onClick={() => setMoving({ order: o, to: next[o.status], back: false })}>Mark {next[o.status].toLowerCase()}</button>}
            </div>
          </div>
        </div>
      )) : <Empty icon="menu" title={filter === 'Active' ? 'All caught up' : 'Nothing here'} body={filter === 'Cashier' ? 'New guest orders wait here for a cashier. Claim one, take the payment, then confirm and print the receipt for the waiter.' : 'Table and counter orders appear here with items, tip, payment and preparation status. Guests are notified as you update them.'} />}
      {moving && (
        <Modal title={moving.back ? `Move ${moving.order.ref} back to ${moving.to}?` : `Mark ${moving.order.ref} as ${moving.to}?`} eyebrow={moving.order.tableName || 'Counter pickup'} onClose={() => setMoving(null)}
          footer={<><button onClick={() => setMoving(null)}>Cancel</button><button className="primary" onClick={async () => {
            const { order, to, back: undo } = moving;
            setMoving(null);
            await act(undo ? 'order_back' : 'order_status', undo ? { id: order.id } : { id: order.id, status: to });
          }}>{moving.back ? 'Move back' : `Mark ${moving.to.toLowerCase()}`}</button></>}>
          <p>{moving.order.items}</p>
          <p className="small">{moving.back
            ? `The order goes back from ${moving.order.status} to ${moving.to}. ${moving.order.name} is told it was corrected.`
            : `${moving.order.name} is notified that the order is ${moving.to.toLowerCase()}.`}</p>
        </Modal>
      )}
      {settling && <SettleModal ctx={ctx} record={settling} onClose={() => setSettling(null)} />}
      {printing && <PrintOrder ctx={ctx} order={state.orders.find(o => o.id === printing.id) || printing} onClose={() => setPrinting(null)} />}
      {taking && <NewOrder ctx={ctx} onClose={() => setTaking(false)} onCreated={order => { setTaking(false); setFilter('Active'); if (order) setPrinting(order); }} />}
    </section>
  );
}
