// Reporting and analytics over a workspace's bookings and orders. All amounts are integer cents.
// Only paid, non-cancelled records count as sales. Everything here is pure so it can be checked in isolation.

export const isSale = r => r.paid && r.status !== 'Cancelled';
export const sum = (list, fn) => list.reduce((total, x) => total + (fn(x) || 0), 0);
export const vatOf = r => r.tax?.amount || 0;
const ratio = (a, b) => (b ? a / b : 0);
const DAY = 86400;
export const WALLET_NAMES = { telebirr: 'Telebirr', 'cbe-birr': 'CBE Birr', mpesa: 'M-PESA', 'awash-birr': 'Awash Birr' };
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function paymentLabel(r) {
  if (r.status === 'Cancelled') return 'Cancelled';
  if (!r.paid) return 'Unpaid';
  if (r.wallet) return `${WALLET_NAMES[r.wallet] || r.wallet}${r.settlement === 'demo' ? ' (demo)' : ''}`;
  return r.settlement === 'demo' ? 'Online (demo)' : r.settledBy || 'Paid';
}

export const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStart = s => new Date(s + 'T00:00:00').getTime() / 1000;
const dayEnd = s => new Date(s + 'T23:59:59').getTime() / 1000;

/** Records within the date range (inclusive, local dates as YYYY-MM-DD) and event filter. */
export function filterRecords(state, { from = '', to = '', eventId = 'all' } = {}) {
  const start = from ? dayStart(from) : -Infinity;
  const end = to ? dayEnd(to) : Infinity;
  const keep = r => r.created >= start && r.created <= end && (eventId === 'all' || r.event === eventId);
  return { bookings: state.bookings.filter(keep), orders: state.orders.filter(keep) };
}

/** The period of equal length immediately before [from, to], for period-over-period comparison. */
export function previousPeriod({ from, to }) {
  if (!from || !to) return null;
  const days = Math.round((dayStart(to) - dayStart(from)) / DAY) + 1;
  const prevTo = new Date(dayStart(from) * 1000 - DAY * 1000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * DAY * 1000);
  return { from: isoDay(prevFrom), to: isoDay(prevTo), days };
}

/** Relative change; null when there is no base to compare against. */
export const change = (now, before) => (before ? (now - before) / Math.abs(before) : null);

const guestKey = r => r.guest || r.phone || r.name;

function summarize(state, bookings, orders, eventId) {
  const soldBookings = bookings.filter(isSale);
  const soldOrders = orders.filter(isSale);
  const sales = [...soldBookings, ...soldOrders];
  const tickets = soldBookings.flatMap(b => b.tickets || []);
  const tipped = soldOrders.filter(o => (o.tip || 0) > 0);
  const events = state.events.filter(e => (eventId === 'all' ? soldBookings.some(b => b.event === e.id) : e.id === eventId));
  const capacity = sum(events, e => e.capacity);
  const s = {
    gross: sum(sales, r => r.total),
    ticketSales: sum(soldBookings, r => r.subtotal),
    menuSales: sum(soldOrders, r => r.subtotal),
    tips: sum(soldOrders, r => r.tip),
    vat: sum(sales, vatOf),
    ticketsSold: tickets.length,
    checkedIn: tickets.filter(t => t.used).length,
    bookings: soldBookings.length,
    orders: soldOrders.length,
    itemsSold: sum(soldOrders, o => sum(o.lines, l => l.qty)),
    cancelled: [...bookings, ...orders].filter(r => r.status === 'Cancelled').length,
    unpaid: [...bookings, ...orders].filter(r => !r.paid && r.status !== 'Cancelled').length,
    guests: new Set(sales.map(guestKey)).size,
    capacity,
  };
  s.refundsOrCancelled = s.cancelled + s.unpaid;
  s.net = s.gross - s.tips - s.vat;
  s.avgOrder = s.orders ? Math.round(sum(soldOrders, r => r.total) / s.orders) : 0;
  s.avgTicketPrice = s.ticketsSold ? Math.round(s.ticketSales / s.ticketsSold) : 0;
  s.avgBookingSize = ratio(s.ticketsSold, s.bookings);
  s.itemsPerOrder = ratio(s.itemsSold, s.orders);
  s.checkinRate = ratio(s.checkedIn, s.ticketsSold);
  s.sellThrough = ratio(s.ticketsSold, capacity);
  s.tipRate = ratio(s.tips, s.menuSales);
  s.tipParticipation = ratio(tipped.length, s.orders);
  s.avgTip = tipped.length ? Math.round(s.tips / tipped.length) : 0;
  s.spendPerGuest = s.guests ? Math.round(s.gross / s.guests) : 0;
  s.fnbPerAttendee = s.checkedIn ? Math.round(s.menuSales / s.checkedIn) : 0;
  s.menuShare = ratio(s.menuSales, s.menuSales + s.ticketSales);
  // Attach rate: ticket holders who also ordered food or drinks at the same event.
  const holders = new Set(soldBookings.map(b => `${guestKey(b)}|${b.event}`));
  const buyers = new Set(soldOrders.map(o => `${guestKey(o)}|${o.event}`));
  s.attachRate = ratio([...holders].filter(k => buyers.has(k)).length, holders.size);
  return { s, soldBookings, soldOrders, sales };
}

export function buildReport(state, filters = {}) {
  const eventId = filters.eventId || 'all';
  const { bookings, orders } = filterRecords(state, filters);
  const { s: summary, soldBookings, soldOrders, sales } = summarize(state, bookings, orders, eventId);

  const prevRange = previousPeriod(filters);
  let previous = null;
  if (prevRange) {
    const prev = filterRecords(state, { ...prevRange, eventId });
    previous = { ...prevRange, summary: summarize(state, prev.bookings, prev.orders, eventId).s };
  }

  const eventName = id => state.events.find(e => e.id === id)?.name || '—';

  const byEvent = state.events
    .map(e => {
      const eb = soldBookings.filter(b => b.event === e.id);
      const eo = soldOrders.filter(o => o.event === e.id);
      const et = eb.flatMap(b => b.tickets || []);
      const checkedIn = et.filter(t => t.used).length;
      const menuSales = sum(eo, r => r.subtotal);
      const gross = sum([...eb, ...eo], r => r.total);
      return {
        id: e.id, name: e.name, date: e.date, capacity: e.capacity, price: e.price,
        ticketsSold: et.length, checkedIn, sellThrough: ratio(et.length, e.capacity), noShowRate: et.length ? 1 - checkedIn / et.length : 0,
        ticketSales: sum(eb, r => r.subtotal), orders: eo.length, menuSales, tips: sum(eo, r => r.tip), vat: sum([...eb, ...eo], vatOf), gross,
        fnbPerAttendee: checkedIn ? Math.round(menuSales / checkedIn) : 0, grossPerAttendee: checkedIn ? Math.round(gross / checkedIn) : 0,
      };
    })
    .filter(row => row.ticketsSold || row.orders)
    .sort((a, b) => b.gross - a.gross);

  // Menu performance, including items that did not sell (slow movers).
  const categoryOf = name => state.menu.find(i => i.name === name)?.category || 'Uncategorized';
  const items = new Map(state.menu.map(i => [i.name, { name: i.name, category: i.category || 'Uncategorized', price: i.price, available: i.available !== false, qty: 0, revenue: 0, orders: 0 }]));
  for (const o of soldOrders) {
    for (const line of o.lines) {
      const row = items.get(line.name) || { name: line.name, category: categoryOf(line.name), price: line.price, available: false, qty: 0, revenue: 0, orders: 0 };
      row.qty += line.qty;
      row.revenue += line.total;
      row.orders += 1;
      items.set(line.name, row);
    }
  }
  const menuRows = [...items.values()].map(i => ({ ...i, share: ratio(i.revenue, summary.menuSales), attach: ratio(i.orders, summary.orders) }));
  const bestSellers = menuRows.filter(i => i.qty).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);
  const slowMovers = menuRows.filter(i => i.available).sort((a, b) => a.qty - b.qty || a.revenue - b.revenue).slice(0, 8);
  // Pareto: share of food & drink revenue from the top 20% of selling items.
  const byRevenue = [...bestSellers].sort((a, b) => b.revenue - a.revenue);
  const topCount = Math.max(1, Math.ceil(byRevenue.length * 0.2));
  const pareto = { items: byRevenue.length ? topCount : 0, share: ratio(sum(byRevenue.slice(0, topCount), i => i.revenue), summary.menuSales) };

  const cats = new Map();
  for (const i of bestSellers) {
    const row = cats.get(i.category) || { category: i.category, qty: 0, revenue: 0, items: 0 };
    row.qty += i.qty;
    row.revenue += i.revenue;
    row.items += 1;
    cats.set(i.category, row);
  }
  const categories = [...cats.values()].map(c => ({ ...c, share: ratio(c.revenue, summary.menuSales) })).sort((a, b) => b.revenue - a.revenue);

  const tables = new Map();
  for (const o of soldOrders) {
    const key = o.tableName || 'Counter pickup';
    const row = tables.get(key) || { name: key, event: eventName(o.event), orders: 0, items: 0, revenue: 0, subtotal: 0, tips: 0, tippedOrders: 0 };
    row.orders += 1;
    row.items += sum(o.lines, l => l.qty);
    row.revenue += o.total;
    row.subtotal += o.subtotal;
    row.tips += o.tip || 0;
    if ((o.tip || 0) > 0) row.tippedOrders += 1;
    tables.set(key, row);
  }
  const tableRows = [...tables.values()].map(t => ({
    ...t, avgOrder: Math.round(t.revenue / t.orders), tipRate: ratio(t.tips, t.subtotal), avgTip: t.tippedOrders ? Math.round(t.tips / t.tippedOrders) : 0,
    tipParticipation: ratio(t.tippedOrders, t.orders),
  }));
  const busyTables = [...tableRows].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);
  const topTipped = tableRows.filter(t => t.tips > 0).sort((a, b) => b.tips - a.tips || b.tipRate - a.tipRate);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0, bookings: 0 }));
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const byWeekday = DAY_NAMES.map((day, i) => ({ day, index: i, orders: 0, bookings: 0, gross: 0 }));
  for (const r of sales) {
    const d = new Date(r.created * 1000);
    const isBooking = 'qty' in r;
    byHour[d.getHours()][isBooking ? 'bookings' : 'orders'] += 1;
    if (!isBooking) {
      byHour[d.getHours()].revenue += r.total;
      heatmap[d.getDay()][d.getHours()] += 1;
    }
    byWeekday[d.getDay()][isBooking ? 'bookings' : 'orders'] += 1;
    byWeekday[d.getDay()].gross += r.total;
  }

  const methods = new Map();
  for (const r of sales) {
    const label = paymentLabel(r);
    const row = methods.get(label) || { method: label, count: 0, amount: 0 };
    row.count += 1;
    row.amount += r.total;
    methods.set(label, row);
  }
  const payments = [...methods.values()].map(p => ({ ...p, share: ratio(p.amount, summary.gross) })).sort((a, b) => b.amount - a.amount);

  const days = new Map();
  for (const r of sales) {
    const key = isoDay(new Date(r.created * 1000));
    const row = days.get(key) || { date: key, tickets: 0, menu: 0, tips: 0, vat: 0, gross: 0, orders: 0, ticketsSold: 0 };
    if ('qty' in r) { row.tickets += r.subtotal; row.ticketsSold += r.qty; } else { row.menu += r.subtotal; row.orders += 1; row.tips += r.tip || 0; }
    row.vat += vatOf(r);
    row.gross += r.total;
    days.set(key, row);
  }
  const daily = fillDays([...days.values()].sort((a, b) => a.date.localeCompare(b.date)), filters);

  // Guests: lifetime value within the period, repeat behaviour.
  const people = new Map();
  for (const r of sales) {
    const key = guestKey(r);
    const row = people.get(key) || { key, name: r.name, phone: r.phone, guest: r.guest, bookings: 0, orders: 0, tickets: 0, spent: 0, tips: 0, events: new Set(), first: r.created, last: r.created };
    if ('qty' in r) { row.bookings += 1; row.tickets += r.qty; } else { row.orders += 1; row.tips += r.tip || 0; }
    row.spent += r.total;
    if (r.event) row.events.add(r.event);
    row.first = Math.min(row.first, r.created);
    row.last = Math.max(row.last, r.created);
    people.set(key, row);
  }
  const guestRows = [...people.values()].map(g => ({ ...g, events: g.events.size, visits: g.bookings + g.orders }));
  const topGuests = [...guestRows].sort((a, b) => b.spent - a.spent);
  const repeat = guestRows.filter(g => g.events > 1 || g.visits > 1).length;
  const guests = {
    unique: guestRows.length, repeat, repeatRate: ratio(repeat, guestRows.length),
    ticketOnly: guestRows.filter(g => g.bookings && !g.orders).length, orderOnly: guestRows.filter(g => g.orders && !g.bookings).length,
    both: guestRows.filter(g => g.orders && g.bookings).length,
    top10Share: ratio(sum(topGuests.slice(0, 10), g => g.spent), summary.gross),
  };

  const latest = [...bookings, ...orders].sort((a, b) => b.created - a.created).slice(0, 10);
  const report = { latest, summary, previous, byEvent, bestSellers, slowMovers, pareto, categories, busyTables, topTipped, byHour, byWeekday, heatmap, payments, daily, topGuests, guests };
  report.insights = insights(report);
  report.suggestions = suggestions(report);
  return report;
}

/** Continuous daily series (no gaps) for bounded periods up to a year, so trends read correctly. */
function fillDays(rows, { from, to }) {
  if (!rows.length) return rows;
  const start = from || rows[0].date;
  const end = to || rows[rows.length - 1].date;
  const span = Math.round((dayStart(end) - dayStart(start)) / DAY);
  if (span < 0 || span > 366) return rows;
  const byDate = new Map(rows.map(r => [r.date, r]));
  const out = [];
  for (let i = 0; i <= span; i++) {
    const key = isoDay(new Date((dayStart(start) + i * DAY + 7200) * 1000));
    out.push(byDate.get(key) || { date: key, tickets: 0, menu: 0, tips: 0, vat: 0, gross: 0, orders: 0, ticketsSold: 0 });
  }
  return out;
}

const pctText = n => `${Math.round(n * 100)}%`;
const hourText = h => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

/** Plain-language findings. Each: { tone: 'good' | 'watch' | 'info', title, body }. Money is formatted by the caller. */
function insights(r) {
  const out = [];
  const s = r.summary;
  if (r.previous?.summary.gross) {
    const c = change(s.gross, r.previous.summary.gross);
    out.push({ tone: c >= 0 ? 'good' : 'watch', title: `Gross sales ${c >= 0 ? 'up' : 'down'} ${pctText(Math.abs(c))}`, body: `Compared with the previous ${r.previous.days} days.` });
  }
  if (r.bestSellers[0] && s.menuSales) {
    const top = r.bestSellers[0];
    out.push({ tone: 'info', title: `${top.name} is the best seller`, body: `${top.qty} sold, ${pctText(top.share)} of food & drink revenue, in ${pctText(top.attach)} of orders.` });
  }
  if (r.pareto.items && r.bestSellers.length >= 5) {
    out.push({ tone: 'info', title: `Top ${r.pareto.items} item${r.pareto.items > 1 ? 's' : ''} earn ${pctText(r.pareto.share)} of F&B revenue`, body: 'Keep them in stock and visible on the menu.' });
  }
  const peak = [...r.byHour].sort((a, b) => b.orders - a.orders)[0];
  if (peak?.orders) out.push({ tone: 'info', title: `Peak ordering hour: ${hourText(peak.hour)}`, body: `${peak.orders} orders. Schedule extra service staff around this time.` });
  if (r.busyTables[0] && r.busyTables[0].name !== 'Counter pickup') out.push({ tone: 'info', title: `${r.busyTables[0].name} is the busiest table`, body: `${r.busyTables[0].orders} orders, ${r.busyTables[0].items} items.` });
  if (s.ticketsSold >= 5 && s.checkinRate < 0.6) out.push({ tone: 'watch', title: `Only ${pctText(s.checkinRate)} of tickets checked in`, body: 'Past events may not have been scanned at the door, or guests did not show up.' });
  if (s.orders >= 5 && s.tipParticipation < 0.25) out.push({ tone: 'watch', title: `Few orders include a tip (${pctText(s.tipParticipation)})`, body: 'Suggested tip amounts in Settings can raise participation.' });
  if (s.ticketsSold >= 5 && s.attachRate < 0.3) out.push({ tone: 'watch', title: `${pctText(s.attachRate)} of ticket holders ordered food or drinks`, body: 'Promote table ordering with QR codes on tables and at the entrance.' });
  const slow = r.slowMovers.filter(i => !i.qty);
  if (s.orders >= 5 && slow.length) out.push({ tone: 'watch', title: `${slow.length} menu item${slow.length > 1 ? 's' : ''} did not sell`, body: slow.slice(0, 3).map(i => i.name).join(', ') + (slow.length > 3 ? '…' : '') });
  if (r.guests.unique >= 5) out.push({ tone: r.guests.repeatRate >= 0.3 ? 'good' : 'info', title: `${pctText(r.guests.repeatRate)} of guests came back`, body: `${r.guests.repeat} of ${r.guests.unique} guests booked or ordered more than once.` });
  return out;
}

/**
 * Actions to grow sales, ranked by expected impact. Each: { priority: 'high' | 'medium', area, title, body, metric }.
 * Only produced when the data supports them, so a quiet workspace gets few or none.
 */
function suggestions(r) {
  const s = r.summary;
  const out = [];
  const add = (score, priority, area, title, body, metric) => out.push({ score, priority, area, title, body, metric });
  const enough = s.bookings + s.orders >= 5;
  if (!enough) return [];

  const weak = r.byEvent.filter(e => new Date(e.date) > new Date() && e.sellThrough < 0.5 && e.capacity >= 20).sort((a, b) => a.sellThrough - b.sellThrough)[0];
  if (weak) add(90, 'high', 'Tickets', `Push ticket sales for ${weak.name}`,
    `Only ${pctText(weak.sellThrough)} of seats are sold. Share the guest link on social media, offer an early-bird or group price, and remind past guests.`, `${weak.ticketsSold}/${weak.capacity} sold`);

  const hot = r.byEvent.filter(e => e.sellThrough >= 0.85).sort((a, b) => b.sellThrough - a.sellThrough)[0];
  if (hot) add(70, 'medium', 'Tickets', `Add capacity or a second date like ${hot.name}`,
    `${pctText(hot.sellThrough)} sold. Demand is strong: consider a higher price tier, more seats, or a repeat show.`, `${hot.ticketsSold}/${hot.capacity} sold`);

  if (s.ticketsSold >= 10 && s.attachRate < 0.5) add(85, 'high', 'Food & drinks', 'Turn more ticket holders into food & drink buyers',
    `${pctText(s.attachRate)} of ticket holders ordered. Put table QR codes on every table, announce ordering from the stage, and add a combo to the menu.`, `${pctText(s.attachRate)} attach rate`);

  const star = r.bestSellers[0];
  if (star && star.share >= 0.2) add(65, 'medium', 'Menu', `Build on ${star.name}`,
    `It brings ${pctText(star.share)} of food & drink revenue. Pair it with a drink as a bundle, keep it in stock, and test a small price increase.`, `${star.qty} sold`);

  const dead = r.slowMovers.filter(i => !i.qty);
  if (s.orders >= 10 && dead.length) add(55, 'medium', 'Menu', `Rethink ${dead.length} item${dead.length > 1 ? 's' : ''} that did not sell`,
    `${dead.slice(0, 3).map(i => i.name).join(', ')}${dead.length > 3 ? '…' : ''}. Add a photo and description, lower the price, or replace them to keep the menu short.`, 'No sales');

  if (s.orders >= 10 && s.itemsPerOrder < 2) add(60, 'medium', 'Food & drinks', 'Increase items per order',
    `Orders average ${s.itemsPerOrder.toFixed(1)} items. Suggest a drink with every food item and offer sides or desserts at checkout.`, `${s.itemsPerOrder.toFixed(1)} items/order`);

  if (s.orders >= 10 && s.tipParticipation < 0.4) add(40, 'medium', 'Tips', 'Encourage tipping',
    `${pctText(s.tipParticipation)} of orders include a tip. Offer small preset amounts in Settings → Tips and let staff mention it at delivery.`, `${pctText(s.tipParticipation)} tipped`);

  const peak = [...r.byHour].sort((a, b) => b.orders - a.orders)[0];
  if (peak?.orders >= 5) add(50, 'medium', 'Operations', `Staff up around ${hourText(peak.hour)}`,
    `${peak.orders} orders arrive in that hour. Extra service staff and a prepared bar keep orders fast, so guests order again.`, `${peak.orders} orders`);

  const days = r.byWeekday.filter(d => d.gross > 0).sort((a, b) => b.gross - a.gross);
  if (days.length >= 3) add(45, 'medium', 'Scheduling', `Schedule more events on ${days[0].day}`,
    `${days[0].day} brings the most sales; ${days[days.length - 1].day} the least. Plan headline events on strong days and promotions on weak ones.`, `Best day: ${days[0].day}`);

  if (r.guests.unique >= 10 && r.guests.repeatRate < 0.3) add(75, 'high', 'Guests', 'Bring guests back',
    `Only ${pctText(r.guests.repeatRate)} of guests returned. Message past guests about the next event and reward repeat visits.`, `${pctText(r.guests.repeatRate)} returning`);

  if (r.guests.unique >= 10 && r.guests.top10Share >= 0.4) add(35, 'medium', 'Guests', 'Look after your top guests',
    `The top 10 guests bring ${pctText(r.guests.top10Share)} of sales. Offer them early access or reserved tables.`, `${pctText(r.guests.top10Share)} of sales`);

  if (r.previous?.summary.gross && change(s.gross, r.previous.summary.gross) < -0.1) add(95, 'high', 'Sales', 'Sales are falling — act this week',
    `Gross sales fell ${pctText(Math.abs(change(s.gross, r.previous.summary.gross)))} compared with the previous period. Announce the next event early and run a limited-time offer.`, 'vs previous period');

  if (s.ticketsSold >= 10 && s.checkinRate < 0.6) add(30, 'medium', 'Operations', 'Scan every ticket at the door',
    `${pctText(s.checkinRate)} of tickets were checked in. Scanning gives accurate attendance and no-show data for pricing and staffing.`, `${pctText(s.checkinRate)} checked in`);

  return out.sort((a, b) => b.score - a.score).map(({ score, ...x }) => x);
}

/** Everything one guest did with the workspace, for the check-in guest panel. */
export function guestHistory(state, key) {
  const mine = r => (key.guest ? r.guest === key.guest : r.phone === key.phone);
  const bookings = state.bookings.filter(mine).sort((a, b) => b.created - a.created);
  const orders = state.orders.filter(mine).sort((a, b) => b.created - a.created);
  const payments = [...bookings, ...orders]
    .map(r => ({ ref: r.ref, kind: r.qty ? 'Tickets' : 'Order', created: r.created, method: paymentLabel(r), amount: r.total, vat: vatOf(r), tip: r.tip || 0, paidAt: r.settledAt || null }))
    .sort((a, b) => b.created - a.created);
  const paid = [...bookings, ...orders].filter(isSale);
  return {
    bookings, orders, payments,
    totals: {
      spent: sum(paid, r => r.total), tickets: sum(bookings.filter(isSale), b => b.qty),
      checkedIn: bookings.flatMap(b => b.tickets).filter(t => t.used).length, orders: orders.filter(isSale).length,
    },
  };
}

/**
 * Platform-wide analytics across organizations. Each tenant carries its own events, menu, bookings and orders.
 * Money is only added up within one currency; `currency` picks it (default: the most common one).
 */
export function buildPlatform(tenants, filters = {}) {
  const currencies = [...new Set(tenants.map(t => t.currency))];
  const counts = currencies.map(c => [c, tenants.filter(t => t.currency === c).length]).sort((a, b) => b[1] - a[1]);
  const currency = filters.currency || counts[0]?.[0] || 'ETB';
  const orgs = tenants.map(t => {
    const report = buildReport(t, filters);
    const all = [...t.bookings, ...t.orders];
    return {
      id: t.id, name: t.name, status: t.status, currency: t.currency, created: t.created, city: t.city, logo: t.logo,
      team: t.team.length, events: t.events.length, liveEvents: t.events.filter(e => e.published).length, menu: t.menu.length, tables: t.tables.length,
      ratings: t.ratings, lastActivity: Math.max(0, ...all.map(r => r.created)), report, s: report.summary,
    };
  });
  const inCurrency = orgs.filter(o => o.currency === currency);
  const merged = { name: 'Encore platform', currency, events: [], menu: [], bookings: [], orders: [], settings: {} };
  for (const t of tenants.filter(x => x.currency === currency)) {
    const tag = r => ({ ...r, event: `${t.id}:${r.event}`, guest: r.guest || `${t.id}:${r.phone}`, tenantName: t.name });
    merged.events.push(...t.events.map(e => ({ ...e, id: `${t.id}:${e.id}`, name: `${e.name} · ${t.name}` })));
    merged.menu.push(...t.menu);
    merged.bookings.push(...t.bookings.map(tag));
    merged.orders.push(...t.orders.map(tag));
  }
  const report = buildReport(merged, { from: filters.from, to: filters.to });
  // Guests are platform accounts, so the same guest across organizations is one person.
  const platformGuests = new Set([...merged.bookings, ...merged.orders].filter(isSale).filter(r => inRange(r, filters)).map(r => r.guest.includes(':') ? r.phone : r.guest));
  const crossOrg = new Map();
  for (const t of tenants) for (const r of [...t.bookings, ...t.orders].filter(isSale).filter(x => inRange(x, filters))) {
    const k = r.guest || r.phone;
    crossOrg.set(k, (crossOrg.get(k) || new Set()).add(t.id));
  }
  const multiOrg = [...crossOrg.values()].filter(v => v.size > 1).length;
  const ranked = [...inCurrency].sort((a, b) => b.s.gross - a.s.gross);
  const gmv = report.summary.gross;
  return {
    currency, currencies, orgs, ranked, report,
    totals: {
      organizations: tenants.length, active: tenants.filter(t => t.status !== 'suspended').length, suspended: tenants.filter(t => t.status === 'suspended').length,
      selling: inCurrency.filter(o => o.s.gross > 0).length, gmv, guests: platformGuests.size, multiOrgGuests: multiOrg,
      staff: sum(tenants, t => t.team.length), events: sum(tenants, t => t.events.length), liveEvents: sum(tenants, t => t.events.filter(e => e.published).length),
      topOrgShare: ratio(ranked[0]?.s.gross || 0, gmv), top3Share: ratio(sum(ranked.slice(0, 3), o => o.s.gross), gmv),
      excludedCurrencies: currencies.filter(c => c !== currency),
    },
  };
}

function inRange(r, { from, to } = {}) {
  return (!from || r.created >= dayStart(from)) && (!to || r.created <= dayEnd(to));
}

/** Count of items created per day (for sign-up growth charts), cumulative option. */
export function growthSeries(timestamps, { from, to, cumulative = false } = {}) {
  const valid = timestamps.filter(Boolean).sort((a, b) => a - b);
  if (!valid.length) return [];
  const start = from || isoDay(new Date(valid[0] * 1000));
  const end = to || isoDay(new Date());
  const rows = fillDays(valid.filter(t => inRange({ created: t }, { from: start, to: end })).reduce((acc, t) => {
    const key = isoDay(new Date(t * 1000));
    const last = acc.find(r => r.date === key);
    if (last) last.gross += 1; else acc.push({ date: key, gross: 1 });
    return acc;
  }, []).map(r => ({ tickets: 0, menu: 0, tips: 0, vat: 0, orders: 0, ticketsSold: 0, ...r })), { from: start, to: end });
  if (!cumulative) return rows.map(r => ({ date: r.date, value: r.gross }));
  let running = valid.filter(t => t < dayStart(start)).length;
  return rows.map(r => ({ date: r.date, value: (running += r.gross) }));
}

export function toCsv(rows) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return rows.map(r => r.map(cell).join(',')).join('\n');
}

export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'encore';
