import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { dateTime, shortDate } from '../shared/api';
import { Empty, ErrorText, Field, Icon, Modal, Toggle } from '../shared/ui';
import { DataTable, Kpi, pct } from './charts';
import { PageActions } from './pages';
import { downloadText, isoDay, isSale, slug, toCsv } from './reportData';

/*
 * Service-floor tools: stock control, waiters with unique numbers, orders taken by staff, and printable order slips.
 * The server recalculates every price, checks stock and assigns waiter numbers; figures here are previews.
 */

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const DAY = 86400;

/** Shows `children` in the dialog and prints an identical copy placed directly in <body>, clear of app layout. */
function Printable({ className, children }) {
  return (
    <>
      <div className={className}>{children}</div>
      {createPortal(<div className="print-root"><div className={className}>{children}</div></div>, document.body)}
    </>
  );
}
const now = () => Date.now() / 1000;

/** Preview of the server's pricing: items, service charge, VAT on items + service, untaxed tip. */
export function priceOrder(state, subtotal, tip = 0) {
  const svc = state.settings.service;
  const service = svc?.enabled && subtotal > 0 ? Math.round((subtotal * svc.rate) / 100) : 0;
  const t = state.settings.tax;
  const taxable = subtotal + service;
  let vat = 0;
  let included = false;
  if (t.regime !== 'none' && t.menu && t.vatRate && taxable > 0) {
    included = !!t.pricesIncludeTax;
    vat = Math.round(included ? (taxable * t.vatRate) / (100 + t.vatRate) : (taxable * t.vatRate) / 100);
  }
  return { subtotal, service, serviceRate: svc?.rate, vat, vatRate: t.vatRate, included, tip, total: subtotal + service + (included ? 0 : vat) + tip };
}

// ---------------------------------------------------------------- Stock

export function Stock({ ctx }) {
  const { state, money, canManage } = ctx;
  const [adjusting, setAdjusting] = useState(null);
  const [filter, setFilter] = useState('all');
  const [logItem, setLogItem] = useState('all');
  const tracked = state.menu.filter(i => i.trackStock);
  const soldSince = useMemo(() => {
    const since = now() - 7 * DAY;
    const out = {};
    for (const o of state.orders.filter(isSale).filter(o => o.created >= since)) {
      for (const l of o.lines) {
        const key = l.id || state.menu.find(i => i.name === l.name)?.id;
        if (key) out[key] = (out[key] || 0) + l.qty;
      }
    }
    return out;
  }, [state.orders]);
  const rows = tracked.map(i => {
    const sold7 = soldSince[i.id] || 0;
    const perDay = sold7 / 7;
    const status = i.stock <= 0 ? 'out' : i.stock <= i.lowStock ? 'low' : 'ok';
    return { ...i, sold7, perDay, cover: perDay ? i.stock / perDay : null, value: i.stock * i.price, status };
  });
  const shown = rows.filter(r => filter === 'all' || r.status === filter);
  const low = rows.filter(r => r.status === 'low').length;
  const out = rows.filter(r => r.status === 'out').length;
  const log = [...(state.stockLog || [])].reverse().filter(x => logItem === 'all' || x.item === logItem);

  function exportCsv() {
    downloadText(`${slug(state.name)}-stock-${isoDay(new Date())}.csv`, toCsv([
      ['Item', 'Category', 'In stock', 'Low-stock alert', 'Status', 'Sold last 7 days', 'Days of cover', `Retail value (${state.currency})`],
      ...rows.map(r => [r.name, r.category, r.stock, r.lowStock, r.status === 'out' ? 'Out of stock' : r.status === 'low' ? 'Low' : 'OK', r.sold7, r.cover === null ? '' : r.cover.toFixed(1), (r.value / 100).toFixed(2)]),
      [], ['Stock movements'], ['When', 'Item', 'Change', 'After', 'Reason', 'By'],
      ...(state.stockLog || []).slice().reverse().map(x => [new Date(x.at * 1000).toISOString(), x.name, x.change, x.after, x.reason, x.by]),
    ]));
  }

  return (
    <>
      <PageActions>
        <button onClick={exportCsv} disabled={!rows.length}><Icon name="download" />CSV</button>
        {canManage && <button className="primary" onClick={() => ctx.go('Menu')}><Icon name="add" />Track an item</button>}
      </PageActions>
      <div className="kpis">
        <Kpi label="Items tracked" icon="menu" value={tracked.length} hint={`${state.menu.length - tracked.length} not tracked`} />
        <Kpi label="Low stock" icon="clock" value={low} tone={low ? 'warn' : ''} hint="At or below the alert level" />
        <Kpi label="Out of stock" icon="menu" value={out} tone={out ? 'bad' : ''} hint="Hidden from guests" />
        <Kpi label="Stock value" icon="wallet" value={money(rows.reduce((t, r) => t + r.value, 0))} hint="At menu prices" />
      </div>
      {!tracked.length ? (
        <section className="card"><Empty icon="menu" title="No items tracked yet" body="Open a menu item and turn on “Track stock” to count what you have. Orders then reduce stock automatically." action={canManage ? 'Go to menu' : null} onAction={() => ctx.go('Menu')} /></section>
      ) : (
        <section className="card">
          <div className="card-head">
            <div><h2>Stock levels</h2><p>Days of cover uses the last 7 days of paid orders.</p></div>
            <div className="segmented" role="group" aria-label="Filter stock">
              {[['all', 'All'], ['low', `Low ${low}`], ['out', `Out ${out}`]].map(([id, label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>)}
            </div>
          </div>
          <DataTable limit={50} sort={{ key: 'cover', dir: 'asc' }} rows={shown} empty="No items match." columns={[
            { key: 'name', label: 'Item', render: r => <><b>{r.name}</b><small>{r.category} · {money(r.price)}</small></> },
            { key: 'stock', label: 'In stock', num: true, render: r => <b className={'stock-count ' + r.status}>{r.stock}</b> },
            { key: 'status', label: 'Status', value: r => ({ out: 0, low: 1, ok: 2 })[r.status], render: r => <span className={'badge ' + (r.status === 'out' ? 'danger' : r.status === 'low' ? 'warning' : 'success')}>{r.status === 'out' ? 'Out of stock' : r.status === 'low' ? `Low (alert ${r.lowStock})` : 'In stock'}</span> },
            { key: 'sold7', label: 'Sold 7 days', num: true },
            { key: 'cover', label: 'Days of cover', num: true, value: r => (r.cover === null ? 9999 : r.cover), render: r => (r.cover === null ? '—' : r.cover < 1 ? '< 1 day' : `${r.cover.toFixed(1)} days`) },
            { key: 'value', label: 'Value', num: true, render: r => money(r.value) },
            ...(canManage ? [{ key: 'actions', label: '', num: true, value: () => 0, render: r => <button className="small-btn" onClick={e => { e.stopPropagation(); setAdjusting(r); }}>Adjust</button> }] : []),
          ]} />
        </section>
      )}
      <section className="card">
        <div className="card-head">
          <div><h2>Stock movements</h2><p>Deliveries, waste, counts and orders. The latest {Math.min(500, (state.stockLog || []).length)} are kept.</p></div>
          <select aria-label="Filter movements by item" value={logItem} onChange={e => setLogItem(e.target.value)}>
            <option value="all">All items</option>
            {tracked.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
        <DataTable limit={20} sort={{ key: 'at', dir: 'desc' }} rows={log} empty="No stock movements yet." columns={[
          { key: 'at', label: 'When', render: x => dateTime(x.at * 1000) },
          { key: 'name', label: 'Item', render: x => <b>{x.name}</b> },
          { key: 'change', label: 'Change', num: true, render: x => <b className={x.change < 0 ? 'neg' : 'pos'}>{x.change > 0 ? '+' : ''}{x.change}</b> },
          { key: 'after', label: 'After', num: true },
          { key: 'reason', label: 'Reason' },
          { key: 'by', label: 'By', render: x => x.by || 'Guest order' },
        ]} />
      </section>
      {adjusting && <AdjustStock ctx={ctx} item={adjusting} onClose={() => setAdjusting(null)} />}
    </>
  );
}

function AdjustStock({ ctx, item, onClose }) {
  const [mode, setMode] = useState('add');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useRunner();
  const n = Number(qty || 0);
  const after = mode === 'add' ? item.stock + n : mode === 'remove' ? item.stock - n : n;
  const labels = { add: ['Delivery received', 'Units received', 'Supplier or invoice number'], remove: ['Waste or breakage', 'Units removed', 'What happened'], set: ['Stock count', 'Counted on hand', 'Who counted'] };
  return (
    <Modal title={`Adjust ${item.name}`} eyebrow={`${item.stock} in stock`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || qty === '' || after < 0} onClick={() => run(async () => { await ctx.action('stock', { id: item.id, mode, qty: n, reason }); onClose(); })}>{busy ? 'Saving…' : 'Save adjustment'}</button></>}>
      <div className="form">
        <div className="segmented" role="group" aria-label="Adjustment type">
          {Object.entries(labels).map(([id, [label]]) => <button key={id} type="button" aria-pressed={mode === id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>{label}</button>)}
        </div>
        <Field label={labels[mode][1]} type="number" min="0" step="1" value={qty} onChange={e => setQty(e.target.value.replace(/[^\d]/g, ''))} autoFocus />
        <Field label="Note (optional)" value={reason} maxLength={120} placeholder={labels[mode][2]} onChange={e => setReason(e.target.value)} />
        <p className={'notice' + (after < 0 ? ' warning' : '')}>{after < 0 ? `You can remove at most ${item.stock}.` : <>Stock after: <b>{after}</b>{after <= item.lowStock ? ' · at or below the low-stock alert' : ''}</>}</p>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Waiters

export function Waiters({ ctx }) {
  const { state, money, canManage } = ctx;
  const [editing, setEditing] = useState(null);
  const [badge, setBadge] = useState(null);
  const [days, setDays] = useState(30);
  const waiters = state.waiters || [];
  const since = days ? now() - days * DAY : 0;
  const stats = useMemo(() => {
    const out = {};
    for (const o of state.orders.filter(isSale).filter(o => o.waiter && o.created >= since)) {
      const r = out[o.waiter] || (out[o.waiter] = { orders: 0, tips: 0, tipped: 0, sales: 0, service: 0 });
      r.orders += 1;
      r.tips += o.tip || 0;
      r.tipped += o.tip > 0 ? 1 : 0;
      r.sales += o.subtotal;
      r.service += o.service?.amount || 0;
    }
    return out;
  }, [state.orders, since]);
  const rows = waiters.map(w => ({ ...w, ...(stats[w.id] || { orders: 0, tips: 0, tipped: 0, sales: 0, service: 0 }) })).map(r => ({ ...r, avgTip: r.tipped ? Math.round(r.tips / r.tipped) : 0, tipRate: r.orders ? r.tipped / r.orders : 0 }));
  const unassigned = state.orders.filter(isSale).filter(o => !o.waiter && o.created >= since);
  const totalTips = rows.reduce((t, r) => t + r.tips, 0);

  function exportCsv() {
    downloadText(`${slug(state.name)}-waiter-tips-${isoDay(new Date())}.csv`, toCsv([
      [`Tips by waiter · ${days ? `last ${days} days` : 'all time'}`], [],
      ['Waiter number', 'Name', 'Phone', 'Active', 'Orders', 'Orders with a tip', 'Tips', 'Average tip', 'Food & drink sales', 'Service charge'],
      ...rows.map(r => [r.number, r.name, r.phone, r.active ? 'Yes' : 'No', r.orders, r.tipped, (r.tips / 100).toFixed(2), (r.avgTip / 100).toFixed(2), (r.sales / 100).toFixed(2), (r.service / 100).toFixed(2)]),
      ['', 'No waiter entered', '', '', unassigned.length, unassigned.filter(o => o.tip > 0).length, (unassigned.reduce((t, o) => t + (o.tip || 0), 0) / 100).toFixed(2), '', (unassigned.reduce((t, o) => t + o.subtotal, 0) / 100).toFixed(2), ''],
    ]));
  }

  return (
    <>
      <PageActions>
        <button onClick={exportCsv} disabled={!waiters.length}><Icon name="download" />CSV</button>
        {canManage && <button className="primary" onClick={() => setEditing({})}><Icon name="add" />Add waiter</button>}
      </PageActions>
      <div className="section-bar">
        <h2>Tips and orders</h2>
        <div className="segmented" role="group" aria-label="Period">
          {[[7, '7 days'], [30, '30 days'], [0, 'All time']].map(([n, label]) => <button key={n} aria-pressed={days === n} className={days === n ? 'active' : ''} onClick={() => setDays(n)}>{label}</button>)}
        </div>
      </div>
      <div className="kpis">
        <Kpi label="Active waiters" icon="team" value={waiters.filter(w => w.active).length} hint={`${waiters.length} in total`} />
        <Kpi label="Tips to waiters" icon="money" value={money(totalTips)} hint={`${rows.reduce((t, r) => t + r.orders, 0)} orders credited`} />
        <Kpi label="Orders without a waiter" icon="menu" value={unassigned.length} hint={`${money(unassigned.reduce((t, o) => t + (o.tip || 0), 0))} in unassigned tips`} />
        <Kpi label="Credited orders" icon="chart" value={pct(rows.reduce((t, r) => t + r.orders, 0) / ((rows.reduce((t, r) => t + r.orders, 0) + unassigned.length) || 1))} hint="Orders with a waiter number" />
      </div>
      {!waiters.length ? (
        <section className="card"><Empty icon="team" title="Add your first waiter" body="Each waiter gets a unique 4-digit number for their badge. Guests enter it when ordering so tips go to the right person." action={canManage ? 'Add waiter' : null} onAction={() => setEditing({})} /></section>
      ) : (
        <>
          <div className="waiter-grid">
            {rows.filter(r => r.active).map(r => (
              <article className="card waiter-card" key={r.id}>
                <div className="waiter-number" aria-label={`Waiter number ${r.number}`}>#{r.number}</div>
                <h3>{r.name}</h3>
                <small className="muted">{r.phone || 'No phone'}</small>
                <div className="waiter-stats"><span><b>{money(r.tips)}</b>tips</span><span><b>{r.orders}</b>orders</span><span><b>{money(r.avgTip)}</b>avg tip</span></div>
                <div className="row wrap">
                  <button className="small-btn" onClick={() => setBadge(r)}><Icon name="download" />Badge</button>
                  {canManage && <button className="small-btn" onClick={() => setEditing(r)}><Icon name="pencil" />Edit</button>}
                </div>
              </article>
            ))}
          </div>
          <section className="card">
            <div className="card-head"><div><h2>Tips by waiter</h2><p>{days ? `Last ${days} days` : 'All time'} · paid orders only</p></div></div>
            <DataTable rank limit={50} sort={{ key: 'tips', dir: 'desc' }} rows={rows} columns={[
              { key: 'name', label: 'Waiter', render: r => <><b>#{r.number} · {r.name}</b><small>{r.active ? r.phone || 'Active' : 'Inactive'}</small></> },
              { key: 'orders', label: 'Orders', num: true },
              { key: 'tipRate', label: 'Tipped', num: true, render: r => `${r.tipped}/${r.orders}` },
              { key: 'avgTip', label: 'Avg tip', num: true, render: r => money(r.avgTip) },
              { key: 'sales', label: 'F&B sales', num: true, render: r => money(r.sales) },
              { key: 'service', label: 'Service charge', num: true, render: r => money(r.service) },
              { key: 'tips', label: 'Tips', num: true, render: r => <b>{money(r.tips)}</b> },
            ]} />
          </section>
        </>
      )}
      {editing && <WaiterForm ctx={ctx} item={editing} onClose={() => setEditing(null)} onCreated={setBadge} />}
      {badge && <WaiterBadge ctx={ctx} waiter={badge} onClose={() => setBadge(null)} />}
    </>
  );
}

function WaiterForm({ ctx, item, onClose, onCreated }) {
  const [active, setActive] = useState(item.active !== false);
  const { busy, error, run } = useRunner();
  const save = (extra = {}) => run(async () => {
    const form = new FormData(document.getElementById('waiter-form'));
    const res = await ctx.action('waiter', { id: item.id, name: form.get('name'), phone: form.get('phone'), active, ...extra });
    onClose();
    if (!item.id || extra.regenerate) onCreated({ ...item, ...res.result, phone: form.get('phone') });
  });
  const remove = () => confirm(`Delete ${item.name}?`) && run(async () => { await ctx.action('delete', { kind: 'waiter', id: item.id }); onClose(); });
  return (
    <Modal title={item.id ? `Edit ${item.name}` : 'Add waiter'} eyebrow={item.id ? `Waiter #${item.number}` : 'A unique number is generated automatically'} onClose={onClose}
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : item.id ? 'Save' : 'Add and generate number'}</button>
      </>}>
      <form id="waiter-form" className="form" onSubmit={e => { e.preventDefault(); save(); }}>
        <Field label="Full name" name="name" defaultValue={item.name} maxLength={80} required autoFocus />
        <Field label="Phone (optional)" name="phone" type="tel" defaultValue={item.phone} maxLength={30} />
        {item.id && <Toggle label="Active" description="Inactive waiters can't be chosen by guests or staff. Their tip history is kept." checked={active} onChange={setActive} />}
        {item.id && (
          <div className="notice row spread wrap">
            <span>Number <b>#{item.number}</b>. Generate a new one if a badge is lost; the old number stops working.</span>
            <button type="button" className="small-btn" disabled={busy} onClick={() => confirm('Generate a new number? The old badge stops working.') && save({ regenerate: true })}>New number</button>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

function WaiterBadge({ ctx, waiter, onClose }) {
  return (
    <Modal title="Waiter badge" eyebrow={waiter.name} onClose={onClose}
      footer={<><button onClick={onClose}>Close</button><button className="primary" onClick={() => window.print()}><Icon name="download" />Print badge</button></>}>
      <Printable className="print-badge">
        <small>{ctx.state.name}</small>
        <b className="badge-name">{waiter.name}</b>
        <span className="badge-label">Waiter number</span>
        <strong className="badge-number">{waiter.number}</strong>
        <small>Enter this number when you order to tip {waiter.name.split(' ')[0]}.</small>
      </Printable>
    </Modal>
  );
}

// ---------------------------------------------------------------- Staff order (waiter takes an order)

export function NewOrder({ ctx, onClose, onCreated }) {
  const { state, money } = ctx;
  const [cart, setCart] = useState({});
  const [tableId, setTableId] = useState('');
  const [waiter, setWaiter] = useState('');
  const [name, setName] = useState('');
  const [tip, setTip] = useState('');
  const [method, setMethod] = useState('Cash');
  const [category, setCategory] = useState('All');
  const { busy, error, run } = useRunner();
  const tipsOn = state.settings.tips.enabled;
  const items = state.menu.filter(i => i.available !== false);
  const categories = ['All', ...new Set(items.map(i => i.category))];
  const lines = items.filter(i => cart[i.id]);
  const subtotal = lines.reduce((t, i) => t + i.price * cart[i.id], 0);
  const price = priceOrder(state, subtotal, tipsOn ? Math.round(Number(tip || 0) * 100) : 0);
  const events = [...state.events].sort((a, b) => a.date.localeCompare(b.date));
  const change = (item, delta) => {
    const max = item.trackStock ? item.stock : 50;
    const n = Math.max(0, Math.min(max, (cart[item.id] || 0) + delta));
    const next = { ...cart, [item.id]: n };
    if (!n) delete next[item.id];
    setCart(next);
  };
  const submit = () => run(async () => {
    const res = await ctx.action('staff_order', { items: cart, tableId, waiter, name, tipAmount: tipsOn ? String(Number(tip || 0)) : '0', method }, { quiet: true });
    const order = res.state.orders.find(o => o.ref === res.result.ref);
    ctx.toast(`Order ${res.result.ref} placed${method ? ` · ${method}` : ''}`);
    onCreated(order);
  });
  return (
    <Modal wide title="New order" eyebrow="Taken by staff" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !lines.length} onClick={submit}>{busy ? 'Placing…' : `Place order · ${money(price.total)}`}</button></>}>
      <div className="pos">
        <div className="pos-menu">
          <div className="chips" role="tablist" aria-label="Categories">
            {categories.map(c => <button key={c} type="button" role="tab" aria-selected={category === c} className={'chip' + (category === c ? ' active' : '')} onClick={() => setCategory(c)}>{c}</button>)}
          </div>
          <div className="pos-items">
            {items.filter(i => category === 'All' || i.category === category).map(i => {
              const n = cart[i.id] || 0;
              const out = i.trackStock && i.stock <= 0;
              return (
                <div className={'pos-item' + (n ? ' has' : '') + (out ? ' out' : '')} key={i.id}>
                  <button type="button" className="pos-add" disabled={out || (i.trackStock && n >= i.stock)} onClick={() => change(i, 1)} aria-label={`Add ${i.name}`}>
                    <b>{i.name}</b>
                    <small>{money(i.price)}{i.trackStock ? ` · ${out ? 'Sold out' : `${i.stock} left`}` : ''}</small>
                  </button>
                  {n > 0 && <div className="stepper"><button type="button" aria-label={`Remove one ${i.name}`} onClick={() => change(i, -1)}>−</button><output>{n}</output><button type="button" aria-label={`Add one ${i.name}`} onClick={() => change(i, 1)} disabled={i.trackStock && n >= i.stock}>+</button></div>}
                </div>
              );
            })}
          </div>
        </div>
        <div className="pos-side form">
          <Field label="Table">
            <select value={tableId} onChange={e => setTableId(e.target.value)}>
              <option value="">No table (counter)</option>
              {events.map(e => {
                const tables = state.tables.filter(t => t.event === e.id);
                return tables.length ? <optgroup key={e.id} label={`${e.name} · ${shortDate(e.date)}`}>{tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup> : null;
              })}
            </select>
          </Field>
          <Field label="Waiter">
            <select value={waiter} onChange={e => setWaiter(e.target.value)}>
              <option value="">No waiter</option>
              {(state.waiters || []).filter(w => w.active).map(w => <option key={w.id} value={w.number}>#{w.number} · {w.name}</option>)}
            </select>
          </Field>
          <Field label="Guest name (optional)" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Walk-in guest" />
          {tipsOn && <Field label={`Tip (${state.currency})`} inputMode="decimal" value={tip} placeholder="0" onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ''); if (/^\d{0,5}(\.\d{0,2})?$/.test(v)) setTip(v); }} />}
          <fieldset className="pay-methods">
            <legend>Payment</legend>
            {[['Cash', 'Cash'], ['Card at venue', 'Card at venue'], ['', 'Not paid yet']].map(([id, label]) => (
              <label key={label} className={'choice compact' + (method === id ? ' active' : '')}><input type="radio" name="pos-method" checked={method === id} onChange={() => setMethod(id)} /><span><b>{label}</b></span></label>
            ))}
          </fieldset>
          <div className="totals">
            {lines.map(i => <div className="line" key={i.id}><span>{cart[i.id]} × {i.name}</span><b>{money(i.price * cart[i.id])}</b></div>)}
            {!lines.length && <p className="small muted">Tap items to add them.</p>}
            {price.service > 0 && <div className="line"><span>Service charge {price.serviceRate}%</span><b>{money(price.service)}</b></div>}
            {price.vat > 0 && <div className="line"><span>VAT {price.vatRate}%{price.included ? ' (included)' : ''}</span><b>{money(price.vat)}</b></div>}
            {price.tip > 0 && <div className="line"><span>Tip</span><b>{money(price.tip)}</b></div>}
            <div className="line total"><span>Total</span><span>{money(price.total)}</span></div>
          </div>
          {method === 'Cash' && lines.length > 0 && <p className="notice small">Collect <b>{money(price.total)}</b> in cash before placing the order.</p>}
          <ErrorText>{error}</ErrorText>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Printable order

export function PrintOrder({ ctx, order, onClose }) {
  const { state, money } = ctx;
  const [format, setFormat] = useState('receipt');
  const tax = state.settings.tax;
  return (
    <Modal title={`Print ${order.ref}`} eyebrow={order.tableName || 'Counter'} onClose={onClose}
      footer={<><button onClick={onClose}>Close</button><button className="primary" onClick={() => window.print()}><Icon name="download" />Print</button></>}>
      <div className="segmented noprint" role="group" aria-label="Print format" style={{ marginBottom: 14 }}>
        {[['receipt', 'Receipt'], ['kitchen', 'Kitchen ticket']].map(([id, label]) => <button key={id} aria-pressed={format === id} className={format === id ? 'active' : ''} onClick={() => setFormat(id)}>{label}</button>)}
      </div>
      <Printable className={'print-slip ' + format}>
        {format === 'kitchen' ? (
          <>
            <div className="slip-center"><b className="slip-big">{order.tableName || 'COUNTER'}</b><span>{order.ref} · {new Date(order.created * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
            <div className="slip-rule" />
            {order.lines.map((l, i) => <div className="slip-kitchen-line" key={i}><b>{l.qty} ×</b><span>{l.name}</span></div>)}
            <div className="slip-rule" />
            <div className="slip-meta">{order.waiterName && <span>Waiter #{order.waiterNumber} {order.waiterName}</span>}{order.takenBy && <span>Taken by {order.takenBy}</span>}<span>{order.name}</span></div>
          </>
        ) : (
          <>
            <div className="slip-center">
              <b className="slip-org">{state.name}</b>
              {state.settings.profile.address && <span>{state.settings.profile.address}{state.settings.profile.city ? `, ${state.settings.profile.city}` : ''}</span>}
              {order.tin && <span>TIN {order.tin}{order.vatNumber ? ` · VAT ${order.vatNumber}` : ''}</span>}
            </div>
            <div className="slip-rule" />
            <div className="slip-meta">
              <span>Order <b>{order.ref}</b></span>
              <span>{dateTime(order.created * 1000)}</span>
              <span>{order.tableName || 'Counter pickup'}{order.waiterName ? ` · Waiter #${order.waiterNumber} ${order.waiterName}` : ''}</span>
              <span>Guest: {order.name}</span>
            </div>
            <div className="slip-rule" />
            {order.lines.map((l, i) => <div className="slip-line" key={i}><span>{l.qty} × {l.name}</span><span>{money(l.total)}</span></div>)}
            <div className="slip-rule" />
            <div className="slip-line"><span>Subtotal</span><span>{money(order.subtotal)}</span></div>
            {order.service && <div className="slip-line"><span>{order.service.label}</span><span>{money(order.service.amount)}</span></div>}
            {order.tax && <div className="slip-line"><span>{order.tax.label}{order.tax.included ? ' (incl.)' : ''}</span><span>{money(order.tax.amount)}</span></div>}
            {order.tip > 0 && <div className="slip-line"><span>Tip</span><span>{money(order.tip)}</span></div>}
            <div className="slip-line slip-total"><span>TOTAL</span><span>{money(order.total)}</span></div>
            <div className="slip-rule" />
            <div className="slip-center">
              <span>{order.status === 'Cancelled' ? 'CANCELLED' : order.paid ? `PAID · ${order.settledBy || 'Online'}` : 'NOT PAID'}</span>
              {order.takenBy && <span>Served by {order.takenBy}</span>}
              {tax.regime !== 'none' && <small>This is not a fiscal receipt.</small>}
              <small>Thank you · Powered by Encore</small>
            </div>
          </>
        )}
      </Printable>
    </Modal>
  );
}
