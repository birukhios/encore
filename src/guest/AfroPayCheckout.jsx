import React, { useState } from 'react';
import { money } from '../shared/api';

const WALLETS = [['telebirr', 'Telebirr'], ['cbe-birr', 'CBE Birr'], ['mpesa', 'M-PESA'], ['awash-birr', 'Awash Birr']];

/** Provider-styled review screen. Online payment fails closed on the server; the venue option creates an unpaid reservation. */
export default function AfroPayCheckout({ quote, payload, onBack, onClose, onPay, onVenue, venueEnabled = true, demo = false }) {
  const [wallet, setWallet] = useState('telebirr');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [venueBusy, setVenueBusy] = useState(false);
  const [error, setError] = useState('');
  const amount = n => money(n, quote.currency);
  const booking = payload.kind === 'booking';

  async function pay(e) {
    e.preventDefault();
    setError('');
    const normalized = phone.replace(/[\s()-]/g, '').replace(/^\+?251/, '').replace(/^0/, '');
    if (!/^[79]\d{8}$/.test(normalized)) return setError('Enter a valid Ethiopian mobile number.');
    setBusy(true);
    try {
      await onPay({ ...payload, wallet, phone: '+251' + normalized });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function venue() {
    setError('');
    setVenueBusy(true);
    try {
      await onVenue(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setVenueBusy(false);
    }
  }

  return (
    <div className="overlay afro-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="afro-checkout" role="dialog" aria-modal="true" aria-label="Checkout">
        <div className="afro-top"><b>afropay</b><button aria-label="Close checkout" onClick={onClose}>×</button></div>
        <div className="afro-merchant"><small>Paying</small><strong>{quote.merchant}</strong>{quote.tableName && <span>{quote.tableName}</span>}</div>
        <form onSubmit={pay}>
          {demo
            ? <p className="notice" role="status"><b>Demo mode.</b> Paying online simulates a successful wallet payment — no money moves and no wallet is contacted.</p>
            : <p className="notice" role="status">Online wallet payments are not available yet, so no payment will be taken here.{venueEnabled ? ' You can reserve now and pay at the venue.' : ''}</p>}
          <h2 style={{ marginTop: 22 }}>Review your {booking ? 'booking' : 'order'}</h2>
          <div className="afro-lines">
            {quote.lines.map((line, i) => <div key={i}><span>{line.qty} × {line.name}</span><b>{amount(line.total)}</b></div>)}
            {quote.tax && <div><span>{quote.tax.label} {quote.tax.included ? '(included in prices)' : ''}</span><b>{amount(quote.tax.amount)}</b></div>}
            {!booking && <div><span>Tip</span><b>{amount(quote.tip)}</b></div>}
            <div><span>Processing fee</span><b>{quote.fee === null ? 'Not yet available' : amount(quote.fee)}</b></div>
            <div className="afro-total"><strong>{quote.fee === null ? 'Subtotal' + (quote.tip ? ' including tip' : '') : 'Total'}</strong><strong>{amount(quote.total)}</strong></div>
          </div>
          {venueEnabled && (
            <div className="venue-option">
              <p>Reserve now and pay {booking ? 'at the entrance' : 'when your order arrives'}. {booking ? 'Your tickets are confirmed right away; staff mark them paid when you pay.' : 'Your order is confirmed right away; staff mark it paid when you pay.'}</p>
              <button type="button" className="afro-venue" disabled={venueBusy} onClick={venue}>{venueBusy ? 'Reserving…' : `Reserve · pay ${amount(quote.total)} at the venue`}</button>
            </div>
          )}
          {error && <p className="error" role="alert" style={{ marginTop: 16 }}>{error}</p>}
          <fieldset>
            <legend>Pay online with a wallet</legend>
            <div className="wallets">
              {WALLETS.map(([id, name]) => (
                <label key={id} className={wallet === id ? 'chosen' : ''}>
                  <input type="radio" name="wallet" value={id} checked={wallet === id} onChange={() => setWallet(id)} />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="afro-phone-label">Wallet mobile number
            <div className="afro-phone"><span>+251</span><input aria-label="Wallet mobile number" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="0912345678" value={phone} onChange={e => setPhone(e.target.value)} /></div>
          </label>
          <button className="afro-pay" disabled={busy}>{busy ? (demo ? 'Simulating payment…' : 'Connecting…') : (demo ? 'Pay (demo) · ' : 'Pay online · ') + amount(quote.total)}</button>
          <p className="afro-foot">Review any provider fees before authorizing payment. Never share your wallet PIN or one-time code.</p>
          <button type="button" className="afro-back" onClick={onBack}>Back to {booking ? 'booking' : 'order'}</button>
        </form>
      </section>
    </div>
  );
}
