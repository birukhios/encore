import React, { useEffect, useRef, useState } from 'react';
import ImageUpload from '../shared/ImageUpload';
import { copyText, ErrorText, Field, Icon, Toggle } from '../shared/ui';

const SECTIONS = [
  ['workspace', 'Workspace', 'venue'],
  ['profile', 'Location & photos', 'download'],
  ['theme', 'Appearance', 'theme'],
  ['ticketing', 'Ticketing', 'ticket'],
  ['ordering', 'Table ordering', 'table'],
  ['categories', 'Menu categories', 'menu'],
  ['tax', 'VAT', 'chart'],
  ['tips', 'Tips', 'money'],
  ['payments', 'Payments', 'wallet'],
  ['notifications', 'Notifications', 'bell'],
  ['support', 'Help & support', 'support'],
  ['legal', 'Terms & privacy', 'edit'],
];
const CURRENCIES = ['ETB', 'USD', 'EUR', 'KES', 'NGN', 'GHS', 'RWF', 'UGX'];
const SWATCHES = ['#E61E32', '#000000', '#1A4DB3', '#0F7B5F', '#7A3FC4', '#B4540A', '#C2185B', '#37474F'];

export default function Settings({ ctx }) {
  const [section, setSection] = useState(() => new URLSearchParams(location.search).get('section') || 'workspace');
  const [dirty, setDirty] = useState(false);
  function choose(id) {
    if (dirty && !confirm('You have unsaved changes in this section. Leave without saving?')) return;
    setDirty(false);
    setSection(id);
    history.replaceState(null, '', '/admin?page=Settings&section=' + id);
  }
  useEffect(() => {
    const warn = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const Section = { workspace: Workspace, profile: Profile, categories: Categories, tax: Tax, theme: Theme, ticketing: Ticketing, ordering: Ordering, tips: Tips, payments: Payments, notifications: Notifications, support: Support, legal: Legal }[section] || Workspace;
  const title = SECTIONS.find(s => s[0] === section)?.[1] || 'Workspace';
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map(([id, label, icon]) => (
          <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => choose(id)}>
            <Icon name={icon} />{label}
          </button>
        ))}
      </nav>
      <section className="card settings-section" aria-label={title}>
        <Section key={section} ctx={ctx} setDirty={setDirty} dirty={dirty} />
      </section>
    </div>
  );
}

/** Local editable copy of a settings group with dirty tracking and a save bar. */
function useDraft(initial, setDirty) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const baseline = JSON.stringify(initial);
  const previous = useRef(baseline);
  useEffect(() => {
    // Follow saved/background changes only while the organizer has no unsaved edits.
    setDraft(d => (JSON.stringify(d) === previous.current ? initial : d));
    previous.current = baseline;
  }, [baseline]);
  const changed = JSON.stringify(draft) !== baseline;
  useEffect(() => { setDirty(changed); }, [changed]);
  useEffect(() => () => setDirty(false), []);
  const set = (key, value) => setDraft(d => ({ ...d, [key]: value }));
  return { draft, set, setDraft, error, setError, busy, setBusy, changed, reset: () => { setDraft(initial); setError(''); } };
}

function SaveBar({ form, onSave, note }) {
  return (
    <div className="savebar">
      <span className="hint">{form.changed ? <><span className="unsaved" />Unsaved changes</> : note || 'All changes saved'}</span>
      <div className="row">
        {form.changed && <button type="button" onClick={form.reset} disabled={form.busy}>Discard</button>}
        <button type="button" className="primary" disabled={!form.changed || form.busy} onClick={onSave}>{form.busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

function useSaver(ctx, form) {
  return async (op, data) => {
    form.setBusy(true);
    form.setError('');
    try {
      await ctx.action(op, data);
    } catch (e) {
      form.setError(e.message);
    } finally {
      form.setBusy(false);
    }
  };
}

function Head({ title, children }) {
  return <div><h2>{title}</h2><p style={{ marginTop: 4 }}>{children}</p></div>;
}

function Locked({ ctx }) {
  return !ctx.canManage ? <p className="notice">Only owners and admins can change these settings.</p> : null;
}

// ---------------------------------------------------------------- sections

function Workspace({ ctx, setDirty }) {
  const { state } = ctx;
  const form = useDraft({ name: state.name, description: state.description, currency: state.currency }, setDirty);
  const save = useSaver(ctx, form);
  const link = ctx.guestLink();
  const hasSales = state.bookings.length + state.orders.length > 0;
  return (
    <>
      <Head title="Workspace">The organization name, description and currency guests see.</Head>
      <Field label="Organization name" value={form.draft.name} maxLength={80} onChange={e => form.set('name', e.target.value)} required />
      <Field label="About your organization"><textarea value={form.draft.description} maxLength={500} onChange={e => form.set('description', e.target.value)} /></Field>
      <Field label="Currency" hint={hasSales ? 'Changing currency does not convert existing bookings and orders.' : 'Prices are shown to guests in this currency.'}>
        <select value={form.draft.currency} onChange={e => form.set('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select>
      </Field>
      <ErrorText>{form.error}</ErrorText>
      <SaveBar form={form} onSave={() => save('settings', form.draft)} />
      <hr />
      <div className="stack">
        <h3>Public guest link</h3>
        <p className="small">Share this with your audience. Table QR codes open the same guest app with the table already selected.</p>
        <div className="row">
          <input readOnly value={link} aria-label="Public guest link" onFocus={e => e.target.select()} />
          <button onClick={async () => ctx.toast(await copyText(link) ? 'Link copied' : 'Select and copy the link')}><Icon name="copy" />Copy</button>
        </div>
      </div>
    </>
  );
}

function Profile({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.profile, setDirty);
  const save = useSaver(ctx, form);
  const d = form.draft;
  return (
    <>
      <Head title="Location & photos">Where guests find you, and photos shown on your organizer page.</Head>
      <Locked ctx={ctx} />
      <div className="formrow">
        <Field label="City" value={d.city} maxLength={80} onChange={e => form.set('city', e.target.value)} disabled={!ctx.canManage} />
        <Field label="Address" placeholder="e.g. Bole Road, near Edna Mall" value={d.address} maxLength={200} onChange={e => form.set('address', e.target.value)} disabled={!ctx.canManage} />
      </div>
      <Field label="Map link (optional)" placeholder="https://maps.google.com/…" value={d.mapUrl} maxLength={500} onChange={e => form.set('mapUrl', e.target.value)} disabled={!ctx.canManage}
        hint="Guests can open directions from your organizer page." />
      <div className="stack">
        <div className="row spread"><h3>Photos</h3><span className="hint">{d.photos.length}/12 · the first photo is your cover on the organizer list</span></div>
        <div className="photogrid">
          {d.photos.map((url, i) => (
            <figure key={url + i} className="photo">
              <img src={url} alt={`Photo ${i + 1}`} />
              {ctx.canManage && (
                <div className="photo-actions">
                  {i > 0 && <button type="button" onClick={() => { const p = [...d.photos]; [p[i - 1], p[i]] = [p[i], p[i - 1]]; form.set('photos', p); }} aria-label="Move earlier">‹</button>}
                  <button type="button" onClick={() => form.set('photos', d.photos.filter((_, j) => j !== i))} aria-label="Remove photo">×</button>
                </div>
              )}
              {i === 0 && <figcaption>Cover</figcaption>}
            </figure>
          ))}
          {ctx.canManage && d.photos.length < 12 && <ImageUpload key={d.photos.length} label="Add photo" square value="" onChange={url => url && form.set('photos', [...d.photos, url])} />}
        </div>
      </div>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'profile', values: d })} />}
    </>
  );
}

function Categories({ ctx, setDirty }) {
  const initial = { categories: ctx.state.settings.menu.categories, renames: {} };
  const form = useDraft(initial, setDirty);
  const save = useSaver(ctx, form);
  const [adding, setAdding] = useState('');
  const d = form.draft;
  const original = ctx.state.settings.menu.categories;
  const count = name => ctx.state.menu.filter(i => i.category === (Object.entries(d.renames).find(([, to]) => to === name)?.[0] || name)).length;
  const rename = (i, value) => {
    const cats = [...d.categories];
    const from = original.includes(cats[i]) ? cats[i] : Object.entries(d.renames).find(([, to]) => to === cats[i])?.[0];
    cats[i] = value;
    const renames = { ...d.renames };
    if (from) renames[from] = value;
    form.setDraft({ categories: cats, renames });
  };
  const move = (i, delta) => { const c = [...d.categories]; [c[i], c[i + delta]] = [c[i + delta], c[i]]; form.set('categories', c); };
  const add = e => { e.preventDefault(); const v = adding.trim(); if (v && !d.categories.some(c => c.toLowerCase() === v.toLowerCase())) form.set('categories', [...d.categories, v]); setAdding(''); };
  return (
    <>
      <Head title="Menu categories">The sections of your menu, in the order guests see them.</Head>
      <Locked ctx={ctx} />
      <div className="list">
        {d.categories.map((c, i) => (
          <div className="listrow" key={i}>
            <input aria-label={`Category ${i + 1}`} value={c} maxLength={60} onChange={e => rename(i, e.target.value)} disabled={!ctx.canManage} />
            <span className="badge neutral" title="Menu items in this category">{count(c)} items</span>
            {ctx.canManage && <>
              <button type="button" className="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="up" /></button>
              <button type="button" className="ghost" disabled={i === d.categories.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="down" /></button>
              <button type="button" className="ghost danger-text" disabled={count(c) > 0 || d.categories.length === 1} title={count(c) ? 'Move its items to another category first' : 'Remove'} onClick={() => form.set('categories', d.categories.filter((_, j) => j !== i))}>Remove</button>
            </>}
          </div>
        ))}
      </div>
      {ctx.canManage && (
        <form className="codeentry" onSubmit={add}>
          <input placeholder="New category, e.g. Cocktails" value={adding} maxLength={60} onChange={e => setAdding(e.target.value)} style={{ textTransform: 'none', letterSpacing: 0, textAlign: 'left', fontWeight: 500 }} />
          <button className="primary" disabled={!adding.trim()}><Icon name="add" />Add</button>
        </form>
      )}
      <p className="footnote">Renaming a category updates every menu item in it. A category with items cannot be removed.</p>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'menu', values: d })} />}
    </>
  );
}

function Tax({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.tax, setDirty);
  const save = useSaver(ctx, form);
  const d = form.draft;
  const rate = Number(d.vatRate) || 0;
  const example = 100000;
  const tax = d.pricesIncludeTax ? Math.round(example * rate / (100 + rate)) : Math.round(example * rate / 100);
  return (
    <>
      <Head title="VAT">Ethiopian value-added tax on tickets and menu orders, shown on every checkout and receipt.</Head>
      <Locked ctx={ctx} />
      <p className="notice warning">Encore calculates and displays VAT from these settings; it is not tax advice, and Encore receipts are not fiscal (cash register) receipts. Confirm your registration and obligations with the Ministry of Revenues or your accountant.</p>
      <Toggle label="Charge VAT" description="Turn on if your organization is registered for VAT." checked={d.regime === 'vat'} onChange={v => form.set('regime', v ? 'vat' : 'none')} disabled={!ctx.canManage} />
      {d.regime === 'vat' && <>
        <div className="formrow">
          <Field label="VAT rate (%)" type="number" min="0" max="50" step="0.01" value={d.vatRate} onChange={e => form.set('vatRate', Number(e.target.value))} disabled={!ctx.canManage} hint="Ethiopia's standard VAT rate is 15%." />
          <Field label="TIN" inputMode="numeric" placeholder="10 digits" value={d.tin} maxLength={10} onChange={e => form.set('tin', e.target.value.replace(/\D/g, ''))} disabled={!ctx.canManage} />
        </div>
        <Field label="VAT registration number (optional)" value={d.vatNumber} maxLength={30} onChange={e => form.set('vatNumber', e.target.value)} disabled={!ctx.canManage} />
        <div>
          <Toggle label="Prices already include VAT" description={d.pricesIncludeTax ? 'Guests pay the listed price; receipts show the VAT inside it.' : 'VAT is added on top of listed prices at checkout.'} checked={d.pricesIncludeTax} onChange={v => form.set('pricesIncludeTax', v)} disabled={!ctx.canManage} />
          <Toggle label="Apply to tickets" checked={d.tickets} onChange={v => form.set('tickets', v)} disabled={!ctx.canManage} />
          <Toggle label="Apply to food & drink orders" description="Tips are voluntary and never taxed by Encore." checked={d.menu} onChange={v => form.set('menu', v)} disabled={!ctx.canManage} />
        </div>
        <div className="notice">
          <b style={{ color: 'var(--ink)' }}>Example:</b> a {ctx.money(example)} item → {d.pricesIncludeTax
            ? <>guest pays {ctx.money(example)}, of which VAT {rate}% is {ctx.money(tax)}.</>
            : <>VAT {rate}% adds {ctx.money(tax)}; guest pays {ctx.money(example + tax)}.</>}
        </div>
      </>}
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'tax', values: d })} />}
    </>
  );
}

function Theme({ ctx, setDirty }) {
  const { state } = ctx;
  const form = useDraft(state.settings.theme, setDirty);
  const save = useSaver(ctx, form);
  const { accent, mode, adminMode, logo, cover } = form.draft;
  const validHex = /^#[0-9a-f]{6}$/i.test(accent);
  return (
    <>
      <Head title="Appearance">Brand your guest app and dashboard. Both use your accent color.</Head>
      <Locked ctx={ctx} />
      <div className="grid-2" style={{ gridTemplateColumns: '1fr auto' }}>
        <div className="form">
          <div className="field" style={{ display: 'grid', gap: 8 }}>
            <b style={{ fontSize: 13 }}>Accent color</b>
            <div className="swatches" role="radiogroup" aria-label="Suggested accent colors">
              {SWATCHES.map(c => (
                <button key={c} type="button" role="radio" aria-checked={accent.toUpperCase() === c} aria-label={c} className={'swatch' + (accent.toUpperCase() === c ? ' active' : '')} style={{ background: c }} onClick={() => form.set('accent', c)} />
              ))}
            </div>
            <div className="row">
              <input type="color" aria-label="Custom accent color" value={validHex ? accent : '#E61E32'} onChange={e => form.set('accent', e.target.value.toUpperCase())} />
              <input aria-label="Accent hex value" value={accent} maxLength={7} onChange={e => form.set('accent', e.target.value)} style={{ width: 130, fontFamily: 'ui-monospace, monospace' }} />
              <button type="button" className="ghost" onClick={() => form.set('accent', '#E61E32')}>Reset to Encore crimson</button>
            </div>
            <small className="hint">Buttons use white text, so very light colors are not accepted.</small>
          </div>
          <div className="field" style={{ display: 'grid', gap: 8 }}>
            <b style={{ fontSize: 13 }}>Guest app appearance</b>
            <div className="segmented" role="radiogroup" aria-label="Guest app appearance">
              {[['light', 'Light'], ['dark', 'Black'], ['system', "Match guest's phone"]].map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'active' : ''} onClick={() => form.set('mode', id)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="field" style={{ display: 'grid', gap: 8 }}>
            <b style={{ fontSize: 13 }}>Dashboard appearance</b>
            <div className="segmented" role="radiogroup" aria-label="Dashboard appearance">
              {[['light', 'Light'], ['dark', 'Black'], ['system', "Match this device"]].map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={adminMode === id} className={adminMode === id ? 'active' : ''} onClick={() => form.set('adminMode', id)}>{label}</button>
              ))}
            </div>
            <small className="hint">Applies to everyone on your team after you save.</small>
          </div>
          <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
            <ImageUpload label="Logo" square value={logo} onChange={v => form.set('logo', v)} />
            <div className="grow" style={{ minWidth: 220 }}><ImageUpload label="Guest app cover" value={cover} onChange={v => form.set('cover', v)} hint="Wide image, shown at the top of your events" /></div>
          </div>
        </div>
        <Preview name={state.name} theme={form.draft} />
      </div>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'theme', values: form.draft })} />}
    </>
  );
}

function Preview({ name, theme }) {
  const dark = theme.mode === 'dark';
  const accent = /^#[0-9a-f]{6}$/i.test(theme.accent) ? theme.accent : '#E61E32';
  return (
    <div aria-label="Guest app preview" style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
      <div className="preview-phone" data-mode={dark ? 'dark' : 'light'} style={dark && /^#(?:[0-2][0-9a-f]){3}$/i.test(accent) ? { '--accent': '#F4F4F6', '--on-accent': '#0B0B0E' } : { '--accent': accent, '--on-accent': '#fff' }}>
        <div className="pv-head">
          {theme.logo ? <img src={theme.logo} alt="" /> : <span className="brandmark" style={{ width: 26, height: 26, borderRadius: 6 }} />}
          <b style={{ fontSize: 12 }}>{name}</b>
        </div>
        <div className="pv-cover" style={theme.cover ? { backgroundImage: `url(${theme.cover})` } : undefined} />
        <div className="pv-body">
          <div className="pv-card">
            <b>Friday Night Live</b>
            <p style={{ fontSize: 10, margin: '2px 0 8px' }}>Main Hall · 8:00 PM</p>
            <button className="primary block">Get tickets</button>
          </div>
          <div className="pv-card row spread"><span>Table 4</span><span className="badge">Linked</span></div>
        </div>
      </div>
      <small className="hint">Preview{theme.mode === 'system' ? " (follows the guest's phone)" : ''}</small>
    </div>
  );
}

function Ticketing({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.ticketing, setDirty);
  const save = useSaver(ctx, form);
  return (
    <>
      <Head title="Ticketing">How guests reserve tickets for your published concerts.</Head>
      <Locked ctx={ctx} />
      <div>
        <Toggle label="Accept ticket reservations" description="Turn off to show events without allowing new reservations." checked={form.draft.enabled} onChange={v => form.set('enabled', v)} disabled={!ctx.canManage} />
        <Toggle label="Show tickets remaining" description="Display how many tickets are left on each event." checked={form.draft.showRemaining} onChange={v => form.set('showRemaining', v)} disabled={!ctx.canManage} />
      </div>
      <Field label="Maximum tickets per reservation" type="number" min="1" max="20" value={form.draft.maxPerOrder} onChange={e => form.set('maxPerOrder', Number(e.target.value))} disabled={!ctx.canManage} style={{ maxWidth: 160 }} />
      <p className="footnote">Every ticket gets its own QR code. Scan them at the entrance from Bookings → Scan ticket.</p>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'ticketing', values: form.draft })} />}
    </>
  );
}

function Ordering({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.ordering, setDirty);
  const save = useSaver(ctx, form);
  const d = form.draft;
  return (
    <>
      <Head title="Table ordering">Control how guests order food and drinks during a concert.</Head>
      <Locked ctx={ctx} />
      <div>
        <Toggle label="Accept food & drink orders" checked={d.enabled} onChange={v => form.set('enabled', v)} disabled={!ctx.canManage} />
        <Toggle label="Require a table scan before ordering" description="Guests scan the QR code on their table (or type its code) so orders arrive at the right seat." checked={d.requireScan} onChange={v => form.setDraft({ ...d, requireScan: v, ticketHoldersOnly: v ? d.ticketHoldersOnly : false })} disabled={!ctx.canManage || !d.enabled} />
        <Toggle label="Only ticket holders can order" description="The guest must hold a ticket for the concert their table belongs to." checked={d.ticketHoldersOnly} onChange={v => form.set('ticketHoldersOnly', v)} disabled={!ctx.canManage || !d.enabled || !d.requireScan} />
        <Toggle label="Show each concert's own menu" description="Guests see only items served at their concert. Items set to 'all concerts' always appear." checked={d.eventMenus} onChange={v => form.set('eventMenus', v)} disabled={!ctx.canManage || !d.enabled} />
      </div>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'ordering', values: d })} />}
    </>
  );
}

function Tips({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.tips, setDirty);
  const save = useSaver(ctx, form);
  const [text, setText] = useState(form.draft.presets.join(', '));
  const d = form.draft;
  return (
    <>
      <Head title="Tips">Optional tip amounts on food & drink orders. No tip is ever preselected, and tips are not taxed.</Head>
      <Locked ctx={ctx} />
      <div>
        <Toggle label="Allow tips" checked={d.enabled} onChange={v => form.set('enabled', v)} disabled={!ctx.canManage} />
        <Toggle label="Allow guests to enter their own amount" checked={d.custom} onChange={v => form.set('custom', v)} disabled={!ctx.canManage || !d.enabled} />
      </div>
      <Field label={`Tip amounts (${ctx.state.currency})`} hint="Up to five whole amounts, separated by commas — for example 20, 50, 100." value={text} disabled={!ctx.canManage || !d.enabled}
        onChange={e => { setText(e.target.value); form.set('presets', e.target.value.split(/[\s,]+/).filter(Boolean).map(Number)); }} />
      {d.enabled && <div className="tips" style={{ maxWidth: 460 }} aria-label="Preview"><button className="active">No tip</button>{d.presets.filter(n => n > 0).map(n => <button key={n} type="button">{ctx.money(n * 100).replace(/\.00$/, '')}</button>)}</div>}
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'tips', values: d })} />}
    </>
  );
}

function Payments({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.payments, setDirty);
  const save = useSaver(ctx, form);
  return (
    <>
      <Head title="Payments">How guests pay for tickets and orders.</Head>
      <Locked ctx={ctx} />
      <p className="notice"><b style={{ color: 'var(--ink)' }}>Tickets are paid online only.</b> Guests pay with their mobile wallet when they book; there is no pay-at-the-door option.</p>
      <Toggle label="Allow paying for food & drinks at the table" description="Guests order now and pay staff when it arrives. Staff record each payment in Orders." checked={form.draft.venue} onChange={v => form.set('venue', v)} disabled={!ctx.canManage} />
      <div className="notice">
        <div className="row spread" style={{ marginBottom: 6 }}><b style={{ color: 'var(--ink)' }}>AfroPay online payments</b><span className={'badge ' + (ctx.session.demo ? 'warning' : 'neutral')}>{ctx.session.demo ? 'Demo (simulated)' : 'Not connected'}</span></div>
        {ctx.session.demo
          ? 'Demo mode is on: online checkout completes a simulated payment and marks the booking or order paid as "Demo payment (simulated)". No money moves. Turn demo mode off on the server before real sales.'
          : 'Online wallet payments are not available yet. The merchant integration will be enabled once the AfroPay merchant API contract and credentials are configured on the server. Until then, checkout never charges guests.'}
      </div>
      {!ctx.session.demo && <p className="notice warning">Online payments are not connected yet, so guests cannot buy tickets{form.draft.venue ? '' : ' or place orders'} until AfroPay is configured (demo mode simulates it).</p>}
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'payments', values: form.draft })} />}
    </>
  );
}

function Notifications({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.notifications, setDirty);
  const save = useSaver(ctx, form);
  const sms = ctx.session.sms;
  return (
    <>
      <Head title="Notifications">Keep guests and staff updated. Guests always receive in-app notifications.</Head>
      <Locked ctx={ctx} />
      <p className={'notice' + (sms.delivers ? ' success' : ' warning')}><b>SMS delivery:</b> {sms.label}.</p>
      <div>
        <Toggle label="Text guests when tickets are reserved" description="Includes the booking reference and a reminder to pay at the entrance." checked={form.draft.smsBookings} onChange={v => form.set('smsBookings', v)} disabled={!ctx.canManage} />
        <Toggle label="Text guests when their order is ready" checked={form.draft.smsOrderReady} onChange={v => form.set('smsOrderReady', v)} disabled={!ctx.canManage} />
        <Toggle label="Alert staff about new orders" description="New bookings always notify staff in the dashboard bell." checked={form.draft.staffNewOrders} onChange={v => form.set('staffNewOrders', v)} disabled={!ctx.canManage} />
      </div>
      <p className="footnote">Sign-in codes are always sent by SMS and cannot be turned off.</p>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'notifications', values: form.draft })} />}
    </>
  );
}

function Support({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.support, setDirty);
  const save = useSaver(ctx, form);
  const d = form.draft;
  const setFaq = (i, key, value) => form.set('faq', d.faq.map((f, j) => (j === i ? { ...f, [key]: value } : f)));
  const move = (i, delta) => { const faq = [...d.faq]; [faq[i], faq[i + delta]] = [faq[i + delta], faq[i]]; form.set('faq', faq); };
  return (
    <>
      <Head title="Help & support">Contact details and answers shown in the guest app's Help screen.</Head>
      <Locked ctx={ctx} />
      <div className="formrow">
        <Field label="Support email" type="email" value={d.email} onChange={e => form.set('email', e.target.value)} disabled={!ctx.canManage} />
        <Field label="Support phone" type="tel" value={d.phone} maxLength={30} onChange={e => form.set('phone', e.target.value)} disabled={!ctx.canManage} />
      </div>
      <Field label="Support hours" placeholder="e.g. Event nights, 6 PM – midnight" value={d.hours} maxLength={120} onChange={e => form.set('hours', e.target.value)} disabled={!ctx.canManage} />
      <div className="stack">
        <div className="row spread"><h3>Frequently asked questions</h3><span className="hint">{d.faq.length}/20</span></div>
        {d.faq.map((f, i) => (
          <div className="faq-edit" key={i}>
            <Field label={`Question ${i + 1}`} value={f.q} maxLength={150} onChange={e => setFaq(i, 'q', e.target.value)} disabled={!ctx.canManage} />
            <Field label="Answer"><textarea value={f.a} maxLength={1000} onChange={e => setFaq(i, 'a', e.target.value)} disabled={!ctx.canManage} /></Field>
            {ctx.canManage && (
              <div className="row">
                <button type="button" className="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon name="up" /></button>
                <button type="button" className="ghost" disabled={i === d.faq.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon name="down" /></button>
                <button type="button" className="ghost danger-text" style={{ marginLeft: 'auto' }} onClick={() => form.set('faq', d.faq.filter((_, j) => j !== i))}>Remove</button>
              </div>
            )}
          </div>
        ))}
        {ctx.canManage && d.faq.length < 20 && <button type="button" style={{ justifySelf: 'start' }} onClick={() => form.set('faq', [...d.faq, { q: '', a: '' }])}><Icon name="add" />Add question</button>}
        <p className="footnote">Guests also see Encore's standard answers about reservations, table ordering and sign-in codes.</p>
      </div>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'support', values: d })} />}
    </>
  );
}

function Legal({ ctx, setDirty }) {
  const form = useDraft(ctx.state.settings.legal, setDirty);
  const save = useSaver(ctx, form);
  return (
    <>
      <Head title="Terms & privacy">Your organization's terms for reservations, entry and orders.</Head>
      <Locked ctx={ctx} />
      <p className="notice">Guests always see Encore's platform terms. Anything you add here is shown as your organization's additional terms. Have your terms reviewed by a qualified legal advisor before publishing.</p>
      <Field label="Event & venue terms" hint={`${form.draft.terms.length.toLocaleString()} / 20,000 characters`}>
        <textarea rows={10} value={form.draft.terms} maxLength={20000} placeholder="Refunds, age limits, entry rules, what happens if an event is cancelled…" onChange={e => form.set('terms', e.target.value)} disabled={!ctx.canManage} />
      </Field>
      <Field label="Privacy notice" hint={`${form.draft.privacy.length.toLocaleString()} / 20,000 characters`}>
        <textarea rows={8} value={form.draft.privacy} maxLength={20000} placeholder="How your organization uses guest names and phone numbers…" onChange={e => form.set('privacy', e.target.value)} disabled={!ctx.canManage} />
      </Field>
      <ErrorText>{form.error}</ErrorText>
      {ctx.canManage && <SaveBar form={form} onSave={() => save('config', { group: 'legal', values: form.draft })} />}
    </>
  );
}
