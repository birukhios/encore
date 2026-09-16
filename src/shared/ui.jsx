import React, { useEffect, useRef, useState } from 'react';
import icons from '../icons.json';

export const ICONS = {
  add: 972, next: 1041, back: 1014, down: 1048, bell: 1003, search: 1045, calendar: 1054, wallet: 1060, money: 1066,
  clock: 1077, more: 1080, table: 1082, team: 1085, ticket: 1093, download: 1098, support: 1101, menu: 1134, chart: 1149,
  edit: 1190, copy: 1196, brand: 1199, theme: 1207, refresh: 1213, pencil: 1216, settings: 1220, venue: 1227,
  screen: 1237, check: 1242, grid: 1247, success: 1252, up: 1145, filter: 1050,
};

export function Icon({ name, id, size = '' }) {
  const svg = icons[id ?? ICONS[name]] || icons[1247];
  return <span className={'icon ' + size} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function ModeToggle({ onChange }) {
  const [, force] = useState(0);
  const dark = document.documentElement.dataset.mode === 'dark';
  return (
    <button className="icon-btn" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}
      onClick={async () => {
        const { setModeOverride } = await import('./theme');
        setModeOverride(dark ? 'light' : 'dark');
        force(n => n + 1);
        onChange?.();
      }}>
      <span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>{dark ? '☀' : '☾'}</span>
    </button>
  );
}

export function Avatar({ name = '', src, size = 36, className = '' }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('') || '?';
  return (
    <span className={'avatar ' + className} style={{ width: size, height: size, fontSize: Math.max(11, size * 0.38) }} aria-hidden={!src}>
      {src ? <img src={src} alt={name} /> : initials}
    </span>
  );
}

export function Field({ label, hint, children, ...props }) {
  return (
    <label className="field">
      {label}
      {children || <input {...props} />}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Toggle({ label, description, checked, onChange, disabled, name }) {
  return (
    <label className="toggle">
      <span className="grow">
        <b>{label}</b>
        {description && <span className="hint">{description}</span>}
      </span>
      <input type="checkbox" role="switch" name={name} checked={!!checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

export function Empty({ icon = 'calendar', title, body, action, onAction }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action && <button className="primary" onClick={onAction}>{action}</button>}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function ErrorText({ children }) {
  return children ? <p className="error" role="alert">{children}</p> : null;
}

/** Accessible dialog: Escape and backdrop close it, focus moves inside, background scroll locks. */
export function Modal({ title, eyebrow, onClose, children, footer, wide, sheet, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const onKey = e => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = ref.current?.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    (focusable || ref.current)?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div className={'overlay' + (sheet ? ' sheet-overlay' : '')} onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <section ref={ref} tabIndex={-1} className={(sheet ? 'sheet' : 'dialog') + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={label || title}>
        {sheet && <div className="grabber" aria-hidden="true" />}
        {(title || onClose) && (
          <header className="dialog-head">
            <div className="grow">
              {eyebrow && <span className="eyebrow accent">{eyebrow}</span>}
              {title && <h2>{title}</h2>}
            </div>
            {onClose && <button className="close" aria-label="Close" onClick={onClose}>×</button>}
          </header>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </section>
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef();
  const show = (message, kind = 'info') => {
    clearTimeout(timer.current);
    setToast({ message, kind });
    timer.current = setTimeout(() => setToast(null), 4000);
  };
  const node = toast && (
    <div className={'toast' + (toast.kind === 'error' ? ' error-toast' : '')} role="status" aria-live="polite">
      {toast.kind !== 'error' && <Icon name="success" />}
      {toast.message}
    </div>
  );
  return [show, node];
}

export function usePolling(fn, ms, deps = []) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    let id;
    const tick = () => { if (document.visibilityState === 'visible') saved.current(); };
    id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, deps);
}

export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
