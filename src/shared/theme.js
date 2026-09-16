function mix(hex, other, weight) {
  const a = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const b = [1, 3, 5].map(i => parseInt(other.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v * (1 - weight) + b[i] * weight).toString(16).padStart(2, '0')).join('');
}

let media;
let listener;
let last = [{}, {}];

const KEY = 'encore_mode_override';
export function getModeOverride() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}
/** Store a per-device 'light' | 'dark' choice (or '' to follow the organizer's setting) and re-apply. */
export function setModeOverride(mode) {
  try { mode ? localStorage.setItem(KEY, mode) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  applyTheme(...last);
}
export const currentMode = () => document.documentElement.dataset.mode || 'light';

/** Apply organizer theme tokens. `mode` is ignored for the admin app, which stays light. */
export function applyTheme(theme = {}, options = {}) {
  last = [theme, options];
  const { accent = '#E61E32' } = theme;
  const mode = getModeOverride() || theme.mode || 'light';
  const { allowMode = true } = options;
  const root = document.documentElement;
  const valid = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#E61E32';
  root.style.setProperty('--accent', valid);
  root.style.setProperty('--accent-strong', mix(valid, '#000000', 0.15));
  root.style.setProperty('--accent-soft', mix(valid, '#ffffff', 0.92));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', valid);
  if (media && listener) media.removeEventListener('change', listener);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(valid.slice(i, i + 2), 16) / 255);
  const nearBlack = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.12;
  const resolve = () => {
    const dark = allowMode && (mode === 'dark' || (mode === 'system' && media.matches));
    root.dataset.mode = dark ? 'dark' : 'light';
    const accent = dark && nearBlack ? '#F4F4F6' : valid;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-strong', dark && nearBlack ? '#D6D6DC' : mix(valid, '#000000', 0.15));
    root.style.setProperty('--on-accent', dark && nearBlack ? '#0B0B0E' : '#FFFFFF');
    if (!dark) root.style.setProperty('--accent-soft', mix(valid, '#ffffff', 0.92));
    else root.style.removeProperty('--accent-soft');
  };
  media = window.matchMedia('(prefers-color-scheme: dark)');
  listener = resolve;
  if (allowMode && mode === 'system') media.addEventListener('change', listener);
  resolve();
}
