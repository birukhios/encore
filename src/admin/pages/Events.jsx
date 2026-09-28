import React, { useState } from 'react';
import { dateTime } from '../../shared/api';
import ImageUpload from '../../shared/ImageUpload';
import { LogoMark } from '../../shared/Logo';
import { eventStatus } from '../../shared/eventStatus';
import { Empty, ErrorText, Field, Icon, Modal, Toggle } from '../../shared/ui';
import { PageActions, useRunner } from './common';

export function Events({ ctx }) {
  const { state, money, canManage, matches } = ctx;
  const [editing, setEditing] = useState(ctx.intent === 'create' && canManage ? {} : null);
  const events = [...state.events].sort((a, b) => a.date.localeCompare(b.date)).filter(e => matches(e.name, e.venue));
  return (
    <>
      {canManage && <PageActions><button className="primary" onClick={() => setEditing({})}><Icon name="add" />Add event</button></PageActions>}
      {events.length ? (
        <div className="cards">
          {events.map(e => {
            const sold = state.bookings.filter(b => b.event === e.id && b.status !== 'Cancelled').reduce((s, b) => s + b.qty, 0);
            return (
              <article className="eventcard" key={e.id}>
                {e.image ? <img className="cover" src={e.image} alt="" /> : <div className="cover placeholder"><LogoMark size={44} /></div>}
                <div className="eventbody">
                  <div className="row spread">
                    {(st => <span className={'badge ' + st.tone}>{st.label}</span>)(eventStatus(e, { soldOut: sold >= e.capacity }))}
                    <small className="muted">{dateTime(e.date)}</small>
                  </div>
                  <h2>{e.name}</h2>
                  <p className="small">{e.venue}{e.salesEnd ? ` · Sales close ${dateTime(e.salesEnd)}` : ''}</p>
                  <p className="description">{e.description}</p>
                  <div className="meter" aria-label={`${sold} of ${e.capacity} reserved`}><span style={{ width: Math.min(100, (sold / e.capacity) * 100) + '%' }} /></div>
                  <div className="eventfoot">
                    <div className="price"><small>{sold}/{e.capacity} reserved</small><b>{e.price ? money(e.price) : 'Free'}</b></div>
                    {canManage && <button onClick={() => setEditing(e)}><Icon name="pencil" />Edit</button>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="card">
          <Empty title={ctx.search ? 'No matching events' : 'Your lineup starts here'} body={ctx.search ? 'Try a different search.' : 'Create a concert to start taking reservations.'} action={canManage && !ctx.search ? 'Add event' : null} onAction={() => setEditing({})} />
        </section>
      )}
      {editing && <EventForm ctx={ctx} item={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EventForm({ ctx, item, onClose }) {
  const [image, setImage] = useState(item.image || '');
  const [published, setPublished] = useState(!!item.published);
  const [cancelled, setCancelled] = useState(!!item.cancelled);
  const { busy, error, run } = useRunner();
  const submit = e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    run(async () => { await ctx.action('event', { ...v, id: item.id, image, published, cancelled }); onClose(); });
  };
  const remove = () => {
    if (!confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    run(async () => { await ctx.action('delete', { kind: 'event', id: item.id }); onClose(); });
  };
  return (
    <Modal title={item.id ? 'Edit event' : 'Create event'} eyebrow={ctx.state.name} onClose={onClose} wide
      footer={<>
        {item.id && <button type="button" className="ghost danger-text" style={{ marginRight: 'auto' }} onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="primary" form="event-form" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</button>
      </>}>
      <form id="event-form" className="form" onSubmit={submit}>
        <ImageUpload value={image} onChange={setImage} />
        <Field label="Event name" name="name" defaultValue={item.name} maxLength={120} required />
        <div className="formrow">
          <Field label="Date & time" type="datetime-local" name="date" defaultValue={item.date} required />
          <Field label="Venue" name="venue" defaultValue={item.venue} maxLength={150} required />
        </div>
        <Field label="About this event"><textarea name="description" defaultValue={item.description} maxLength={1000} required /></Field>
        <div className="formrow">
          <Field label={`Ticket price (${ctx.state.currency})`} name="price" type="number" step="0.01" min="0" defaultValue={(item.price || 0) / 100} required hint="Use 0 for free entry." />
          <Field label="Capacity" name="capacity" type="number" min="1" max="100000" defaultValue={item.capacity || 200} required />
        </div>
        <Field label="Ticket sales close (optional)" type="datetime-local" name="salesEnd" defaultValue={item.salesEnd || ''} hint="After this time guests can no longer book. Leave empty to sell until the event starts." />
        <Toggle label="Publish to guest app" description="Guests can see and reserve this event." checked={published} onChange={setPublished} />
        {item.id && <Toggle label="Event cancelled" description="Guests see it as cancelled and can no longer book. Existing bookings stay so you can contact guests." checked={cancelled} onChange={setCancelled} />}
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

// Money actually collected (paid, not cancelled), split by payment method and by event, with what is still pending.
