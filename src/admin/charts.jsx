import React, { useMemo, useState } from 'react';
import { Icon } from '../shared/ui';
import { DAY_NAMES } from './reportData';

export const pct = (n, digits = 0) => `${(n * 100).toFixed(digits)}%`;
export const hourLabel = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
const shortDay = iso => new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const PALETTE = ['var(--accent)', 'var(--ink)', 'var(--steel)', '#F5B301', '#1F7A3D', '#5B6CFF', '#9B51E0', '#00A3A3'];
export const color = i => PALETTE[i % PALETTE.length];

/** Period-over-period change. `invert` for metrics where lower is better. */
export function Delta({ value, invert = false, label = 'vs previous period' }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.005;
  const good = flat ? null : (value > 0) !== invert;
  return (
    <span className={'delta ' + (flat ? 'flat' : good ? 'up' : 'down')} title={label}>
      <span aria-hidden="true">{flat ? '→' : value > 0 ? '↑' : '↓'}</span>
      {pct(Math.abs(value))}
      <span className="sr-only">{value > 0 ? 'increase' : 'decrease'} {label}</span>
    </span>
  );
}

export function Kpi({ label, value, delta, invert, hint, icon, spark, tone }) {
  return (
    <article className={'kpi' + (tone ? ' ' + tone : '')}>
      <div className="kpi-top"><span>{label}</span>{icon && <Icon name={icon} />}</div>
      <strong>{value}</strong>
      <div className="kpi-foot">
        <Delta value={delta} invert={invert} />
        {hint && <small>{hint}</small>}
      </div>
      {spark && spark.length > 1 && <Sparkline values={spark} />}
    </article>
  );
}

export function Sparkline({ values, height = 34 }) {
  const max = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(height - (v / max) * (height - 4) - 2).toFixed(2)}`).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${height} ${points} 100,${height}`} className="spark-area" />
      <polyline points={points} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const niceMax = v => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= v);
};

/** Stacked daily columns with gridlines. series: [{ key, label }]. */
export function TrendChart({ rows, series, format = v => v, height = 220, label }) {
  const [hover, setHover] = useState(null);
  const totals = rows.map(r => series.reduce((t, s) => t + (r[s.key] || 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const every = Math.max(1, Math.ceil(rows.length / 10));
  const active = hover === null ? null : rows[hover];
  return (
    <figure className="trend" aria-label={label}>
      <div className="trend-legend">
        {series.map((s, i) => <span key={s.key}><i style={{ background: color(i) }} />{s.label}</span>)}
        <span className="trend-readout" aria-live="polite">
          {active ? <><b>{shortDay(active.date)}</b> {series.map(s => `${s.label} ${format(active[s.key] || 0)}`).join(' · ')}</> : <span className="muted">Hover a day for details</span>}
        </span>
      </div>
      <div className="trend-body" style={{ height }}>
        <div className="trend-axis" aria-hidden="true">
          {[1, 0.5, 0].map(f => <span key={f}>{format(top * f)}</span>)}
        </div>
        <div className="trend-plot">
          <div className="trend-grid" aria-hidden="true"><i /><i /><i /></div>
          <div className="trend-cols">
            {rows.map((r, i) => (
              <button type="button" key={r.date} className={'trend-col' + (hover === i ? ' on' : '')} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onMouseLeave={() => setHover(null)}
                aria-label={`${shortDay(r.date)}: ${series.map(s => `${s.label} ${format(r[s.key] || 0)}`).join(', ')}`}>
                <span className="trend-stack">
                  {series.map((s, si) => <span key={s.key} style={{ height: `${((r[s.key] || 0) / top) * 100}%`, background: color(si) }} />)}
                </span>
                <small>{i % every === 0 ? shortDay(r.date) : ''}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

export function Bars({ rows, value, label, format, max }) {
  const top = max ?? Math.max(1, ...rows.map(value));
  return (
    <div className="bars" role="list">
      {rows.map((r, i) => (
        <div className="bar-row" role="listitem" key={i}>
          <span className="bar-label">{label(r)}</span>
          <span className="bar-track" aria-hidden="true"><span style={{ width: `${(value(r) / top) * 100}%` }} /></span>
          <b className="bar-value">{format ? format(value(r), r) : value(r)}</b>
        </div>
      ))}
    </div>
  );
}

export function Donut({ parts, format = v => v, center }) {
  const total = parts.reduce((t, p) => t + p.value, 0);
  let offset = 0;
  const R = 15.915;  // circumference 100
  return (
    <div className="donut">
      <svg viewBox="0 0 42 42" role="img" aria-label={parts.map(p => `${p.label} ${total ? Math.round((p.value / total) * 100) : 0}%`).join(', ')}>
        <circle cx="21" cy="21" r={R} fill="none" stroke="var(--canvas)" strokeWidth="6" />
        {total > 0 && parts.map((p, i) => {
          const share = (p.value / total) * 100;
          const el = <circle key={p.label} cx="21" cy="21" r={R} fill="none" stroke={color(i)} strokeWidth="6" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={25 - offset} />;
          offset += share;
          return el;
        })}
        {center && <text x="21" y="22.5" textAnchor="middle" className="donut-center">{center}</text>}
      </svg>
      <ul>
        {parts.map((p, i) => (
          <li key={p.label}><i style={{ background: color(i) }} /><span>{p.label}</span><b>{format(p.value)}</b><small>{total ? pct(p.value / total) : '0%'}</small></li>
        ))}
      </ul>
    </div>
  );
}

/** Day-of-week × hour grid. Only hours with any activity (plus neighbours) are shown to keep it readable. */
export function Heatmap({ grid, unit = 'orders' }) {
  const max = Math.max(1, ...grid.flat());
  const used = grid[0].map((_, h) => grid.some(row => row[h] > 0));
  let hours = used.map((u, h) => (u || used[h - 1] || used[h + 1] ? h : null)).filter(h => h !== null);
  if (!hours.length) hours = Array.from({ length: 24 }, (_, h) => h);
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="heatmap-wrap">
      <table className="heatmap">
        <thead><tr><th /><>{hours.map(h => <th key={h} scope="col">{hourLabel(h).replace(':00', '')}</th>)}</></tr></thead>
        <tbody>
          {order.map(d => (
            <tr key={d}>
              <th scope="row">{DAY_NAMES[d]}</th>
              {hours.map(h => {
                const v = grid[d][h];
                return <td key={h} title={`${DAY_NAMES[d]} ${hourLabel(h)}: ${v} ${unit}`} style={{ '--heat': v ? 0.12 + (v / max) * 0.88 : 0 }}><span className="sr-only">{v}</span></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="heat-scale" aria-hidden="true"><small>Fewer</small><i style={{ '--heat': 0.15 }} /><i style={{ '--heat': 0.45 }} /><i style={{ '--heat': 0.75 }} /><i style={{ '--heat': 1 }} /><small>More {unit}</small></div>
    </div>
  );
}

/**
 * Sortable table. columns: [{ key, label, num?, render?(row), value?(row) }].
 * value() is used for sorting (defaults to row[key]).
 */
export function DataTable({ columns, rows, sort: initial, limit = 10, empty = 'No data for this period.', rank = false, onRow }) {
  const [sort, setSort] = useState(initial || { key: columns[0].key, dir: 'desc' });
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort.key) || columns[0];
    const get = col.value || (r => r[col.key]);
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      const cmp = typeof x === 'string' ? x.localeCompare(y) : (x ?? 0) - (y ?? 0);
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);
  const shown = all ? sorted : sorted.slice(0, limit);
  if (!rows.length) return <p className="small muted table-empty">{empty}</p>;
  return (
    <>
      <div className="table-scroll">
        <table className="report-table">
          <thead>
            <tr>
              {rank && <th className="num rank">#</th>}
              {columns.map(c => (
                <th key={c.key} className={c.num ? 'num' : ''} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="sort" onClick={() => setSort(s => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
                    {c.label}<span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={r.id || r.key || r.name || i} className={onRow ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined}>
                {rank && <td className="num rank">{i + 1}</td>}
                {columns.map(c => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && <button type="button" className="linklike small table-more" onClick={() => setAll(a => !a)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </>
  );
}

export function Insights({ items, limit = 6 }) {
  if (!items.length) return null;
  return (
    <ul className="insights">
      {items.slice(0, limit).map((x, i) => (
        <li key={i} className={x.tone}>
          <span className="insight-dot" aria-hidden="true" />
          <div><b>{x.title}</b><p>{x.body}</p></div>
        </li>
      ))}
    </ul>
  );
}
