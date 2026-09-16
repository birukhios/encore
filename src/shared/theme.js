function mix(hex, other, weight) {
  const a = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const b = [1, 3, 5].map(i => parseInt(other.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v * (1 - weight) + b[i] * weight).toString(16).padStart(2, '0')).join('');
}

let media;
let listener;

/** Apply organizer theme tokens. `mode` is ignored for the admin app, which stays light. */
export function applyTheme({ accent = '#E61E32', mode = 'light' } = {}, { allowMode = true } = {}) {
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
