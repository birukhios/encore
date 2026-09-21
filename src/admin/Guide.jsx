import React, { useState } from 'react';
import { copyText, Icon } from '../shared/ui';
import { PageActions } from './pages';

/*
 * "How to use Encore" for organizers and their staff.
 * Written as tasks, not features: each step says what to click and what happens next.
 */

const SETUP = [
  ['Add your organization', 'Settings → Profile: name, description, city and address, photos and your logo. Guests see this page before they book.', 'Settings'],
  ['Create your first event', 'Events → Add event: name, date and time, venue, ticket price, capacity and a cover photo. Publish it when you are ready to sell.', 'Events'],
  ['Choose how guests pay', 'Settings → Payments: cash for food & drinks, and whether guests may reserve tickets and pay at the entrance. Online wallet payments switch on once AfroPay is connected.', 'Settings'],
  ['Set VAT and your TIN', 'Settings → VAT: 15% is added on top of your prices by default. Add your TIN so it appears on receipts.', 'Settings'],
  ['Build the menu', 'Menu → Add item: photo, price, category, and which concerts it is served at. Turn on “Track stock” for anything you count.', 'Menu'],
  ['Print table QR codes', 'Tables → Add table: pick the concert and seats. Print the QR code; guests scan it to order to that table.', 'Tables'],
  ['Add your waiters', 'Waiters → Add waiter: each gets a 4-digit number. Print the badge — guests type that number so their tip reaches the right person.', 'Waiters'],
  ['Invite your team', 'Team → Invite: Admin (everything), Service (orders and payments), Gate (check-in only).', 'Team'],
];

const FLOWS = [
  {
    icon: 'ticket', title: 'Selling tickets',
    steps: [
      'Publish the event; share the guest link from Settings → Profile (or the Overview page).',
      'Guests sign in with their phone number and reserve tickets. Every ticket gets its own QR code.',
      'Online payment is taken by the wallet provider. If you accept payment at the entrance, the booking stays “Unpaid” until your staff record the money.',
      'Bookings shows every reservation. Use “Record payment” when a guest pays you in person.',
    ],
  },
  {
    icon: 'table', title: 'Table ordering',
    steps: [
      'Guests scan the QR code on their table (or type the 6-letter code under it).',
      'They see the menu for that concert only, add items, choose a tip and their waiter’s number.',
      'They pay with a wallet, or choose Cash and pay the waiter.',
      'The order appears in Orders. Move it Placed → Preparing → Ready → Delivered; the guest is notified at each step.',
    ],
  },
  {
    icon: 'menu', title: 'Taking an order yourself',
    steps: [
      'Orders → New order.',
      'Tap the items, choose the table, the waiter and any tip.',
      'Choose Cash, Card at venue, or “Not paid yet”.',
      'Place the order, then print the receipt or the kitchen ticket.',
    ],
  },
  {
    icon: 'success', title: 'Check-in on the night',
    steps: [
      'Bookings → Scan ticket: use the camera, or type the reference (for example EN-ABC123).',
      'Each ticket can be used once. Unpaid or cancelled bookings are refused — take payment first.',
      'Check-ins shows who has arrived, when, and which staff member let them in. Click a guest for their tickets, orders and payments.',
    ],
  },
  {
    icon: 'grid', title: 'Stock',
    steps: [
      'Stock → Store items: what you buy — beer, wine, bread, meat — with its unit, cost and reorder level.',
      'Record deliveries, what the kitchen and bar use, waste, and counts. Every change is logged with who made it.',
      'Stock → Menu items: what guests order. Orders reduce it automatically and sold-out items disappear from the guest menu.',
    ],
  },
  {
    icon: 'chart', title: 'Reports',
    steps: [
      'Overview shows the last 7 or 30 days with the change against the previous period.',
      'Reports has six tabs: Overview, Sales, Menu, Tables & tips, Guests and Timing, plus suggestions based on your own sales.',
      'Every view exports to CSV or a branded PDF you can send to partners.',
    ],
  },
];

const NIGHT = [
  ['Before doors open', 'Check Stock for red “Reorder” items. Open Orders on the tablet. Make sure gate staff are signed in.'],
  ['At the door', 'Scan each ticket once. Take payment for unpaid bookings, then check the guest in.'],
  ['During the show', 'Watch Orders: Placed → Preparing → Ready → Delivered. Print kitchen tickets if your kitchen needs paper.'],
  ['After the show', 'Record any outstanding payments, then open Reports for the night’s sales, tips by waiter and best sellers.'],
];

const FAQ = [
  ['A guest cannot receive their sign-in code.', 'Check the number is Ethiopian format (09… or +2519…). Codes expire after 5 minutes and can be resent after 60 seconds. If nobody receives codes, SMS is not connected — tell your Encore administrator.'],
  ['A guest wants to pay in cash.', 'Turn on Settings → Payments. For food & drinks the order goes to the kitchen immediately; for tickets the booking is held until staff record the payment.'],
  ['The ticket QR will not scan.', 'Type the reference number instead (EN-ABC123). It admits the next unused ticket on that booking.'],
  ['An item sold out mid-service.', 'Stock → Menu items → Adjust, or turn off “Available to order”. Guests stop seeing it straight away.'],
  ['A staff member left.', 'Team → remove them (Owner only). Their sessions end immediately.'],
  ['I forgot my password.', 'Use “Forgot password?” with the recovery code you saved. If that is lost, your Encore administrator can issue a new one.'],
  ['Prices look wrong.', 'Settings → VAT decides whether VAT is added on top, and Settings → Tips & service charge decides the service charge. The total on the guest’s screen is always what your settings produce.'],
];

export default function Guide({ ctx }) {
  const { state, session, role, go } = ctx;
  const [copied, setCopied] = useState(false);
  const link = ctx.guestLink('');
  const canManage = ctx.canManage;
  const visible = canManage ? SETUP : [];

  return (
    <>
      <PageActions>
        <button onClick={() => window.print()}><Icon name="download" />Print</button>
        <button className="primary" onClick={async () => { setCopied(await copyText(link)); setTimeout(() => setCopied(false), 2500); }}>
          <Icon name="copy" />{copied ? 'Link copied' : 'Copy guest link'}
        </button>
      </PageActions>

      <section className="card guide-hero">
        <div>
          <span className="eyebrow accent">Welcome to Encore</span>
          <h2>Everything your venue needs for one night, in one place.</h2>
          <p>Sell tickets, take table orders, track stock and see what sold — from your phone or a laptop. This page is your handbook; open it any time from the sidebar.</p>
        </div>
        <ul className="guide-facts">
          <li><b>{state.events.length}</b>events</li>
          <li><b>{state.menu.length}</b>menu items</li>
          <li><b>{state.tables.length}</b>tables</li>
          <li><b>{(state.waiters || []).length}</b>waiters</li>
        </ul>
      </section>

      {canManage && (
        <section className="card">
          <div className="card-head"><div><h2>Set up in eight steps</h2><p>Each step links to the screen where you do it.</p></div></div>
          <ol className="guide-steps">
            {visible.map(([title, body, page], i) => (
              <li key={title}>
                <span className="guide-num">{i + 1}</span>
                <div>
                  <b>{title}</b>
                  <p>{body}</p>
                  <button className="linklike small" onClick={() => go(page)}>Open {page}<Icon name="next" /></button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="report-grid">
        {FLOWS.map(flow => (
          <section className="card" key={flow.title}>
            <div className="card-head"><h2><span className="guide-icon"><Icon name={flow.icon} /></span>{flow.title}</h2></div>
            <ol className="guide-list">{flow.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </section>
        ))}
      </div>

      <section className="card">
        <div className="card-head"><div><h2>Running a night</h2><p>A simple routine that works for most venues.</p></div></div>
        <div className="guide-night">
          {NIGHT.map(([when, what]) => <div key={when}><b>{when}</b><p>{what}</p></div>)}
        </div>
      </section>

      <div className="report-grid">
        <section className="card">
          <div className="card-head"><div><h2>Who can do what</h2><p>Roles are enforced by the server, not just hidden in the menu.</p></div></div>
          <ul className="plain-list">
            <li><span><b>Owner</b><small>Everything, including removing team members</small></span><span className="badge neutral">{session.team.filter(u => u.role === 'Owner').length}</span></li>
            <li><span><b>Admin</b><small>Events, menu, stock, waiters, settings, reports</small></span><span className="badge neutral">{session.team.filter(u => u.role === 'Admin').length}</span></li>
            <li><span><b>Service</b><small>Orders, new orders, record payments</small></span><span className="badge neutral">{session.team.filter(u => u.role === 'Service').length}</span></li>
            <li><span><b>Gate</b><small>Check-in only</small></span><span className="badge neutral">{session.team.filter(u => u.role === 'Gate').length}</span></li>
          </ul>
          {canManage && <button className="linklike small" onClick={() => go('Team')}>Manage the team<Icon name="next" /></button>}
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Your guest link</h2><p>Share it on social media, posters and WhatsApp. It opens your page in any phone browser — nothing to install.</p></div></div>
          <div className="row wrap">
            <input readOnly value={link} aria-label="Guest link" onFocus={e => e.target.select()} />
            <button onClick={async () => { setCopied(await copyText(link)); setTimeout(() => setCopied(false), 2500); }}><Icon name="copy" />Copy</button>
            <a className="linklike small" href={link} target="_blank" rel="noreferrer">Open<Icon name="next" /></a>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>Each table's QR code opens the same page with that table already selected.</p>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><div><h2>Common questions</h2><p>{role === 'Gate' ? 'Ask an admin if you need a setting changed.' : 'If something here does not match what you see, refresh the page.'}</p></div></div>
        <div className="guide-faq">
          {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
        </div>
      </section>
    </>
  );
}
