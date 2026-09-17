import React, { useEffect, useMemo, useState } from 'react';
import { api, dateTime, timeAgo } from '../shared/api';
import QR from '../shared/QR';
import Logo, { LogoMark } from '../shared/Logo';
import Scanner from '../shared/Scanner';
import { copyText, Empty, ErrorText, Glyph, Icon, Modal, Spinner, StarIcon } from '../shared/ui';
import { PLATFORM_FAQ, PLATFORM_PRIVACY, PLATFORM_TERMS } from './content';

const ORDER_STEPS = ['Placed', 'Preparing', 'Ready', 'Delivered'];

/** Mirrors domain.tax_for on the server, for display before checkout. The server's quote is authoritative. */
export function taxFor(cfg, kind, cents) {
  if (!cfg || cfg.regime === 'none' || !cfg[kind === 'booking' ? 'tickets' : 'menu'] || cents <= 0) return null;
  const rate = cfg.vatRate;
  if (!rate) return null;
  const amount = cfg.pricesIncludeTax ? Math.round(cents * rate / (100 + rate)) : Math.round(cents * rate / 100);
  return { label: `VAT ${rate}%`, amount, included: cfg.pricesIncludeTax };
}

function Title({ eyebrow, title, children }) {
  return (
    <div className="guest-title">
      {eyebrow && <span className="eyebrow accent">{eyebrow}</span>}
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}

const statusBadge = r => r.status === 'Cancelled'
  ? <span className="badge neutral">Cancelled</span>
  : r.paid ? <span className="badge success">{r.settlement === 'demo' ? 'Paid · demo' : 'Paid'}</span> : <span className="badge warning">Pay at venue</span>;

// ---------------------------------------------------------------- directory

export function Stars({ value = 0, size = 14, label }) {
  const full = Math.round(value * 2) / 2;
  return (
    <span className="stars" style={{ fontSize: size }} role="img" aria-label={label || `${value || 0} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(i => <StarIcon key={i} size={size + 2} filled={full >= i ? 1 : full >= i - 0.5 ? 0.5 : 0} />)}
    </span>
  );
}

function RatingBadge({ rating }) {
  if (!rating?.count) return <span className="muted small">New on Encore</span>;
  return <span className="row" style={{ gap: 6 }}><Stars value={rating.average} /><b className="small">{rating.average.toFixed(1)}</b><span className="muted small">({rating.count})</span></span>;
}

export function Directory({ workspaces, error, onPick }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = workspaces.filter(w => !q || [w.name, w.city, w.address].join(' ').toLowerCase().includes(q));
  const coming = workspaces.flatMap(w => (w.nextEvents || []).map(e => ({ ...e, org: w }))).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
  const fmt = (cents, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'ETB' }).format(cents / 100);
  return (
    <div className="home">
      <header className="home-top">
        <Logo size={30} />
      </header>
      <section className="home-hero">
        <div className="home-hero-glow" aria-hidden="true" />
        <span className="eyebrow accent">Live music · great food · your table</span>
        <h1>Good nights<br />start here.</h1>
        <p>Find concerts near you, book your tickets in seconds, and order to your table when you arrive.</p>
        <label className="home-search">
          <Icon name="search" />
          <input type="search" placeholder="Search venues or cities" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search venues or cities" />
        </label>
        <div className="home-stats">
          <span><b>{workspaces.length}</b> venue{workspaces.length === 1 ? '' : 's'}</span>
          <span><b>{workspaces.reduce((n, w) => n + (w.events || 0), 0)}</b> upcoming events</span>
          <span><b>Online</b> tickets</span>
        </div>
      </section>
      <ErrorText>{error}</ErrorText>

      {coming.length > 0 && !q && (
        <section className="home-section">
          <div className="row spread"><h2>Coming up</h2><span className="muted small">Swipe for more</span></div>
          <div className="rail">
            {coming.map(e => (
              <button key={e.org.id + e.id} className="railcard" onClick={() => onPick(e.org.id)}>
                {e.image || e.org.photo ? <img src={e.image || e.org.photo} alt="" /> : <span className="cover placeholder"><LogoMark size={40} /></span>}
                <span className="railcard-body">
                  <span className="datechip"><b>{new Date(e.date).getDate()}</b>{new Date(e.date).toLocaleString('en', { month: 'short' })}</span>
                  <b>{e.name}</b>
                  <small>{e.org.name}</small>
                  <span className="price-tag">{e.price ? fmt(e.price, e.org.currency) : 'Free'}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-section">
        <div className="row spread"><h2>{q ? `Results for “${query.trim()}”` : 'Venues & organizers'}</h2><span className="muted small">{shown.length}</span></div>
        <div className="guest-grid orgs">
          {shown.map(w => (
            <button key={w.id} className="orgtile" onClick={() => onPick(w.id)} aria-label={`${w.name}${w.city ? ', ' + w.city : ''}`}>
              <span className="orgtile-photo">
                {w.photo ? <img src={w.photo} alt="" /> : <span className="cover placeholder"><LogoMark size={40} /></span>}
                {w.logo && <img className="orgtile-logo" src={w.logo} alt="" />}
                {w.events > 0 && <span className="orgtile-pill">{w.events} event{w.events > 1 ? 's' : ''}</span>}
              </span>
              <span className="orgtile-body">
                <b>{w.name}</b>
                <RatingBadge rating={w.rating} />
                {(w.address || w.city) && <small><Icon name="venue" size="sm" /> {[w.address, w.city].filter(Boolean).join(', ')}</small>}
              </span>
            </button>
          ))}
        </div>
        {!shown.length && !error && <Empty icon="search" title={q ? 'No matches' : 'No venues yet'} body={q ? 'Try another name or city.' : 'Check back soon for upcoming concerts.'} />}
      </section>

      <section className="home-section how">
        <h2>How Encore works</h2>
        <div className="how-grid">
          {[['ticket', 'Book online', 'Choose your concert and pay with your wallet. Your QR tickets arrive instantly.'], ['table', 'Scan your table', 'At the venue, scan the QR on your table to open that night’s menu.'], ['bell', 'Relax & enjoy', 'Order, add a tip if you like, and follow your order to your seat.']].map(([icon, title, body], i) => (
            <div key={title} className="how-step"><span className="how-num">{i + 1}</span><Icon name={icon} /><b>{title}</b><p>{body}</p></div>
          ))}
        </div>
      </section>
      <footer className="home-foot">encore · Live for the moment.</footer>
    </div>
  );
}

// ---------------------------------------------------------------- organizer page

export function EventsScreen({ ctx }) {
  const { data, money, setSheet, myEvents } = ctx;
  const profile = data.settings.profile;
  const cover = profile.photos[0] || data.settings.theme.cover;
  const events = [...data.events].sort((a, b) => a.date.localeCompare(b.date));
  const ticketing = data.settings.ticketing;
  const [photo, setPhoto] = useState(null);
  const where = [profile.address, profile.city].filter(Boolean).join(', ');
  return (
    <>
      <section className="org-hero">
        {cover ? <img src={cover} alt="" /> : <div className="cover placeholder" />}
        <div className="org-hero-body">
          {data.settings.theme.logo && <img className="org-logo" src={data.settings.theme.logo} alt="" />}
          <div className="grow" style={{ minWidth: 0 }}>
            <h1>{data.name}</h1>
            <div className="row wrap" style={{ gap: '6px 14px' }}>
              <RatingBadge rating={data.ratings} />
              {where && <span className="small org-where"><Icon name="venue" size="sm" /> {where}</span>}
            </div>
          </div>
        </div>
      </section>

      <div className="org-layout">
        <div className="org-main">
          {data.description && <p className="org-about">{data.description}</p>}
          {!ticketing.enabled && <p className="notice">Ticket sales are currently closed.</p>}
          <div className="row spread"><h2>Upcoming events</h2><span className="muted small">{events.length}</span></div>
          {events.length ? <div className="event-list">{events.map(e => {
            const d = new Date(e.date);
            return (
              <article className="eventcard" key={e.id}>
                <div className="eventmedia">
                  {e.image ? <img className="cover" src={e.image} alt="" /> : <div className="cover placeholder"><LogoMark size={44} /></div>}
                  <span className="datechip"><b>{d.getDate()}</b>{d.toLocaleString('en', { month: 'short' })}</span>
                </div>
                <div className="eventbody">
                  <div className="row spread wrap">
                    <span className="small muted">{dateTime(e.date)}</span>
                    {myEvents.includes(e.id) ? <span className="badge success">You're going</span> : e.soldOut ? <span className="badge neutral">Sold out</span> : e.remaining !== undefined ? <span className="badge">{e.remaining} left</span> : null}
                  </div>
                  <h3 className="eventtitle">{e.name}</h3>
                  <p className="small"><Icon name="venue" size="sm" /> {e.venue}</p>
                  <p className="description">{e.description}</p>
                  <div className="eventfoot">
                    <div className="price"><small>Admission</small><b>{e.price ? money(e.price) : 'Free'}</b></div>
                    <button className="primary" disabled={!ticketing.enabled || e.soldOut} onClick={() => setSheet({ type: 'booking', event: e })}>
                      {e.soldOut ? 'Sold out' : 'Get tickets'}<Icon name="next" />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}</div> : <section className="card"><Empty icon="calendar" title="The next show is coming" body="No concerts are on sale right now. Check back soon." /></section>}

          {profile.photos.length > 0 && (
            <section className="stack">
              <h2>Photos</h2>
              <div className={'photo-mosaic count-' + Math.min(profile.photos.length, 5)}>
                {profile.photos.slice(0, 5).map((url, i) => (
                  <button key={url} className="mosaic-item" onClick={() => setPhoto(i)} aria-label={`Open photo ${i + 1} of ${profile.photos.length}`}>
                    <img src={url} alt="" loading="lazy" />
                    {i === 4 && profile.photos.length > 5 && <span className="mosaic-more">+{profile.photos.length - 5}</span>}
                  </button>
                ))}
              </div>
            </section>
          )}
          <Reviews ctx={ctx} />
        </div>

        <aside className="org-side">
          <section className="card stack">
            <h3>Location</h3>
            {where ? <p style={{ color: 'var(--ink)' }}>{where}</p> : <p>Ask the organizer for directions.</p>}
            {data.mapLink && <a className="button primary block" href={data.mapLink} target="_blank" rel="noreferrer noopener"><Icon name="venue" />Open in Google Maps</a>}
          </section>
          {(data.settings.support.phone || data.settings.support.email) && (
            <section className="card stack">
              <h3>Contact</h3>
              {data.settings.support.phone && <a className="button block" href={'tel:' + data.settings.support.phone.replace(/[^\d+]/g, '')}>Call {data.settings.support.phone}</a>}
              {data.settings.support.email && <a className="button block" href={'mailto:' + data.settings.support.email}><Icon name="support" />Email</a>}
              {data.settings.support.hours && <p className="small"><Icon name="clock" size="sm" /> {data.settings.support.hours}</p>}
            </section>
          )}
        </aside>
      </div>

      {photo !== null && (
        <Modal label="Photo" onClose={() => setPhoto(null)} wide
          footer={<>
            <button onClick={() => setPhoto((photo - 1 + profile.photos.length) % profile.photos.length)} aria-label="Previous photo"><Glyph name="chevron-left" size={18} />Previous</button>
            <span className="muted small grow center">{photo + 1} / {profile.photos.length}</span>
            <button onClick={() => setPhoto((photo + 1) % profile.photos.length)} aria-label="Next photo">Next<Glyph name="chevron-right" size={18} /></button>
          </>}>
          <img src={profile.photos[photo]} alt={`${data.name} photo ${photo + 1}`} style={{ width: '100%', borderRadius: 12 }} />
        </Modal>
      )}
    </>
  );
}

function Reviews({ ctx }) {
  const { data, guest, records, requireAuth, tenant, toast } = ctx;
  const r = data.ratings || { count: 0 };
  const [stars, setStars] = useState(r.mine?.stars || 0);
  const [comment, setComment] = useState(r.mine?.comment || '');
  const [summary, setSummary] = useState(r);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setSummary(data.ratings || { count: 0 }); if (data.ratings?.mine) { setStars(data.ratings.mine.stars); setComment(data.ratings.mine.comment); } }, [data.ratings?.count, data.ratings?.average, data.ratings?.mine?.stars]);
  const canRate = guest && (records || []).length > 0;
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError('');
    try { setSummary(await api('guest/rating', { tenant, stars, comment })); toast('Thanks for your rating'); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return (
    <section className="stack">
      <div className="row spread wrap"><h2>Guest ratings</h2><RatingBadge rating={summary} /></div>
      {summary.recent?.length > 0 && (
        <div className="reviews">
          {summary.recent.map((x, i) => (
            <figure key={i} className="review">
              <Stars value={x.stars} size={13} />
              <blockquote>{x.comment}</blockquote>
              <figcaption>{x.name} · {timeAgo(x.updated)}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <form className="card stack" onSubmit={submit}>
        <b>{summary.mine ? 'Your rating' : 'Rate your experience'}</b>
        {canRate ? (
          <>
            <div className="starpicker" role="radiogroup" aria-label="Your rating">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={stars >= n ? 'on' : ''} onClick={() => setStars(n)}><StarIcon size={30} filled={stars >= n ? 1 : 0} /></button>
              ))}
            </div>
            <textarea placeholder="What made the night great? (optional)" maxLength={500} value={comment} onChange={e => setComment(e.target.value)} style={{ minHeight: 70 }} />
            <ErrorText>{error}</ErrorText>
            <button className="primary" disabled={busy || !stars} style={{ justifySelf: 'start' }}>{busy ? 'Saving…' : summary.mine ? 'Update rating' : 'Submit rating'}</button>
          </>
        ) : guest ? (
          <p className="small">You can rate {data.name} after booking tickets or ordering with them.</p>
        ) : (
          <button type="button" style={{ justifySelf: 'start' }} onClick={() => requireAuth('Sign in to rate this organizer', () => {})}>Sign in to rate</button>
        )}
      </form>
    </section>
  );
}

export function BookingSheet({ ctx, event, onClose }) {
  const { data, money, requireAuth, startCheckout } = ctx;
  const max = Math.min(data.settings.ticketing.maxPerOrder, event.remaining ?? Infinity);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = () => requireAuth('Sign in to reserve your tickets', async () => {
    setBusy(true);
    setError('');
    try {
      await startCheckout({ kind: 'booking', event: event.id, qty }, { type: 'booking', event });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  });
  return (
    <Modal sheet title={event.name} eyebrow="Your next live moment" onClose={onClose}
      footer={<button className="primary lg-btn block" disabled={busy} onClick={next}>{busy ? 'Checking availability…' : `Continue · ${money(event.price * qty + ((t => t && !t.included ? t.amount : 0)(taxFor(data.settings.tax, 'booking', event.price * qty))))}`}</button>}>
      <p>{event.venue} · {dateTime(event.date)}</p>
      <div className="row spread">
        <div><b>Tickets</b><small className="muted" style={{ display: 'block' }}>{event.price ? money(event.price) + ' each' : 'Free entry'} · up to {max}</small></div>
        <div className="stepper">
          <button aria-label="One fewer ticket" disabled={qty <= 1} onClick={() => setQty(q => q - 1)}>−</button>
          <output aria-live="polite">{qty}</output>
          <button aria-label="One more ticket" disabled={qty >= max} onClick={() => setQty(q => q + 1)}>+</button>
        </div>
      </div>
      {(() => { const t = taxFor(data.settings.tax, 'booking', event.price * qty); return t && <p className="small">{t.included ? `Includes ${t.label}: ${money(t.amount)}` : `Plus ${t.label}: ${money(t.amount)}`}</p>; })()}
      <p className="footnote">Tickets are paid online. Each ticket gets its own QR code and reference number for entry.</p>
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}

// ---------------------------------------------------------------- tickets & orders

export function TicketsScreen({ ctx }) {
  const { guest, records, requireAuth, tenant, setSheet, loadRecords, go } = ctx;
  const [linked, setLinked] = useState(null);
  const [linkError, setLinkError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!q.get('ref') || !q.get('token')) return;
    api(`receipt?tenant=${encodeURIComponent(tenant)}&ref=${encodeURIComponent(q.get('ref'))}&token=${encodeURIComponent(q.get('token'))}`)
      .then(r => { setLinked(r); setSheet({ type: 'receipt', receipt: r }); })
      .catch(e => setLinkError(e.message));
  }, []);
  const refresh = async () => { setRefreshing(true); await loadRecords(); setRefreshing(false); };
  const bookings = (records || []).filter(r => r.kind === 'booking');
  const orders = (records || []).filter(r => r.kind === 'order');
  const upcoming = bookings.filter(b => b.status === 'Reserved');
  const past = bookings.filter(b => b.status !== 'Reserved');
  return (
    <>
      <div className="row spread">
        <Title title="Tickets & orders" />
        {guest && <button className="icon-btn" aria-label="Refresh" onClick={refresh} disabled={refreshing}>{refreshing ? <Spinner /> : <Icon name="refresh" />}</button>}
      </div>
      <ErrorText>{linkError}</ErrorText>
      {linked && !guest && <RecordCard ctx={ctx} r={linked} />}
      {guest === null && !linked && (
        <section className="card"><Empty icon="ticket" title="Your pass to a great night" body="Sign in with your phone number to see your tickets, orders and their progress." action="Sign in" onAction={() => requireAuth(null, () => {})} /></section>
      )}
      {guest && records === null && <div className="skeleton" style={{ height: 180 }} />}
      {guest && records?.length === 0 && (
        <section className="card"><Empty icon="ticket" title="No tickets yet" body="Reserve tickets for a concert, then scan your table to order food and drinks." action="Explore events" onAction={() => go('events')} /></section>
      )}
      <div className="guest-grid">
        {orders.filter(o => ['Placed', 'Preparing', 'Ready'].includes(o.status)).map(r => <RecordCard key={r.ref} ctx={ctx} r={r} />)}
        {upcoming.map(r => <RecordCard key={r.ref} ctx={ctx} r={r} />)}
      </div>
      {(past.length > 0 || orders.some(o => !['Placed', 'Preparing', 'Ready'].includes(o.status))) && <h3 style={{ marginTop: 8 }}>Past</h3>}
      <div className="guest-grid">
        {[...orders.filter(o => !['Placed', 'Preparing', 'Ready'].includes(o.status)), ...past].sort((a, b) => b.created - a.created).map(r => <RecordCard key={r.ref} ctx={ctx} r={r} />)}
      </div>
    </>
  );
}

function RecordCard({ ctx, r }) {
  const { money, setSheet } = ctx;
  const booking = r.kind === 'booking';
  const step = ORDER_STEPS.indexOf(r.status);
  return (
    <article className="ticketcard">
      <div className="top">
        <div className="row spread">
          <span className="eyebrow accent" style={{ margin: 0 }}>{booking ? `${r.qty} ticket${r.qty > 1 ? 's' : ''}` : 'Table order'}</span>
          {statusBadge(r)}
        </div>
        <h2>{booking ? r.eventName : r.tableName || 'Counter pickup'}</h2>
        <p className="small">{booking ? `${r.venue} · ${dateTime(r.date)}` : r.items}</p>
      </div>
      <div className="perf" aria-hidden="true" />
      <div className="bottom">
        {!booking && r.status !== 'Cancelled' && (
          <div className="progress" role="img" aria-label={'Order status: ' + r.status}>
            {ORDER_STEPS.map((s, i) => <span key={s} className={step >= i ? 'done' : ''}>{s}</span>)}
          </div>
        )}
        {booking && r.status === 'Checked in' && <p className="notice success">Checked in. Enjoy the show!</p>}
        <div className="row spread">
          <div><small className="muted">{r.ref}</small><b style={{ display: 'block', fontSize: 16 }}>{money(r.total)}</b></div>
          <button className={booking && r.status === 'Reserved' ? 'primary' : ''} onClick={() => setSheet({ type: 'receipt', receipt: r })}>
            {booking && r.status === 'Reserved' ? 'Show tickets' : 'Receipt'}
          </button>
        </div>
      </div>
    </article>
  );
}

export function ReceiptModal({ ctx, receipt: r, onClose }) {
  const { money, tenant, toast } = ctx;
  const booking = r.kind === 'booking';
  const link = `${location.origin}/?tenant=${encodeURIComponent(tenant)}&view=tickets&ref=${encodeURIComponent(r.ref)}&token=${encodeURIComponent(r.token)}`;
  const status = r.status === 'Cancelled' ? 'This was cancelled by the organizer.'
    : r.paid ? (r.settlement === 'demo' ? 'Paid with a simulated demo payment. No money was charged.' : `Paid at the venue (${r.settledBy}).`)
    : booking ? 'Awaiting online payment.' : 'Not paid yet. Pay staff when your order arrives.';
  return (
    <Modal sheet eyebrow={r.merchant} title={booking ? (r.status === 'Reserved' ? "You're on the list." : r.eventName) : 'Order ' + r.status.toLowerCase() + '.'} label="Receipt" onClose={onClose}
      footer={<button className="primary block" onClick={onClose}>Done</button>}>
      <p>Reference <b style={{ color: 'var(--ink)' }}>{r.ref}</b> · {r.name}</p>
      {booking && <p className="small">{r.venue} · {dateTime(r.date)}</p>}
      {!booking && <p className="small">{r.tableName ? 'Delivering to ' + r.tableName : 'Collect at the counter'}{r.waiterName ? ` · Served by ${r.waiterName.split(' ')[0]} (#${r.waiterNumber})` : ''}</p>}
      <p className={'notice' + (r.paid ? ' success' : r.status === 'Cancelled' ? '' : ' warning')}>{status}</p>
      {booking && r.status !== 'Cancelled' && r.tickets.map(t => (
        <div className={'ticket-qr' + (t.used ? ' used' : '')} key={t.token}>
          <QR value={`${r.ref}:${t.serial}:${t.token}`} name={`Ticket ${t.serial} ${r.eventName}`} download={false} size={200} />
          <b>Ticket {t.serial} of {r.qty}</b>
          <small className="muted">{t.used ? 'Used for entry' : `Show this at the entrance · Ref ${r.ref}`}</small>
        </div>
      ))}
      <div className="totals">
        {r.lines.map((l, i) => <div className="line" key={i}><span>{l.qty} × {l.name}</span><b>{money(l.total)}</b></div>)}
        {r.service && <div className="line"><span>{r.service.label}</span><b>{money(r.service.amount)}</b></div>}
        {r.tax && <div className="line"><span>{r.tax.label} {r.tax.included ? '(included)' : ''}</span><b>{money(r.tax.amount)}</b></div>}
        {!booking && <div className="line"><span>Tip</span><b>{money(r.tip || 0)}</b></div>}
        <div className="line total"><span>Total</span><span>{money(r.total)}</span></div>
        {r.tin && <small className="muted">{r.merchant} · TIN {r.tin}{r.vatNumber ? ` · VAT reg. ${r.vatNumber}` : ''} · Not a fiscal receipt</small>}
      </div>
      <div className="stack">
        <small className="muted">Private receipt link — open your {booking ? 'tickets' : 'order'} on another device. Anyone with it can view them.</small>
        <div className="row">
          <input readOnly value={link} aria-label="Private receipt link" onFocus={e => e.target.select()} />
          <button onClick={async () => toast(await copyText(link) ? 'Link copied' : 'Select and copy the link')} aria-label="Copy receipt link"><Icon name="copy" /></button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- menu

function useMenu(ctx) {
  const { data, table, myEvents } = ctx;
  const cfg = data.settings.ordering;
  return useMemo(() => {
    const eventName = id => data.events.find(e => e.id === id)?.name;
    let focus = table ? [table.event] : cfg.eventMenus && myEvents.length ? myEvents : null;
    const items = data.menu.filter(i => !cfg.eventMenus || !focus || !i.events?.length || i.events.some(e => focus.includes(e)));
    const needsScan = cfg.requireScan && !table;
    const needsTicket = !!table && cfg.ticketHoldersOnly && !myEvents.includes(table.event);
    const canOrder = cfg.enabled && !needsScan && !needsTicket && table?.status !== 'Blocked';
    return { items, needsScan, needsTicket, canOrder, eventName, cfg };
  }, [data, table, myEvents]);
}

export function MenuScreen({ ctx }) {
  const { data, table, cart, setCart, money, setSheet, clearTable, go, guest, requireAuth } = ctx;
  const { items, needsScan, needsTicket, canOrder, eventName, cfg } = useMenu(ctx);
  const [category, setCategory] = useState('All');
  const categories = ['All', ...data.settings.menu.categories.filter(c => items.some(i => i.category === c))];
  const shown = items.filter(i => category === 'All' || i.category === category);
  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  const subtotal = data.menu.filter(i => cart[i.id]).reduce((s, i) => s + i.price * cart[i.id], 0);

  if (!cfg.enabled) return <><Title title="Menu" /><section className="card"><Empty icon="menu" title="Ordering is closed" body="Food and drink orders are not being taken right now." /></section></>;

  return (
    <>
      <Title eyebrow={table ? table.name : undefined} title="Good taste. Great night." />
      {table ? (
        <div className="tablebanner">
          <Icon name="table" size="lg" />
          <div className="grow"><b>{table.name}</b><small>{eventName(table.event) || 'Table service'}</small></div>
          <button className="ghost small" onClick={() => setSheet({ type: 'scan' })}>Change</button>
        </div>
      ) : cfg.requireScan && (
        <section className="card scan-card">
          <span className="scan-glyph"><Icon name="table" /></span>
          <div><h2>Scan your table to order</h2><p style={{ marginTop: 6 }}>Scan the QR code on your table so we deliver to the right seat.</p></div>
          <button className="primary lg-btn block" onClick={() => setSheet({ type: 'scan' })}>Scan table QR code</button>
        </section>
      )}
      {needsTicket && (
        <div className="notice warning" role="status">
          Ordering at {table.name} is for ticket holders of <b>{eventName(table.event)}</b>.
          <div className="row wrap" style={{ marginTop: 10 }}>
            {!guest && <button onClick={() => requireAuth('Sign in with the number you used to reserve', () => {})}>I have a ticket — sign in</button>}
            <button className="primary" onClick={() => go('events')}>Get tickets</button>
          </div>
        </div>
      )}
      {table?.status === 'Blocked' && <p className="notice warning">This table isn't taking orders. Please ask a member of staff. <button className="linklike" onClick={clearTable}>Use another table</button></p>}
      {items.length > 0 && categories.length > 2 && (
        <div className="chips" role="tablist" aria-label="Menu categories">
          {categories.map(c => <button key={c} role="tab" aria-selected={category === c} className={'chip' + (category === c ? ' active' : '')} onClick={() => setCategory(c)}>{c}</button>)}
        </div>
      )}
      {shown.length ? (
        <div className="guest-grid menu">
          {shown.map(i => {
            const n = cart[i.id] || 0;
            return (
              <article className={'menuitem' + (i.available ? '' : ' unavailable')} key={i.id}>
                {i.image ? <img className="thumb" src={i.image} alt="" /> : <div className="thumb"><Icon name="menu" size="lg" /></div>}
                <div className="grow">
                  <small className="muted">{i.category}</small>
                  <h3>{i.name}</h3>
                  <p>{i.description}</p>
                  <b style={{ display: 'block', marginTop: 4 }}>{money(i.price)}</b>
                  {i.available && i.left > 0 && <small className="left-badge">Only {i.left} left</small>}
                </div>
                {i.available ? (
                  <button className={'add' + (n ? ' has' : '')} aria-label={n ? `Add another ${i.name}, ${n} in bag` : `Add ${i.name}`} disabled={!canOrder}
                    onClick={() => setCart({ ...cart, [i.id]: Math.min(50, n + 1) })}>
                    {n ? n : <Icon name="add" />}
                  </button>
                ) : <span className="badge neutral">Sold out</span>}
              </article>
            );
          })}
        </div>
      ) : <section className="card"><Empty icon="menu" title="Something delicious is on the way" body={table ? 'The menu for this concert is being prepared.' : 'The organizer is preparing the menu.'} /></section>}
      {needsScan && items.length > 0 && <p className="footnote center">You can browse now. Scan your table to start adding items.</p>}
      {count > 0 && (
        <div className="cartbar">
          <div><b>{count} item{count > 1 ? 's' : ''}</b><small>{money(subtotal)}</small></div>
          <button className="primary" onClick={() => go('bag')}>View bag<Icon name="next" /></button>
        </div>
      )}
    </>
  );
}

export function TableScan({ ctx, onClose }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const use = async value => {
    setBusy(true);
    setError('');
    try {
      const found = await ctx.selectTable(value);
      if (found) { onClose(); ctx.go('menu'); }
    } catch (e) {
      setError(e.message);
      setAttempt(a => a + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal sheet title="Scan your table" eyebrow="Table ordering" onClose={onClose}>
      <Scanner key={attempt} onResult={use} hint="Point your camera at the QR code on your table" />
      <ErrorText>{error}</ErrorText>
      <form className="stack" onSubmit={e => { e.preventDefault(); if (code.length === 6) use(code); }}>
        <label className="field">Or enter the 6-character code under the QR
          <div className="codeentry">
            <input value={code} onChange={e => setCode(e.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase())} placeholder="ABC123" autoComplete="off" autoCapitalize="characters" aria-label="Table code" />
            <button className="primary" disabled={busy || code.length !== 6}>{busy ? '…' : 'Go'}</button>
          </div>
        </label>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- bag

export function Bag({ ctx }) {
  const { data, table, cart, setCart, tip, setTip, money, go, requireAuth, startCheckout, setSheet } = ctx;
  const { items: served, canOrder, needsScan, needsTicket } = useMenu(ctx);
  const tips = data.settings.tips;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lines = data.menu.filter(i => cart[i.id]);
  const notServed = lines.filter(i => !served.some(s => s.id === i.id) || !i.available);
  const subtotal = lines.reduce((s, i) => s + i.price * cart[i.id], 0);
  const tipAmount = tips.enabled ? Math.round(Number(tip || 0) * 100) : 0;
  const serviceCfg = data.settings.service || { enabled: false, rate: 0 };
  const service = serviceCfg.enabled && subtotal > 0 ? { label: `Service charge ${serviceCfg.rate}%`, amount: Math.round((subtotal * serviceCfg.rate) / 100) } : null;
  const tax = taxFor(data.settings.tax, 'menu', subtotal + (service?.amount || 0));
  const [waiter, setWaiter] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const [quote, setQuote] = useState(null);
  useEffect(() => {
    // The server's quote is authoritative; the local figures above only fill the gap while it loads.
    setQuote(null);  // show local figures immediately; replaced by the server quote moments later
    if (!lines.length || !canOrder) return;
    const id = setTimeout(() => {
      api('quote', { tenant: ctx.tenant, kind: 'menu', items: cart, tipAmount: String(tips.enabled ? Number(tip || 0) : 0), table: table?.token || '', waiter })
        .then(q => { setQuote(q); setQuoteError(''); }).catch(e => { setQuote(null); setQuoteError(e.message); });
    }, 350);
    return () => clearTimeout(id);
  }, [JSON.stringify(cart), tip, table?.token, canOrder, waiter]);
  const shownTax = quote ? quote.tax : tax;
  const shownService = quote ? quote.service : service;
  const shownTip = quote ? quote.tip : tipAmount;
  const shownTotal = quote ? quote.total : subtotal + (service?.amount || 0) + (tax && !tax.included ? tax.amount : 0) + tipAmount;
  const askWaiter = data.waiters && (tips.enabled || serviceCfg.enabled);
  const change = (id, delta) => {
    const next = { ...cart, [id]: Math.max(0, Math.min(50, (cart[id] || 0) + delta)) };
    if (!next[id]) delete next[id];
    setCart(next);
  };
  const checkout = () => requireAuth('Sign in to place your order', async () => {
    setBusy(true);
    setError('');
    try {
      await startCheckout({ kind: 'menu', items: cart, tipAmount: String(tips.enabled ? Number(tip || 0) : 0), table: table?.token || '', waiter }, null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  });
  if (!lines.length) return <><Title title="Your bag" /><section className="card"><Empty icon="table" title="Your bag is waiting" body="Find something you love from the menu." action="Explore the menu" onAction={() => go('menu')} /></section></>;
  return (
    <>
      <Title title="Your bag" eyebrow={table ? 'Delivering to ' + table.name : undefined} />
      <div className="bag-layout">
      <div className="stack lg">
      <section className="card">
        <div className="list">
          {lines.map(i => (
            <div className="listrow" key={i.id}>
              <div className="grow"><b>{i.name}</b><small>{money(i.price)} each{notServed.includes(i) ? ' · not available here' : ''}</small></div>
              <div className="stepper">
                <button aria-label={'Remove one ' + i.name} onClick={() => change(i.id, -1)}>−</button>
                <output>{cart[i.id]}</output>
                <button aria-label={'Add one ' + i.name} onClick={() => change(i.id, 1)}>+</button>
              </div>
            </div>
          ))}
        </div>
        {notServed.length > 0 && <p className="notice warning" style={{ marginTop: 10 }}>Some items aren't available {table ? 'at this concert' : 'right now'}. <button className="linklike" onClick={() => { const next = { ...cart }; notServed.forEach(i => delete next[i.id]); setCart(next); }}>Remove them</button></p>}
      </section>
      {tips.enabled && (
        <section className="card stack">
          <div><h3>Leave a little love</h3><p className="small">Tips are optional, go to the team, and are never taxed.</p></div>
          <div className="tips" role="radiogroup" aria-label="Tip amount">
            {[0, ...tips.presets].map(n => (
              <button key={n} role="radio" aria-checked={Number(tip) === n} className={Number(tip) === n ? 'active' : ''} onClick={() => setTip(n)}>{n ? money(n * 100).replace(/\.00$/, '') : 'No tip'}</button>
            ))}
          </div>
          {tips.custom && (
            <label className="field">Other amount ({data.currency})
              <input type="text" inputMode="decimal" placeholder="0" value={tip === 0 ? '' : tip}
                onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ''); if (/^\d{0,5}(\.\d{0,2})?$/.test(v)) setTip(v === '' ? 0 : v); }} />
            </label>
          )}
        </section>
      )}
      {askWaiter && (
        <section className="card stack">
          <div><h3>Who is serving you?</h3><p className="small">Optional. Enter the number on your waiter's badge{tips.enabled ? ' so your tip goes to them' : ''}.</p></div>
          <label className="field">Waiter number
            <input type="text" inputMode="numeric" placeholder="e.g. 4821" maxLength={6} value={waiter} onChange={e => setWaiter(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          </label>
          {waiter.length === 4 && quote?.waiter && <p className="notice success small">Served by {quote.waiter.name} · #{quote.waiter.number}</p>}
        </section>
      )}
      </div>
      <section className="card stack bag-summary">
        <div className="totals">
          <div className="line"><span>Items</span><b>{money(subtotal)}</b></div>
          {shownService && <div className="line"><span>{shownService.label}</span><b>{money(shownService.amount)}</b></div>}
          {shownTax && <div className="line"><span>{shownTax.label} {shownTax.included ? '(included)' : ''}</span><b>{money(shownTax.amount)}</b></div>}
          {tips.enabled && <div className="line"><span>Tip</span><b>{money(shownTip)}</b></div>}
          <div className="line total"><span>Total</span><span>{money(shownTotal)}</span></div>
        </div>
        {needsScan ? (
          <button className="primary lg-btn block" onClick={() => setSheet({ type: 'scan' })}>Scan your table to continue</button>
        ) : needsTicket ? (
          <p className="notice warning">This table is for ticket holders. <button className="linklike" onClick={() => go('menu')}>See options</button></p>
        ) : (
          <button className="primary lg-btn block" disabled={busy || !canOrder || notServed.length > 0 || (waiter.length > 0 && !quote?.waiter)} onClick={checkout}>
            {busy ? 'Checking your order…' : 'Continue to checkout'}<Icon name="next" />
          </button>
        )}
        <ErrorText>{error || (lines.length && canOrder ? quoteError : '')}</ErrorText>
      </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- account, notifications, help, legal

export function Account({ ctx, setGuest, signOut, onClose, switchOrganizer }) {
  const { guest, go, requireAuth, data } = ctx;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(guest?.name || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const open = view => { onClose(); go(view); };
  const save = async e => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setGuest((await api('guest/profile', { name })).guest);
      setEditing(false);
      ctx.toast('Name updated');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const Link = ({ icon, label, onClick }) => <button className="menulink" onClick={onClick}><Icon name={icon} />{label}<span className="chev"><Icon name="next" /></span></button>;
  return (
    <Modal sheet title={guest ? guest.name : 'Account'} eyebrow={guest ? guest.phone : data.name} onClose={onClose} label="Account and help">
      {guest ? (
        editing ? (
          <form className="stack" onSubmit={save}>
            <label className="field">Your name<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required autoFocus /></label>
            <ErrorText>{error}</ErrorText>
            <div className="row"><button type="button" onClick={() => setEditing(false)}>Cancel</button><button className="primary grow" disabled={busy}>Save</button></div>
          </form>
        ) : <button onClick={() => setEditing(true)}><Icon name="pencil" />Edit name</button>
      ) : (
        <button className="primary lg-btn block" onClick={() => { onClose(); requireAuth(null, () => {}); }}>Sign in or create account</button>
      )}
      <div className="list accountsheet">
        <Link icon="ticket" label="My tickets & orders" onClick={() => open('tickets')} />
        <Link icon="bell" label="Notifications" onClick={() => { onClose(); requireAuth('Get updates on your tickets and orders', () => go('notifications')); }} />
        <Link icon="support" label="Help & support" onClick={() => open('help')} />
        <Link icon="edit" label="Terms & conditions" onClick={() => open('terms')} />
        <Link icon="edit" label="Privacy" onClick={() => open('privacy')} />
        <Link icon="grid" label="Encore home · all venues" onClick={switchOrganizer} />
      </div>
      {guest && <button className="ghost danger-text" onClick={signOut}>Sign out</button>}
    </Modal>
  );
}

export function NotificationsScreen({ ctx }) {
  const { guest, notifications, setNotifications, loadNotifications, requireAuth } = ctx;
  useEffect(() => {
    if (!guest || !notifications.some(n => !n.read)) return;
    api('guest/notifications/read', {}).then(() => setTimeout(() => setNotifications(list => list.map(n => ({ ...n, read: 1 }))), 2500)).catch(() => {});
  }, [guest?.id, notifications.length]);
  useEffect(() => { loadNotifications(); }, []);
  if (!guest) return <><Title title="Notifications" /><section className="card"><Empty icon="bell" title="Stay in the loop" body="Sign in to get updates when your tickets are confirmed and your order is on its way." action="Sign in" onAction={() => requireAuth(null, () => {})} /></section></>;
  return (
    <>
      <Title title="Notifications" />
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {notifications.length ? notifications.map(n => (
          <div key={n.id} className={'notif' + (n.read ? '' : ' unread')}>
            <Icon name={n.kind === 'placed' || n.kind === 'paid' ? 'ticket' : n.kind?.startsWith('order') ? 'menu' : 'bell'} />
            <div className="grow"><b>{n.title}</b><p>{n.body}</p><small>{n.merchant} · {timeAgo(n.created)}</small></div>
          </div>
        )) : <Empty icon="bell" title="No notifications yet" body="Updates about your tickets and orders will appear here." />}
      </section>
    </>
  );
}

export function HelpScreen({ ctx }) {
  const { data } = ctx;
  const s = data.settings.support;
  return (
    <>
      <Title title="Help & support" eyebrow={data.name}>We're here to make your night easy.</Title>
      <div className="help-layout">
      <section className="card stack">
        <h3>Contact {data.name}</h3>
        {s.email || s.phone ? (
          <div className="row wrap">
            {s.phone && <a className="button primary grow" href={'tel:' + s.phone.replace(/[^\d+]/g, '')}>Call {s.phone}</a>}
            {s.email && <a className="button grow" href={'mailto:' + s.email}><Icon name="support" />Email support</a>}
          </div>
        ) : <p className="small">Ask a member of staff at the venue for help.</p>}
        {s.hours && <p className="small"><Icon name="clock" size="sm" /> {s.hours}</p>}
      </section>
      {s.faq.length > 0 && (
        <section className="stack">
          <h3>From {data.name}</h3>
          <div>{s.faq.map((f, i) => <details className="faq" key={i}><summary>{f.q}</summary><p>{f.a}</p></details>)}</div>
        </section>
      )}
      <section className="stack">
        <h3>Using Encore</h3>
        <div>{PLATFORM_FAQ.map(([q, a]) => <details className="faq" key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
      </section>
      </div>
    </>
  );
}

export function LegalScreen({ ctx, kind, embedded }) {
  const { data } = ctx;
  const terms = kind === 'terms';
  const extra = terms ? data.settings.legal.terms : data.settings.legal.privacy;
  const body = (
    <div className="prose">
      {embedded && <h2>{terms ? 'Terms & conditions' : 'Privacy'}</h2>}
      <p>{terms ? PLATFORM_TERMS : PLATFORM_PRIVACY}</p>
      {extra && <><h3>{data.name}</h3><p>{extra}</p></>}
    </div>
  );
  if (embedded) return body;
  return (
    <>
      <Title title={terms ? 'Terms & conditions' : 'Privacy'} eyebrow="Encore" />
      <section className="card">{body}</section>
    </>
  );
}
