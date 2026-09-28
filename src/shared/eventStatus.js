// One event status for both apps. Only Draft (unpublished) and Cancelled are set by staff; the rest follow from the
// date, the ticket-sales deadline and how many tickets are left. The server enforces the same deadline and cancellation.
const EVENT_HOURS = 6; // how long an event counts as "Ongoing" after it starts

export function eventStatus(e, { soldOut = false, now = new Date() } = {}) {
  if (e.published === false) return { label: 'Draft', tone: 'neutral' };
  if (e.cancelled) return { label: 'Cancelled', tone: 'danger' };
  const start = new Date(e.date);
  if (now > new Date(start.getTime() + EVENT_HOURS * 3600000)) return { label: 'Completed', tone: 'neutral' };
  if (now >= start) return { label: 'Ongoing', tone: 'success' };
  if (soldOut || e.soldOut) return { label: 'Sold out', tone: 'neutral' };
  if (e.salesClosed || (e.salesEnd && now >= new Date(e.salesEnd))) return { label: 'Sales closed', tone: 'warning' };
  return { label: 'Upcoming', tone: 'success' };
}

/** Whether guests can still reserve tickets for this event. */
export const onSale = status => status.label === 'Upcoming';
