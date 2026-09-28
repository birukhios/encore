import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Scanner from '../../shared/Scanner';
import { ErrorText, Icon, Modal } from '../../shared/ui';

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

export function SettleModal({ ctx, record, onClose }) {
  const [method, setMethod] = useState('Cash');
  const { busy, error, run } = useRunner();
  return (
    <Modal title="Record payment" eyebrow={record.ref} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => run(async () => { await ctx.action('settle', { id: record.id, method }); onClose(); })}>{busy ? 'Saving…' : `Confirm ${ctx.money(record.total)} received`}</button></>}>
      <p><b style={{ color: 'var(--ink)' }}>{record.name}</b> · {record.qty ? `${record.qty} ticket${record.qty > 1 ? 's' : ''} for ${record.eventName}` : record.items}</p>
      <p className="notice">Collect <b>{ctx.money(record.total)}</b> in person before confirming. This records the payment — it does not charge the guest.</p>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

export function TicketScan({ ctx, onClose }) {
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
