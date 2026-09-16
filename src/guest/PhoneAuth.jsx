import React, { useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { ErrorText, Icon, Modal } from '../shared/ui';

/**
 * Phone sign-up / sign-in in one flow: number → SMS code → (new guests) name + terms.
 * The server decides whether the number belongs to an existing guest.
 */
export default function PhoneAuth({ reason, onClose, onSignedIn, openTerms }) {
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('');
  const [e164, setE164] = useState('');
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [name, setName] = useState('');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);
  const [demoCode, setDemoCode] = useState('');
  const boxes = useRef([]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(w => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const code = digits.join('');

  async function send(e) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const out = await api('guest/otp', { phone });
      setE164(out.phone);
      setDemoCode(out.demoCode || '');
      setWait(out.resendIn);
      setDigits(['', '', '', '', '', '']);
      setStep('code');
      setTimeout(() => boxes.current[0]?.focus(), 50);
    } catch (err) {
      const seconds = /(\d+) seconds/.exec(err.message);
      if (err.code === 'OTP_WAIT' && e164) { setStep('code'); setWait(Number(seconds?.[1] || 60)); }
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(withName) {
    setBusy(true);
    setError('');
    try {
      const out = await api('guest/verify', { phone: e164, code, ...(withName ? { name, acceptTerms: accept } : {}) });
      if (out.needsName) {
        setStep('name');
      } else {
        onSignedIn(out.guest, !!withName);
      }
    } catch (err) {
      setError(err.message);
      if (/expired|Too many/.test(err.message)) setStep('code');
    } finally {
      setBusy(false);
    }
  }

  function typeDigit(i, value) {
    const clean = value.replace(/\D/g, '');
    if (clean.length > 1) {
      const next = clean.slice(0, 6).split('');
      setDigits([...next, ...Array(6 - next.length).fill('')]);
      boxes.current[Math.min(5, next.length)]?.focus();
      return;
    }
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    if (clean && i < 5) boxes.current[i + 1]?.focus();
  }

  useEffect(() => {
    if (step === 'code' && code.length === 6 && !busy) verify(false);
  }, [code]);

  const titles = { phone: 'Sign in with your phone', code: 'Enter your code', name: 'Welcome to Encore' };
  return (
    <Modal sheet title={titles[step]} eyebrow={step === 'phone' ? reason || 'Your tickets, orders & updates' : undefined} onClose={onClose}>
      {step === 'phone' && (
        <form className="form" onSubmit={send}>
          <p>New or returning, just enter your mobile number. We'll text you a 6-digit code.</p>
          <label className="field">Mobile number
            <div className="phoneinput">
              <span>🇪🇹 +251</span>
              <input type="tel" inputMode="tel" autoComplete="tel" placeholder="0911 234 567" value={phone} onChange={e => setPhone(e.target.value)} required aria-describedby="phone-hint" />
            </div>
            <small id="phone-hint">Numbers from other countries: start with + and the country code.</small>
          </label>
          <ErrorText>{error}</ErrorText>
          <button className="primary lg-btn block" disabled={busy || phone.replace(/\D/g, '').length < 9}>{busy ? 'Sending code…' : 'Send code'}<Icon name="next" /></button>
          <p className="footnote center">Standard SMS rates may apply.</p>
        </form>
      )}
      {step === 'code' && (
        <form className="form" onSubmit={e => { e.preventDefault(); if (code.length === 6) verify(false); }}>
          {demoCode && (
            <div className="notice warning row spread wrap" role="status">
              <span>Demo sign-in — no SMS is sent. Your code is <b style={{ letterSpacing: 2 }}>{demoCode}</b></span>
              <button type="button" className="primary" onClick={() => setDigits(demoCode.split(''))}>Use code</button>
            </div>
          )}
          <p>{demoCode ? 'Demo code for' : 'We sent a code to'} <b style={{ color: 'var(--ink)' }}>{e164}</b>. <button type="button" className="linklike" onClick={() => { setStep('phone'); setError(''); }}>Change number</button></p>
          <div className="otp" role="group" aria-label="6-digit code">
            {digits.map((d, i) => (
              <input key={i} ref={el => (boxes.current[i] = el)} value={d} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={i === 0 ? 6 : 1}
                aria-label={`Digit ${i + 1}`} onChange={e => typeDigit(i, e.target.value)}
                onKeyDown={e => { if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus(); }} />
            ))}
          </div>
          <ErrorText>{error}</ErrorText>
          <button className="primary lg-btn block" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Continue'}</button>
          <p className="center small">
            {wait > 0 ? <span className="muted">Resend code in {wait}s</span> : <button type="button" className="linklike" onClick={send} disabled={busy}>Resend code</button>}
          </p>
          <p className="footnote center">Never share this code. Staff will never ask for it.</p>
        </form>
      )}
      {step === 'name' && (
        <form className="form" onSubmit={e => { e.preventDefault(); verify(true); }}>
          <p>Your number is verified. What should staff call you when you arrive?</p>
          <label className="field">Your name<input value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={80} required autoFocus /></label>
          <label className="checkline">
            <input type="checkbox" checked={accept} onChange={e => setAccept(e.target.checked)} required />
            <span>I agree to the <button type="button" className="linklike" onClick={openTerms}>Terms & Privacy</button>.</span>
          </label>
          <ErrorText>{error}</ErrorText>
          <button className="primary lg-btn block" disabled={busy || !name.trim() || !accept}>{busy ? 'Creating account…' : 'Create account'}</button>
        </form>
      )}
    </Modal>
  );
}
