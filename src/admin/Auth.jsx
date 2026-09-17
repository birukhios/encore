import React, { useState } from 'react';
import { api } from '../shared/api';
import { ErrorText, Field, Icon } from '../shared/ui';
import Logo from '../shared/Logo';

export default function Auth({ onAuth }) {
  const path = location.pathname;
  const invite = new URLSearchParams(location.search).get('invite');
  const [view, setView] = useState(invite || path.includes('signup') ? 'signup' : path.includes('recover') ? 'recover' : 'signin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState('');

  function change(next) {
    setView(next);
    setError('');
    history.replaceState(null, '', '/admin/' + next + (invite ? '?invite=' + encodeURIComponent(invite) : ''));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = Object.fromEntries(new FormData(e.currentTarget));
    if (invite) data.invite = invite;
    try {
      const result = await api(view, data);
      if (view === 'recover') setRecovery(result.recovery);
      else {
        history.replaceState(null, '', '/admin');
        onAuth(result);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const heading = { signup: invite ? 'Join your team' : 'Create your workspace', recover: 'Recover your account', signin: 'Welcome back.' }[view];
  const sub = { signup: 'Set the stage for your next great event.', recover: 'Use the recovery code you saved when you created your account.', signin: 'Sign in to manage your events and your team.' }[view];

  return (
    <div className="auth-layout">
      <section className="auth-art">
        <Logo size={32} />
        <div>
          <span className="eyebrow">The backstage pass for organizers</span>
          <h1>Make every<br />night count.</h1>
          <p>From the first ticket to the final encore. Your team, your venue, one workspace.</p>
          <div className="auth-features">
            <span><Icon name="ticket" />Ticketing</span>
            <span><Icon name="table" />Table service</span>
            <span><Icon name="bell" />Guest updates</span>
          </div>
        </div>
        <small>Built for the people behind unforgettable nights.</small>
      </section>
      <section className="auth-main">
        <div className="auth-form">
          <div>
            <span className="eyebrow">Encore for organizers</span>
            <h1>{heading}</h1>
            <p style={{ marginTop: 8 }}>{sub}</p>
          </div>
          {recovery ? (
            <div className="stack">
              <p className="notice success">Your password was reset. Save your new recovery code — it replaces the old one.</p>
              <code className="recovery">{recovery}</code>
              <button className="primary lg-btn" onClick={() => { setRecovery(''); change('signin'); }}>Continue to sign in</button>
            </div>
          ) : (
            <form className="form" onSubmit={submit}>
              {view === 'signup' && (
                <>
                  <Field label="Full name" name="name" autoComplete="name" required />
                  {!invite && <Field label="Team or organization name" name="team" placeholder="Your organization" autoComplete="organization" required />}
                </>
              )}
              <Field label="Email address" name="email" type="email" autoComplete="email" placeholder="you@company.com" required />
              {view === 'recover' && <Field label="Recovery code" name="recovery" autoComplete="off" required />}
              <Field
                label={view === 'recover' ? 'New password' : 'Password'} name="password" type="password"
                autoComplete={view === 'signin' ? 'current-password' : 'new-password'} minLength={view === 'signin' ? 1 : 12} required
                hint={view !== 'signin' ? 'Use at least 12 characters.' : undefined}
              />
              {view === 'signin' && <button type="button" className="linklike" style={{ justifySelf: 'start' }} onClick={() => change('recover')}>Forgot password?</button>}
              <ErrorText>{error}</ErrorText>
              <button className="primary lg-btn" disabled={busy}>
                {busy ? 'Please wait…' : view === 'signup' ? 'Create account' : view === 'recover' ? 'Reset password' : 'Sign in'}
                <Icon name="next" />
              </button>
            </form>
          )}
          {!invite && (
            <p className="center small">
              {view === 'signin' ? 'New to Encore? ' : 'Already have an account? '}
              <button className="linklike" onClick={() => change(view === 'signin' ? 'signup' : 'signin')}>{view === 'signin' ? 'Create a workspace' : 'Sign in'}</button>
            </p>
          )}
        </div>
        <small className="auth-foot">Your events. Your audience. Your Encore.</small>
      </section>
    </div>
  );
}
