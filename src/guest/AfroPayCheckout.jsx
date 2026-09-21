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

/** Review and pay. Online wallet payments fail closed until AfroPay is connected; cash is recorded by staff. */
export default function AfroPayCheckout({ quote, payload, onBack, onClose, onPay, onCash, cashAllowed = false, paymentsReady = false }) {
  const [method, setMethod] = useState(paymentsReady ? 'wallet' : 'cash');
  const [wallet, setWallet] = useState('telebirr');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amount = n => money(n, quote.currency);
  const booking = payload.kind === 'booking';

  async function pay(e) {
    e.preventDefault();
    setError('');
    if (method === 'cash') {
      setBusy(true);
      try {
        await onCash(payload);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
      return;
    }
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
          {method === 'cash'
            ? <p className="notice" role="status"><b>Pay with cash.</b> {booking ? `Your tickets are reserved now. Pay ${amount(quote.total)} at the entrance — staff check you in once it is paid.` : `Your order goes to the kitchen now. Pay your waiter ${amount(quote.total)} when it arrives.`}</p>
            : <p className="notice warning" role="status">Online wallet payments are not available yet. {cashAllowed ? 'Choose Cash to continue.' : 'Please ask staff how to pay.'}</p>}
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
          {cashAllowed && (
            <fieldset className="pay-choice">
              <legend className="afro-legend">How would you like to pay?</legend>
              <div className="pay-choice-options">
                <label className={(method === 'wallet' ? 'chosen' : '') + (paymentsReady ? '' : ' disabled')} aria-disabled={!paymentsReady}><input type="radio" name="method" disabled={!paymentsReady} checked={method === 'wallet'} onChange={() => setMethod('wallet')} /><b>Mobile wallet</b><small>{paymentsReady ? 'Pay now' : 'Not available yet'}</small></label>
                <label className={method === 'cash' ? 'chosen' : ''}><input type="radio" name="method" checked={method === 'cash'} onChange={() => setMethod('cash')} /><b>Cash</b><small>{booking ? 'Pay at the entrance' : 'Pay your waiter'}</small></label>
              </div>
            </fieldset>
          )}
          {method === 'wallet' && <>
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
          </>}
          {method === 'cash'
            ? <button className="afro-pay cash" disabled={busy}>{busy ? (booking ? 'Reserving…' : 'Placing order…') : (booking ? 'Reserve · pay ' : 'Place order · pay cash ') + amount(quote.total)}</button>
            : <button className="afro-pay" disabled={busy || !paymentsReady}>{busy ? 'Connecting…' : 'Pay online · ' + amount(quote.total)}</button>}
          {method === 'wallet' && <p className="afro-foot">Never share your wallet PIN or one-time code.</p>}
          <button type="button" className="afro-back" onClick={onBack}>Back to {booking ? 'booking' : 'order'}</button>
        </form>
      </section>
    </div>
  );
}
