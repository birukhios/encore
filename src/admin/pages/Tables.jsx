import React, { useState } from 'react';
import { shortDate } from '../../shared/api';
import QR from '../../shared/QR';
import { Empty, ErrorText, Field, Icon, Modal } from '../../shared/ui';
import { PageActions, useRunner } from './common';

export function Tables({ ctx }) {
  const { state, matches } = ctx;
  const [editing, setEditing] = useState(null);
  const [qr, setQr] = useState(null);
  const [menuQr, setMenuQr] = useState(false);
  const [eventFilter, setEventFilter] = useState('All');
  const tables = state.tables.filter(t => eventFilter === 'All' || t.event === eventFilter).filter(t => matches(t.name, t.code));
  const eventName = id => state.events.find(e => e.id === id)?.name || 'Concert removed';
  return (
    <>
      <PageActions><button onClick={() => setMenuQr(true)}>Menu QR</button><button className="primary" onClick={() => setEditing({})} disabled={!state.events.length}><Icon name="add" />Add table</button></PageActions>
      <section className="card">
        <div className="card-head">
          <div className="chips">
            {['All', ...state.events.map(e => e.id)].map(id => (
              <button key={id} className={'chip' + (eventFilter === id ? ' active' : '')} onClick={() => setEventFilter(id)}>{id === 'All' ? 'All concerts' : eventName(id)}</button>
            ))}
          </div>
          <span className="badge neutral">{tables.length} tables</span>
        </div>
        {!state.events.length ? (
          <Empty icon="calendar" title="Create a concert first" body="Every table belongs to a concert, so guests order from the right menu." action="Go to events" onAction={() => ctx.go('Events')} />
        ) : tables.length ? (
          <>
            <div className="stage">STAGE</div>
            <div className="floor">
              {tables.map(t => (
                <div className={'tablecard ' + t.status.toLowerCase()} key={t.id}>
                  <div className="row spread"><h3>{t.name}</h3><span className={'badge ' + (t.status === 'Available' ? 'success' : 'neutral')}>{t.status}</span></div>
                  <small className="muted">{t.seats} seats · Code <b style={{ color: 'var(--ink)' }}>{t.code}</b></small>
                  <small className="muted">{eventName(t.event)}</small>
                  <div className="row">
                    <button onClick={() => setEditing(t)}>Edit</button>
                    <button className="primary" onClick={() => setQr(t)}>QR code</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : <Empty icon="table" title="A seat at your next show" body="Add tables to a concert. Each table gets a permanent QR code and a short code guests can type." action="Add table" onAction={() => setEditing({})} />}
      </section>
      {editing && <TableForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
      {menuQr && (
        <Modal title={state.name} eyebrow="Scan to see the menu and order" onClose={() => setMenuQr(false)}
          footer={<><button onClick={() => window.print()}>Print</button><button className="primary" onClick={() => setMenuQr(false)}>Done</button></>}>
          <div className="printable stack center" style={{ justifyItems: 'center' }}>
            <p><b>Menu</b></p>
            <QR value={ctx.guestLink('&view=menu')} name={state.name + ' menu QR code'} />
            <p className="small">Scan, sign in with your phone, and enter your waiter's number</p>
          </div>
          <p className="footnote noprint">One code for the whole venue: put it on every table and wall. {state.settings.ordering.requireScan ? 'Table scanning is still switched on in Settings → Table ordering, so guests will also be asked to scan their table.' : 'Guests order without scanning a table and say which waiter serves them.'}</p>
        </Modal>
      )}
      {qr && (
        <Modal title={qr.name} eyebrow="Scan. Order. Enjoy." onClose={() => setQr(null)}
          footer={<><button onClick={() => window.print()}>Print</button><button className="primary" onClick={() => setQr(null)}>Done</button></>}>
          <div className="printable stack center" style={{ justifyItems: 'center' }}>
            <p>{eventName(qr.event)}</p>
            <QR value={ctx.guestLink('&table=' + encodeURIComponent(qr.token))} name={qr.name + ' QR code'} />
            <p className="small">Can't scan? Enter table code</p>
            <span className="tablecode">{qr.code}</span>
          </div>
          <p className="footnote noprint">Place this on the table. The code stays the same for this table and concert. Guests' phones must be able to reach {new URL(ctx.session.guestOrigin).host}.</p>
        </Modal>
      )}
    </>
  );
}

function TableForm({ ctx, item, onClose }) {
  const { state } = ctx;
  const { busy, error, run } = useRunner();
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    run(async () => { await ctx.action('table', { ...v, event: item.event || v.event, id: item.id }); onClose(); });
  };
  const remove = () => confirm(`Delete ${item.name}? Its QR code will stop working.`) && run(async () => { await ctx.action('delete', { kind: 'table', id: item.id }); onClose(); });
  return (
    <Modal title={item.id ? 'Edit table' : 'Add table'} eyebrow={state.name} onClose={onClose}
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="table-form" disabled={busy}>{busy ? 'Saving…' : 'Save table'}</button>
      </>}>
      <form id="table-form" className="form" onSubmit={submit}>
        <Field label="Table name" name="name" defaultValue={item.name || 'Table ' + (state.tables.length + 1)} maxLength={120} required />
        <Field label="Concert" hint={item.id ? 'A table stays linked to its concert so printed QR codes never change meaning.' : undefined}>
          <select name="event" defaultValue={item.event} required disabled={!!item.id}>
            <option value="">Choose concert</option>
            {state.events.map(e => <option key={e.id} value={e.id}>{e.name} · {shortDate(e.date)}</option>)}
          </select>
        </Field>
        <div className="formrow">
          <Field label="Seats" name="seats" type="number" min="1" max="30" defaultValue={item.seats || 4} required />
          <Field label="Status">
            <select name="status" defaultValue={item.status || 'Available'}><option>Available</option><option>Reserved</option><option>Blocked</option></select>
          </Field>
        </div>
        <p className="footnote">Blocked tables cannot place orders.</p>
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}
