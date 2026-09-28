// The printed-ticket look (like a venue's thermal ticket): big QR, short code, large price, entry breakdown.
// Used by the on-screen ticket and the PDF so both read the same.

/** 50000.00 → "50K", 450 → "450": the price as it is said at the door. */
export function doorPrice(cents) {
  const units = Math.round(cents / 100);
  if (units < 1000) return String(units);
  const k = units / 1000;
  return (Number.isInteger(k) ? k : k.toFixed(1)) + 'K';
}

/** 45000.00 → "45,000/=", the way prices are written on East African tickets. */
export const slashPrice = cents => Math.round(cents / 100).toLocaleString('en-US') + '/=';

/** What one ticket of this booking says, from the receipt the server issued. */
export function ticketFacts(r, reservations) {
  const qty = r.qty || 1;
  const each = Math.round(r.total / qty);
  // VAT added on top is shown as its own line; included VAT is already inside the entrance price.
  const addedTax = r.tax?.amount && !r.tax.included ? Math.round(r.tax.amount / qty) : 0;
  return {
    merchant: (r.merchant || '').toUpperCase(),
    issued: new Date(r.created * 1000),
    eventLine: `${r.eventName} · ${new Date(r.date).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    price: doorPrice(each),
    lines: addedTax ? [['Entrance', each - addedTax], [r.tax.label, addedTax]] : [['Entrance', each]],
    note: r.paid ? 'Paid · valid for one entry' : 'Pay at the entrance · valid for one entry',
    reservations,
  };
}

/** 26-Sep-2026 17:29:39 */
export const stamp = d => `${String(d.getDate()).padStart(2, '0')}-${d.toLocaleString('en-US', { month: 'short' })}-${d.getFullYear()} ${d.toTimeString().slice(0, 8)}`;
