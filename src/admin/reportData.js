// Reporting calculations over a workspace's bookings and orders. All amounts are integer cents.
// Only paid, non-cancelled records count as sales.

const isSale = r => r.paid && r.status !== 'Cancelled';
const sum = (list, fn) => list.reduce((total, x) => total + (fn(x) || 0), 0);
export const vatOf = r => r.tax?.amount || 0;

export function paymentLabel(r) {
  if (r.status === 'Cancelled') return 'Cancelled';
  if (!r.paid) return 'Unpaid';
  return r.settlement === 'demo' ? 'Online (demo)' : r.settledBy || 'Paid';
}

/** Records within the date range (inclusive, local dates as YYYY-MM-DD) and event filter. */
export function filterRecords(state, { from = '', to = '', eventId = 'all' } = {}) {
  const start = from ? new Date(from + 'T00:00:00').getTime() / 1000 : -Infinity;
  const end = to ? new Date(to + 'T23:59:59').getTime() / 1000 : Infinity;
  const keep = r => r.created >= start && r.created <= end && (eventId === 'all' || r.event === eventId);
  return { bookings: state.bookings.filter(keep), orders: state.orders.filter(keep) };
}

export function buildReport(state, filters = {}) {
  const { bookings, orders } = filterRecords(state, filters);
  const soldBookings = bookings.filter(isSale);
  const soldOrders = orders.filter(isSale);
  const sales = [...soldBookings, ...soldOrders];
  const tickets = soldBookings.flatMap(b => b.tickets);

  const summary = {
    gross: sum(sales, r => r.total),
    ticketSales: sum(soldBookings, r => r.subtotal),
    menuSales: sum(soldOrders, r => r.subtotal),
    tips: sum(soldOrders, r => r.tip),
    vat: sum(sales, vatOf),
    ticketsSold: tickets.length,
    checkedIn: tickets.filter(t => t.used).length,
    bookings: soldBookings.length,
    orders: soldOrders.length,
    refundsOrCancelled: bookings.length + orders.length - sales.length,
  };
  summary.net = summary.gross - summary.tips - summary.vat;
  summary.avgOrder = summary.orders ? Math.round(sum(soldOrders, r => r.total) / summary.orders) : 0;
  summary.checkinRate = summary.ticketsSold ? summary.checkedIn / summary.ticketsSold : 0;

  const byEvent = state.events
    .map(e => {
      const eb = soldBookings.filter(b => b.event === e.id);
      const eo = soldOrders.filter(o => o.event === e.id);
      const et = eb.flatMap(b => b.tickets);
      return {
        id: e.id, name: e.name, date: e.date, capacity: e.capacity,
        ticketsSold: et.length, checkedIn: et.filter(t => t.used).length,
        ticketSales: sum(eb, r => r.subtotal), orders: eo.length, menuSales: sum(eo, r => r.subtotal),
        tips: sum(eo, r => r.tip), vat: sum([...eb, ...eo], vatOf), gross: sum([...eb, ...eo], r => r.total),
      };
    })
    .filter(row => row.ticketsSold || row.orders)
    .sort((a, b) => b.gross - a.gross);

  const categoryOf = name => state.menu.find(i => i.name === name)?.category || '—';
  const items = new Map();
  for (const o of soldOrders) {
    for (const line of o.lines) {
      const row = items.get(line.name) || { name: line.name, category: categoryOf(line.name), qty: 0, revenue: 0, orders: 0 };
      row.qty += line.qty;
      row.revenue += line.total;
      row.orders += 1;
      items.set(line.name, row);
    }
  }
  const bestSellers = [...items.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue);

  const tables = new Map();
  for (const o of soldOrders) {
    const key = o.tableName || 'Counter pickup';
    const row = tables.get(key) || { name: key, event: state.events.find(e => e.id === o.event)?.name || '—', orders: 0, items: 0, revenue: 0, tips: 0 };
    row.orders += 1;
    row.items += sum(o.lines, l => l.qty);
    row.revenue += o.total;
    row.tips += o.tip || 0;
    tables.set(key, row);
  }
  const busyTables = [...tables.values()].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0 }));
  for (const o of soldOrders) {
    const h = new Date(o.created * 1000).getHours();
    byHour[h].orders += 1;
    byHour[h].revenue += o.total;
  }

  const methods = new Map();
  for (const r of sales) {
    const label = paymentLabel(r);
    const row = methods.get(label) || { method: label, count: 0, amount: 0 };
    row.count += 1;
    row.amount += r.total;
    methods.set(label, row);
  }
  const payments = [...methods.values()].sort((a, b) => b.amount - a.amount);

  const days = new Map();
  for (const r of sales) {
    const d = new Date(r.created * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = days.get(key) || { date: key, tickets: 0, menu: 0, gross: 0 };
    if (r.qty) row.tickets += r.subtotal; else row.menu += r.subtotal;
    row.gross += r.total;
    days.set(key, row);
  }
  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  return { summary, byEvent, bestSellers, busyTables, byHour, payments, daily };
}

/** Everything one guest did with the workspace, for the check-in guest panel. */
export function guestHistory(state, guestKey) {
  const mine = r => (guestKey.guest ? r.guest === guestKey.guest : r.phone === guestKey.phone);
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
