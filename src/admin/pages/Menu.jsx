import React, { useState } from 'react';
import { shortDate } from '../../shared/api';
import ImageUpload from '../../shared/ImageUpload';
import { Empty, ErrorText, Field, Icon, Modal, Toggle } from '../../shared/ui';
import { PageActions, useRunner } from './common';

export function Menu({ ctx }) {
  const { state, money, matches } = ctx;
  const [editing, setEditing] = useState(null);
  const [category, setCategory] = useState('All');
  const categories = ['All', ...state.settings.menu.categories.filter(c => state.menu.some(i => i.category === c))];
  const items = state.menu.filter(i => category === 'All' || i.category === category).filter(i => matches(i.name, i.category, i.description));
  const servedAt = i => !i.events?.length ? 'All concerts' : i.events.map(id => state.events.find(e => e.id === id)?.name).filter(Boolean).join(', ');
  return (
    <>
      <PageActions><button className="primary" onClick={() => setEditing({})}><Icon name="add" />Add menu item</button></PageActions>
      {state.menu.length > 0 && <div className="chips">{categories.map(c => <button key={c} className={'chip' + (category === c ? ' active' : '')} onClick={() => setCategory(c)}>{c}</button>)}</div>}
      {items.length ? (
        <div className="menugrid">
          {items.map(i => (
            <article className="menuitem" key={i.id}>
              {i.image ? <img className="thumb" src={i.image} alt="" /> : <div className="thumb"><Icon name="menu" size="lg" /></div>}
              <div className="grow">
                <small className="muted">{i.category}</small>
                <h3>{i.name}</h3>
                <p>{servedAt(i)}</p>
                <div className="row" style={{ marginTop: 6 }}><b>{money(i.price)}</b>{!i.available && <span className="badge neutral">Unavailable</span>}</div>
              </div>
              <button onClick={() => setEditing(i)} aria-label={'Edit ' + i.name}><Icon name="pencil" /></button>
            </article>
          ))}
        </div>
      ) : (
        <section className="card"><Empty icon="menu" title={ctx.search ? 'No matching items' : 'Something delicious is on the way'} body="Add food and drinks with photos, prices and the concerts where they're served." action={ctx.search ? null : 'Add menu item'} onAction={() => setEditing({})} /></section>
      )}
      {editing && <MenuForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function MenuForm({ ctx, item, onClose }) {
  const { state } = ctx;
  const [image, setImage] = useState(item.image || '');
  const [available, setAvailable] = useState(item.available !== false);
  const [allEvents, setAllEvents] = useState(!item.events?.length);
  const [events, setEvents] = useState(item.events || []);
  const [trackStock, setTrackStock] = useState(!!item.trackStock);
  const { busy, error, run } = useRunner();
  const categories = state.settings.menu.categories;
  const [category, setCategory] = useState(item.category || categories[0]);
  const [newCategory, setNewCategory] = useState(null); // text while adding one
  // Saved straight into Settings, so the half-filled item form stays open.
  const addCategory = () => run(async () => {
    const name = newCategory.trim();
    if (!name) throw new Error('Type a category name.');
    const existing = categories.find(c => c.toLowerCase() === name.toLowerCase());
    if (!existing) await ctx.action('config', { group: 'menu', values: { categories: [...categories, name] } });
    setCategory(existing || name);
    setNewCategory(null);
  });
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    if (!allEvents && !events.length) return run(async () => { throw new Error('Choose at least one concert, or serve this item at all concerts.'); });
    run(async () => { await ctx.action('menu', { ...v, id: item.id, image, available, trackStock, events: allEvents ? [] : events }); onClose(); });
  };
  const remove = () => confirm(`Delete ${item.name}?`) && run(async () => { await ctx.action('delete', { kind: 'menu', id: item.id }); onClose(); });
  return (
    <Modal title={item.id ? 'Edit menu item' : 'Add menu item'} eyebrow={state.name} onClose={onClose} wide
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="menu-form" disabled={busy}>{busy ? 'Saving…' : 'Save item'}</button>
      </>}>
      <form id="menu-form" className="form" onSubmit={submit}>
        <ImageUpload label="Photo" value={image} onChange={setImage} />
        <div className="formrow">
          <Field label="Item name" name="name" defaultValue={item.name} maxLength={120} required />
          {newCategory === null ? (
            <Field label="Category" hint={<button type="button" className="linklike small" onClick={() => setNewCategory('')}>+ New category</button>}>
              <select name="category" value={category} onChange={e => setCategory(e.target.value)} required>{categories.map(c => <option key={c}>{c}</option>)}</select>
            </Field>
          ) : (
            <Field label="New category" hint={<span className="row" style={{ gap: 8 }}>
              <button type="button" className="linklike small" onClick={addCategory} disabled={busy}>Add</button>
              <button type="button" className="linklike small" onClick={() => setNewCategory(null)}>Cancel</button>
            </span>}>
              <input type="hidden" name="category" value={category} />
              <input aria-label="New category name" value={newCategory} maxLength={40} autoFocus onChange={e => setNewCategory(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }} />
            </Field>
          )}
        </div>
        <Field label="Description"><textarea name="description" defaultValue={item.description} maxLength={500} required /></Field>
        <Field label={`Price (${state.currency})`} name="price" type="number" step="0.01" min="0" defaultValue={(item.price || 0) / 100} required />
        <Toggle label="Available to order" description="Turn off to hide the item from guests." checked={available} onChange={setAvailable} />
        <div>
          <Toggle label="Track stock" description="Orders reduce stock automatically and guests can't order more than you have. Manage counts on the Stock page." checked={trackStock} onChange={setTrackStock} />
          {trackStock && (
            <div className="formrow" style={{ paddingTop: 6 }}>
              {item.trackStock
                ? <Field label="In stock"><input value={item.stock} readOnly aria-describedby="stock-hint" /><small id="stock-hint">Change counts on the Stock page so every change is logged.</small></Field>
                : <Field label="Opening stock" name="stock" type="number" min="0" step="1" defaultValue={0} required />}
              <Field label="Low-stock alert at" name="lowStock" type="number" min="0" step="1" defaultValue={item.lowStock ?? 5} required hint="Guests see “Only N left” at or below this." />
            </div>
          )}
        </div>
        <div>
          <Toggle label="Served at all concerts" description="Turn off to choose specific concerts. Guests at a table only see that concert's menu." checked={allEvents} onChange={setAllEvents} />
          {!allEvents && (
            <div className="stack" style={{ paddingTop: 6 }}>
              {state.events.length ? state.events.map(e => (
                <label className="checkline" key={e.id}>
                  <input type="checkbox" checked={events.includes(e.id)} onChange={ev => setEvents(ev.target.checked ? [...events, e.id] : events.filter(x => x !== e.id))} />
                  <span>{e.name} <span className="muted">· {shortDate(e.date)}</span></span>
                </label>
              )) : <p className="footnote">Create a concert first.</p>}
            </div>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}
