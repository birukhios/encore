import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Scanner from '../../shared/Scanner';
import { ErrorText, Field, Icon, Modal } from '../../shared/ui';

export function PageActions({ children }) {
  const [node, setNode] = useState(null);
  useEffect(() => setNode(document.getElementById('page-actions')), []);
  return node ? createPortal(children, node) : null;
}

/** Runs an async action, surfaces its error inline, and tracks busy state. */
export function useRunner() {
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

export const paidBadge = r => r.status === 'Cancelled'
  ? <span className="badge neutral">Cancelled</span>
  : r.paid ? <span className="badge success">Paid · {r.settledBy}</span> : <span className="badge warning">{r.settlement === 'cash' ? 'Pay cash' : 'Unpaid'}</span>;

/**
 * Cash or Afropay. Afropay is shown but switched off until the workspace's Afropay checkout is connected,
 * so staff can see why it is unavailable instead of wondering where it went.
 */
export function PayChoice({ ctx, value, onChange, allowUnpaid = false }) {
  const ready = !!ctx.session.paymentReady;
  const options = [['Cash', 'Cash', ''], ['Afropay', 'Afropay', ready ? 'Telebirr, CBE Birr, M-PESA, Awash Birr' : 'Not connected yet'], ...(allowUnpaid ? [['', 'Not paid yet', '']] : [])];
  return (
    <fieldset className="pay-methods">
      <legend>Payment</legend>
      {options.map(([id, label, note]) => {
        const off = id === 'Afropay' && !ready;
        return (
          <label key={label} className={'choice compact' + (value === id ? ' active' : '') + (off ? ' disabled' : '')}>
            <input type="radio" name="pay-choice" checked={value === id} disabled={off} onChange={() => onChange(id)} />
            <span><b>{label}</b>{note && <small className="muted"> · {note}</small>}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function SettleModal({ ctx, record, onClose, onPaid }) {
  const [method, setMethod] = useState('Cash');
  const { busy, error, run } = useRunner();
  const pay = () => run(async () => {
    await ctx.action('settle', { id: record.id, method });
    onClose();
    onPaid?.();
  });
  return (
    <Modal title="Take payment" eyebrow={record.ref} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={pay}>{busy ? 'Saving…' : `Confirm ${ctx.money(record.total)} received`}</button></>}>
      <p><b style={{ color: 'var(--ink)' }}>{record.name}</b> · {record.qty ? `${record.qty} ticket${record.qty > 1 ? 's' : ''} for ${record.eventName}` : record.items}</p>
      <PayChoice ctx={ctx} value={method} onChange={setMethod} />
      <p className="notice">Collect <b>{ctx.money(record.total)}</b> in cash before confirming. This records the payment — it does not charge the guest.</p>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

/** Walk-up ticket sales at the entrance. */
export function SellTickets({ ctx, onClose }) {
  const { state, money } = ctx;
  const open = state.events.filter(e => e.published && !e.cancelled && new Date(e.date) > new Date(Date.now() - 6 * 3600000));
  const [eventId, setEventId] = useState(open[0]?.id || '');
  const [qty, setQty] = useState(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState('Cash');
  const [sold, setSold] = useState(null);
  const { busy, error, run } = useRunner();
  const event = open.find(e => e.id === eventId);
  const total = event ? Math.round(Number(event.price) * 100) * qty : 0;
  const sell = () => run(async () => {
    const out = await ctx.action('staff_booking', { event: eventId, qty, name, phone, method }, { quiet: true });
    setSold(out.result);
  });
  return (
    <Modal title={sold ? 'Tickets sold' : 'Sell tickets'} eyebrow="Entrance" onClose={onClose}
      footer={sold
        ? <><button onClick={() => { setSold(null); setQty(1); setName(''); setPhone(''); }}>Sell more</button><button className="primary" onClick={onClose}>Done</button></>
        : <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !event} onClick={sell}>{busy ? 'Saving…' : method === 'Cash' ? `${money(total)} cash received` : `Sell ${qty} ticket${qty > 1 ? 's' : ''}`}</button></>}>
      {sold ? (
        <p className="notice success">Booking <b>{sold.ref}</b> · {money(sold.total)}. {method === 'Cash' ? 'Paid in cash. Scan or type the reference to let them in.' : 'Waiting for payment.'}</p>
      ) : open.length ? (
        <div className="form">
          <Field label="Event">
            <select value={eventId} onChange={e => setEventId(e.target.value)}>{open.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
          </Field>
          <Field label="Tickets" type="number" min="1" max="50" step="1" value={qty} onChange={e => setQty(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
          <Field label="Guest name (optional)" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Walk-in guest" />
          <Field label={method === 'Afropay' ? 'Guest phone' : 'Guest phone (optional)'} type="tel" inputMode="tel" value={phone} maxLength={20} onChange={e => setPhone(e.target.value)} placeholder="0911 234 567" />
          <PayChoice ctx={ctx} value={method} onChange={setMethod} />
          {method === 'Cash' && event && <p className="notice">Collect <b>{money(total)}</b> in cash before selling.</p>}
          <ErrorText>{error}</ErrorText>
        </div>
      ) : <p>No event is on sale right now.</p>}
    </Modal>
  );
}

export function TicketScan({ ctx, onClose }) {
  const [result, setResult] = useState(null);
  const [manual, setManual] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [lastCode, setLastCode] = useState('');
  const [paying, setPaying] = useState(null);
  const { busy, error, setError, run } = useRunner();
  const check = code => {
    setLastCode(code.trim());
    return run(async () => {
      const out = await ctx.action('checkin_ticket', { code: code.trim() }, { quiet: true });
      setResult(out.result);
    });
  };
  // A scanned reservation that is not paid yet: take the payment here, then admit the guest.
  const ref = lastCode.split(':')[0].toUpperCase();
  const unpaid = error && ctx.state.bookings.find(b => b.ref === ref && b.status === 'Reserved' && !b.paid);
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
          {unpaid && <button className="primary block" onClick={() => setPaying(unpaid)}>Take {ctx.money(unpaid.total)} and check in</button>}
          <button className={unpaid ? 'block' : 'primary block'} onClick={again}>{unpaid ? 'Scan another ticket' : 'Try again'}</button>
          {paying && <SettleModal ctx={ctx} record={paying} onClose={() => setPaying(null)} onPaid={() => check(lastCode)} />}
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
