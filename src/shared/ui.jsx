import React, { useEffect, useRef, useState } from 'react';
import icons from '../icons.json';

export const ICONS = {
  add: 972, next: 1041, back: 1014, down: 1048, bell: 1003, search: 1045, calendar: 1054, wallet: 1060, money: 1066,
  clock: 1077, more: 1080, table: 1082, team: 1085, ticket: 1093, download: 1098, support: 1101, menu: 1134, chart: 1149,
  edit: 1190, copy: 1196, brand: 1199, theme: 1207, refresh: 1213, pencil: 1216, settings: 1220, venue: 1227,
  screen: 1237, check: 1242, grid: 1247, success: 1252, up: 1145, filter: 1050,
};

// Small vector glyphs for controls the extracted Figma set lacks (no emoji or text symbols as icons).
const GLYPHS = {
  x: <path d="M6 6l12 12M18 6L6 18" />,
  'chevron-left': <path d="M15 5l-7 7 7 7" />,
  'chevron-right': <path d="M9 5l7 7-7 7" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
};

export function Glyph({ name, size = 20 }) {
  return (
    <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[name]}
    </svg>
  );
}

export function StarIcon({ filled = 1, size = 16 }) {
  const id = React.useId();
  return (
    <svg className="star" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs><linearGradient id={id}><stop offset={filled} stopColor="#F5B301" /><stop offset={filled} stopColor="currentColor" /></linearGradient></defs>
      <path fill={`url(#${id})`} d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
    </svg>
  );
}

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
      <Glyph name={dark ? 'sun' : 'moon'} />
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
            {onClose && <button className="close" aria-label="Close" onClick={onClose}><Glyph name="x" /></button>}
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

/**
 * Catches a rendering crash so the whole app never goes blank.
 * Shows what happened, keeps the page usable, and offers a reload.
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Encore crashed while rendering:', error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <Icon name="support" />
          <h1>Something went wrong on this screen</h1>
          <p>The rest of Encore is fine. Reload to continue — your data was not affected.</p>
          <div className="row center wrap">
            <button className="primary lg-btn" onClick={() => location.reload()}><Icon name="refresh" />Reload</button>
            {this.props.home !== false && <button className="lg-btn" onClick={() => { location.href = this.props.homeHref || '/'; }}>Go to the start</button>}
          </div>
          <details><summary>Technical details</summary><code>{String(this.state.error?.message || this.state.error)}</code></details>
        </div>
      </div>
    );
  }
}

/** Grey placeholder while content loads. `lines` stacked bars, or a card/table shape. */
export function Skeleton({ lines = 3, className = '', height }) {
  return (
    <div className={'skeleton ' + className} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} style={height ? { height } : undefined} />)}
    </div>
  );
}

export function SkeletonCards({ count = 4, className = 'kpis' }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <div className="card skeleton-card" key={i}><Skeleton lines={3} /></div>)}
    </div>
  );
}

/** Full-screen or in-place loading state with a label screen readers announce. */
export function Loading({ label = 'Loading…', inline = false, skeleton = null }) {
  if (skeleton) return <div className="loading-skeleton" role="status" aria-label={label}>{skeleton}</div>;
  return <div className={'loading' + (inline ? ' inline' : '')} role="status"><Spinner />{label}</div>;
}

/** A failed load: says what happened and offers the action that fixes it. */
export function ErrorState({ title = 'That did not load', message, onRetry, retryLabel = 'Try again', children }) {
  return (
    <div className="errorstate" role="alert">
      <span className="errorstate-mark"><Icon name="support" /></span>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      <div className="row center wrap">
        {onRetry && <button className="primary" onClick={onRetry}><Icon name="refresh" />{retryLabel}</button>}
        {children}
      </div>
    </div>
  );
}

/** True while the browser reports a network connection. */
export function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/** Fixed bar shown only while the device is offline. */
export function OfflineBar() {
  const online = useOnline();
  if (online) return null;
  return <div className="offlinebar" role="status"><Icon name="refresh" />You are offline. Encore will work again as soon as your connection returns.</div>;
}
