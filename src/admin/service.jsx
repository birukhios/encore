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
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get('tab') === 'menu' ? 'Menu items' : 'Store items');
  const lowStore = (ctx.state.inventory || []).filter(i => i.quantity <= i.reorderLevel).length;
  const lowMenu = ctx.state.menu.filter(i => i.trackStock && i.stock <= i.lowStock).length;
  return (
    <>
      <div className="report-tabs" role="tablist" aria-label="Stock sections">
        {[['Store items', lowStore], ['Menu items', lowMenu]].map(([t, n]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}{n > 0 && <span className="tab-count">{n}</span>}</button>
        ))}
      </div>
      {tab === 'Store items' ? <StoreStock ctx={ctx} /> : <MenuStock ctx={ctx} />}
    </>
  );
}

const STORE_CATEGORIES = ['Drinks', 'Alcohol', 'Meat', 'Bakery', 'Produce', 'Dry goods', 'Dairy', 'Cleaning', 'Packaging', 'Other'];
const STORE_UNITS = ['bottles', 'cans', 'crates', 'kegs', 'kg', 'g', 'liters', 'ml', 'loaves', 'pieces', 'packs', 'boxes', 'bags', 'trays', 'dozen'];
const QUICK_ADD = [
  ['Beer', 'Alcohol', 'bottles', 24], ['Wine', 'Alcohol', 'bottles', 6], ['Spirits', 'Alcohol', 'bottles', 3], ['Soft drinks', 'Drinks', 'bottles', 24],
  ['Water', 'Drinks', 'bottles', 24], ['Coffee beans', 'Dry goods', 'kg', 2], ['Bread', 'Bakery', 'loaves', 10], ['Injera', 'Bakery', 'pieces', 30],
  ['Beef', 'Meat', 'kg', 5], ['Chicken', 'Meat', 'kg', 5], ['Vegetables', 'Produce', 'kg', 5], ['Cooking oil', 'Dry goods', 'liters', 5],
];
const qty = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });

function StoreStock({ ctx }) {
  const { state, money, canManage } = ctx;
  const [editing, setEditing] = useState(null);
  const [adjusting, setAdjusting] = useState(null);
  const [category, setCategory] = useState('All');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [logItem, setLogItem] = useState('all');
  const items = state.inventory || [];
  const rows = items.map(i => {
    const st = i.quantity <= 0 ? 'out' : i.quantity <= i.reorderLevel ? 'low' : 'ok';
    const used = (state.stockLog || []).filter(x => x.store && x.item === i.id && x.change < 0 && x.at >= now() - 7 * DAY).reduce((t, x) => t - x.change, 0);
    return { ...i, status: st, value: Math.round(i.quantity * i.cost), used7: used, cover: used ? i.quantity / (used / 7) : null };
  });
  const categories = ['All', ...STORE_CATEGORIES.filter(c => items.some(i => i.category === c))];
  const shown = rows.filter(r => (category === 'All' || r.category === category) && (status === 'all' || r.status === status || (status === 'low' && r.status === 'out')) && (!query || `${r.name} ${r.supplier}`.toLowerCase().includes(query.toLowerCase())));
  const low = rows.filter(r => r.status !== 'ok').length;
  const log = [...(state.stockLog || [])].filter(x => x.store && (logItem === 'all' || x.item === logItem)).reverse();

  function exportCsv() {
    downloadText(`${slug(state.name)}-store-stock-${isoDay(new Date())}.csv`, toCsv([
      ['Item', 'Category', 'Quantity', 'Unit', 'Reorder level', 'Status', `Cost per unit (${state.currency})`, `Value (${state.currency})`, 'Used/wasted last 7 days', 'Days of cover', 'Supplier'],
      ...rows.map(r => [r.name, r.category, r.quantity, r.unit, r.reorderLevel, r.status === 'out' ? 'Out of stock' : r.status === 'low' ? 'Reorder' : 'OK', (r.cost / 100).toFixed(2), (r.value / 100).toFixed(2), r.used7, r.cover === null ? '' : r.cover.toFixed(1), r.supplier]),
      [], ['Shopping list (at or below reorder level)'], ['Item', 'Have', 'Reorder level', 'Unit', 'Supplier'],
      ...rows.filter(r => r.status !== 'ok').map(r => [r.name, r.quantity, r.reorderLevel, r.unit, r.supplier]),
      [], ['Store movements'], ['When', 'Item', 'Change', 'Unit', 'After', 'Reason', 'By'],
      ...log.map(x => [new Date(x.at * 1000).toISOString(), x.name, x.change, x.unit, x.after, x.reason, x.by]),
    ]));
  }

  return (
    <>
      <PageActions>
        <button onClick={exportCsv} disabled={!items.length}><Icon name="download" />CSV</button>
        {canManage && <button className="primary" onClick={() => setEditing({})}><Icon name="add" />Add store item</button>}
      </PageActions>
      <div className="kpis">
        <Kpi label="Store items" icon="grid" value={items.length} hint={`${categories.length - 1} categories`} />
        <Kpi label="Need reordering" icon="clock" value={low} tone={low ? 'warn' : ''} hint="At or below the reorder level" />
        <Kpi label="Out of stock" icon="menu" value={rows.filter(r => r.status === 'out').length} tone={rows.some(r => r.status === 'out') ? 'bad' : ''} />
        <Kpi label="Store value" icon="wallet" value={money(rows.reduce((t, r) => t + r.value, 0))} hint="At cost" />
      </div>
      {!items.length ? (
        <section className="card">
          <Empty icon="grid" title="Add what you keep in the store" body="Track beer, wine, bread, meat and other supplies with their unit, cost and reorder level. Record deliveries, what the kitchen and bar use, waste and counts." action={canManage ? 'Add store item' : null} onAction={() => setEditing({})} />
          {canManage && (
            <div className="quick-add">
              <span className="small muted">Quick add</span>
              {QUICK_ADD.map(([name, cat, unit]) => <button key={name} type="button" className="chip" onClick={() => setEditing({ name, category: cat, unit })}>{name}</button>)}
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <div className="card-head">
            <div><h2>Store</h2><p>Days of cover uses what was used or wasted in the last 7 days.</p></div>
            <div className="row wrap">
              <div className="search inline"><Icon name="search" /><input type="search" aria-label="Search store items" placeholder="Item or supplier" value={query} onChange={e => setQuery(e.target.value)} /></div>
              <div className="segmented" role="group" aria-label="Status">
                {[['all', 'All'], ['low', `Reorder ${low}`]].map(([id, label]) => <button key={id} aria-pressed={status === id} className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>)}
              </div>
            </div>
          </div>
          {categories.length > 2 && (
            <div className="chips" role="tablist" aria-label="Categories" style={{ marginBottom: 12 }}>
              {categories.map(c => <button key={c} role="tab" aria-selected={category === c} className={'chip' + (category === c ? ' active' : '')} onClick={() => setCategory(c)}>{c}</button>)}
            </div>
          )}
          <DataTable limit={50} sort={{ key: 'status', dir: 'asc' }} rows={shown} empty="No store items match." columns={[
            { key: 'name', label: 'Item', render: r => <><b>{r.name}</b><small>{r.category}{r.supplier ? ` · ${r.supplier}` : ''}</small></> },
            { key: 'quantity', label: 'On hand', num: true, render: r => <b className={'stock-count ' + r.status}>{qty(r.quantity)} <span className="unit">{r.unit}</span></b> },
            { key: 'status', label: 'Status', value: r => ({ out: 0, low: 1, ok: 2 })[r.status], render: r => <span className={'badge ' + (r.status === 'out' ? 'danger' : r.status === 'low' ? 'warning' : 'success')}>{r.status === 'out' ? 'Out' : r.status === 'low' ? `Reorder (≤ ${qty(r.reorderLevel)})` : 'OK'}</span> },
            { key: 'used7', label: 'Used 7 days', num: true, render: r => (r.used7 ? `${qty(r.used7)} ${r.unit}` : '—') },
            { key: 'cover', label: 'Days of cover', num: true, value: r => (r.cover === null ? 9999 : r.cover), render: r => (r.cover === null ? '—' : r.cover < 1 ? '< 1 day' : `${r.cover.toFixed(1)} days`) },
            { key: 'cost', label: 'Cost / unit', num: true, render: r => money(r.cost) },
            { key: 'value', label: 'Value', num: true, render: r => money(r.value) },
            ...(canManage ? [{ key: 'actions', label: '', num: true, value: () => 0, render: r => <span className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}><button className="small-btn" onClick={e => { e.stopPropagation(); setAdjusting(r); }}>Adjust</button><button className="small-btn ghost" aria-label={`Edit ${r.name}`} onClick={e => { e.stopPropagation(); setEditing(r); }}><Icon name="pencil" /></button></span> }] : []),
          ]} />
        </section>
      )}
      {items.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div><h2>Store movements</h2><p>Deliveries, kitchen and bar use, waste and counts.</p></div>
            <select aria-label="Filter movements by item" value={logItem} onChange={e => setLogItem(e.target.value)}>
              <option value="all">All store items</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <DataTable limit={20} sort={{ key: 'at', dir: 'desc' }} rows={log} empty="No movements yet." columns={[
            { key: 'at', label: 'When', render: x => dateTime(x.at * 1000) },
            { key: 'name', label: 'Item', render: x => <b>{x.name}</b> },
            { key: 'change', label: 'Change', num: true, render: x => <b className={x.change < 0 ? 'neg' : 'pos'}>{x.change > 0 ? '+' : ''}{qty(x.change)} {x.unit}</b> },
            { key: 'after', label: 'After', num: true, render: x => `${qty(x.after)} ${x.unit}` },
            { key: 'reason', label: 'Reason' },
            { key: 'by', label: 'By' },
          ]} />
        </section>
      )}
      {editing && <StoreItemForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
      {adjusting && <AdjustStore ctx={ctx} item={adjusting} onClose={() => setAdjusting(null)} />}
    </>
  );
}

function StoreItemForm({ ctx, item, onClose }) {
  const { state } = ctx;
  const { busy, error, run } = useRunner();
  const existing = !!item.id;
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    run(async () => { await ctx.action('inventory', { ...v, id: item.id }); onClose(); });
  };
  const remove = () => confirm(`Delete ${item.name}? Its movement history stays in the log.`) && run(async () => { await ctx.action('delete', { kind: 'inventory', id: item.id }); onClose(); });
  return (
    <Modal title={existing ? `Edit ${item.name}` : 'Add store item'} eyebrow="Store stock" onClose={onClose}
      footer={<>
        {existing && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="store-form" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save' : 'Add item'}</button>
      </>}>
      <form id="store-form" className="form" onSubmit={submit}>
        {!existing && (
          <div className="quick-add">
            <span className="small muted">Quick add</span>
            {QUICK_ADD.map(([name, cat, unit, level]) => (
              <button key={name} type="button" className="chip" onClick={() => {
                const f = document.getElementById('store-form');
                f.name.value = name; f.category.value = cat; f.unit.value = unit; f.reorderLevel.value = level;
              }}>{name}</button>
            ))}
          </div>
        )}
        <Field label="Item name" name="name" defaultValue={item.name} maxLength={80} required placeholder="e.g. St. George beer" />
        <div className="formrow">
          <Field label="Category"><select name="category" defaultValue={item.category || 'Drinks'}>{STORE_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Unit"><select name="unit" defaultValue={item.unit || 'bottles'}>{STORE_UNITS.map(u => <option key={u}>{u}</option>)}</select></Field>
        </div>
        <div className="formrow">
          {existing
            ? <Field label="On hand"><input value={`${qty(item.quantity)} ${item.unit}`} readOnly /><small>Use Adjust to change quantities so every change is logged.</small></Field>
            : <Field label="Opening quantity" name="quantity" type="number" min="0" step="0.001" defaultValue={0} required />}
          <Field label="Reorder when at or below" name="reorderLevel" type="number" min="0" step="0.001" defaultValue={item.reorderLevel ?? 0} required />
        </div>
        <div className="formrow">
          <Field label={`Cost per unit (${state.currency})`} name="cost" type="number" min="0" step="0.01" defaultValue={item.cost ? item.cost / 100 : ''} placeholder="0.00" />
          <Field label="Supplier (optional)" name="supplier" defaultValue={item.supplier} maxLength={80} />
        </div>
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

function AdjustStore({ ctx, item, onClose }) {
  const [mode, setMode] = useState('add');
  const [amount, setAmount] = useState('');
  const [cost, setCost] = useState(item.cost ? String(item.cost / 100) : '');
  const [note, setNote] = useState('');
  const { busy, error, run } = useRunner();
  const n = Number(amount || 0);
  const after = Math.round((mode === 'add' ? item.quantity + n : mode === 'set' ? n : item.quantity - n) * 1000) / 1000;
  const labels = { add: ['Delivery', 'Received', 'Invoice number'], use: ['Used', 'Used by kitchen or bar', 'What for'], waste: ['Waste', 'Wasted or broken', 'What happened'], set: ['Count', 'Counted on hand', 'Who counted'] };
  return (
    <Modal title={`Adjust ${item.name}`} eyebrow={`${qty(item.quantity)} ${item.unit} on hand`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || amount === '' || after < 0} onClick={() => run(async () => { await ctx.action('inventory_adjust', { id: item.id, mode, qty: n, note, ...(mode === 'add' ? { cost } : {}) }); onClose(); })}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="form">
        <div className="segmented" role="group" aria-label="Adjustment type">
          {Object.entries(labels).map(([id, [label]]) => <button key={id} type="button" aria-pressed={mode === id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>{label}</button>)}
        </div>
        <Field label={`${labels[mode][1]} (${item.unit})`} type="number" min="0" step="0.001" value={amount} onChange={e => setAmount(e.target.value)} autoFocus />
        {mode === 'add' && <Field label={`Cost per unit (${ctx.state.currency})`} type="number" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} hint="Updates the item's cost for stock value." />}
        <Field label="Note (optional)" value={note} maxLength={120} placeholder={labels[mode][2]} onChange={e => setNote(e.target.value)} />
        <p className={'notice' + (after < 0 ? ' warning' : '')}>{after < 0 ? `Only ${qty(item.quantity)} ${item.unit} on hand.` : <>After: <b>{qty(after)} {item.unit}</b>{after <= item.reorderLevel ? ' · time to reorder' : ''}</>}</p>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function MenuStock({ ctx }) {
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
  const log = [...(state.stockLog || [])].reverse().filter(x => !x.store && (logItem === 'all' || x.item === logItem));

  function exportCsv() {
    downloadText(`${slug(state.name)}-stock-${isoDay(new Date())}.csv`, toCsv([
      ['Item', 'Category', 'In stock', 'Low-stock alert', 'Status', 'Sold last 7 days', 'Days of cover', `Retail value (${state.currency})`],
      ...rows.map(r => [r.name, r.category, r.stock, r.lowStock, r.status === 'out' ? 'Out of stock' : r.status === 'low' ? 'Low' : 'OK', r.sold7, r.cover === null ? '' : r.cover.toFixed(1), (r.value / 100).toFixed(2)]),
      [], ['Stock movements'], ['When', 'Item', 'Change', 'After', 'Reason', 'By'],
      ...(state.stockLog || []).filter(x => !x.store).slice().reverse().map(x => [new Date(x.at * 1000).toISOString(), x.name, x.change, x.after, x.reason, x.by]),
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
