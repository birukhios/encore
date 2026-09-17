import React, { useState } from 'react';
import { money } from '../shared/api';
import { Glyph } from '../shared/ui';

const WALLETS = [['telebirr', 'Telebirr'], ['cbe-birr', 'CBE Birr'], ['mpesa', 'M-PESA'], ['awash-birr', 'Awash Birr']];
const LOGO_TYPES = ['png', 'svg', 'webp', 'jpg'];

/** Shows /wallets/<id>.<ext> when the organizer has added the official logo file, otherwise the wallet name. */
function WalletLogo({ id, name }) {
  const [attempt, setAttempt] = useState(0);
  if (attempt >= LOGO_TYPES.length) return <span>{name}</span>;
  return <img className="wallet-logo" src={`/wallets/${id}.${LOGO_TYPES[attempt]}`} alt={name} onError={() => setAttempt(a => a + 1)} />;
}

/** Provider-styled review screen. All payments are online; the server fails closed until AfroPay is configured (demo mode simulates it). */
export default function AfroPayCheckout({ quote, payload, onBack, onClose, onPay, demo = false }) {
  const [wallet, setWallet] = useState('telebirr');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
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



  return (
    <div className="overlay afro-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="afro-checkout" role="dialog" aria-modal="true" aria-label="Checkout">
        <div className="afro-top"><b>afropay</b><button aria-label="Close checkout" onClick={onClose}><Glyph name="x" size={22} /></button></div>
        <div className="afro-merchant"><small>Paying</small><strong>{quote.merchant}</strong>{quote.tableName && <span>{quote.tableName}</span>}</div>
        <form onSubmit={pay}>
          {demo
            ? <p className="notice" role="status"><b>Demo mode.</b> Paying online simulates a successful wallet payment — no money moves and no wallet is contacted.</p>
            : <p className="notice" role="status">Online wallet payments are not available yet, so no payment will be taken here.</p>}
          <h2 style={{ marginTop: 22 }}>Review your {booking ? 'booking' : 'order'}</h2>
          <div className="afro-lines">
            {quote.lines.map((line, i) => <div key={i}><span>{line.qty} × {line.name}</span><b>{amount(line.total)}</b></div>)}
            {quote.lines.length > 1 && <div><span>Subtotal</span><b>{amount(quote.subtotal)}</b></div>}
            {quote.service && <div><span>{quote.service.label}</span><b>+ {amount(quote.service.amount)}</b></div>}
            {quote.tax && <div><span>{quote.tax.label}{quote.tax.included ? ' (included in prices)' : ''}</span><b>{quote.tax.included ? '' : '+ '}{amount(quote.tax.amount)}</b></div>}
            {!booking && quote.tip > 0 && <div><span>Tip{quote.waiter ? ` for ${quote.waiter.name}` : ''}</span><b>+ {amount(quote.tip)}</b></div>}
            <div className="afro-total"><strong>Total</strong><strong>{amount(quote.total)}</strong></div>
          </div>
          {error && <p className="error" role="alert" style={{ marginTop: 16 }}>{error}</p>}
          <fieldset>
            <legend className="afro-legend">Choose your wallet</legend>
            <div className="wallets">
              {WALLETS.map(([id, name]) => (
                <label key={id} className={wallet === id ? 'chosen' : ''}>
                  <input type="radio" name="wallet" value={id} checked={wallet === id} onChange={() => setWallet(id)} />
                  <WalletLogo id={id} name={name} />
                </label>
              ))}
            </div>
          </fieldset>
          <label className="afro-phone-label">Wallet mobile number
            <div className="afro-phone"><span>+251</span><input aria-label="Wallet mobile number" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="0912345678" value={phone} onChange={e => setPhone(e.target.value)} /></div>
          </label>
          <button className="afro-pay" disabled={busy}>{busy ? (demo ? 'Simulating payment…' : 'Connecting…') : (demo ? 'Pay (demo) · ' : 'Pay online · ') + amount(quote.total)}</button>
          <p className="afro-foot">Never share your wallet PIN or one-time code.</p>
          <button type="button" className="afro-back" onClick={onBack}>Back to {booking ? 'booking' : 'order'}</button>
        </form>
      </section>
    </div>
  );
}
