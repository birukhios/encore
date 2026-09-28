// A guest's receipt as a PDF. Tickets print one per page on 80 mm paper, laid out like the venue's thermal ticket,
// so they can be shown from the phone or printed. jsPDF loads only when a guest asks for the download.
import QRCode from 'qrcode';
import { slashPrice, stamp, ticketFacts } from './ticketStub';

const qrImage = text => QRCode.toDataURL(text, { width: 300, margin: 1, errorCorrectionLevel: 'M' });

async function downloadTickets(r, reservations, jsPDF) {
  const f = ticketFacts(r, reservations);
  const W = 80, H = 150, M = 6;
  const doc = new jsPDF({ unit: 'mm', format: [W, H] });
  const center = (text, y, size, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.text(String(text), W / 2, y, { align: 'center', maxWidth: W - 2 * M });
  };
  for (const [n, t] of r.tickets.entries()) {
    if (n) doc.addPage([W, H]);
    doc.setTextColor(17, 17, 17);
    // compressed: keeps the file small for phones
    doc.addImage(await qrImage(`${r.ref}:${t.serial}:${t.token}`), 'PNG', (W - 52) / 2, M, 52, 52, undefined, 'FAST');
    doc.setFont('courier', 'bold'); doc.setFontSize(12);
    doc.text(`${r.ref}-${t.serial}`, W / 2, 64, { align: 'center' });
    center(f.merchant, 74, 12, true);
    center(stamp(f.issued), 80, 9);
    center(f.eventLine, 86, 9);
    doc.setLineWidth(0.3); doc.line(M, 91, W - M, 91);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(30);
    doc.text(f.price, M, 105);
    const priceWidth = doc.getTextWidth(f.price);
    doc.setLineWidth(0.8); doc.line(M + priceWidth + 2, 95, M + priceWidth + 2, 108);
    doc.setFontSize(9);
    f.lines.forEach(([label, cents], i) => doc.text(`${label} - ${slashPrice(cents)}`, M + priceWidth + 5, 99 + i * 5));
    doc.setLineWidth(0.3); doc.line(M, 112, W - M, 112);
    center(`${t.used ? 'Used for entry' : f.note}`, 119, 9);
    center(`Ticket ${t.serial} of ${r.qty}`, 125, 9);
    if (f.reservations) center(`Reservations : ${f.reservations}`, 132, 9);
  }
  doc.save(`tickets-${r.ref}.pdf`);
}

export async function downloadReceipt(r, money, reservations = '') {
  const { jsPDF } = await import('jspdf');
  if (r.kind === 'booking' && r.status !== 'Cancelled' && r.tickets?.length) return downloadTickets(r, reservations, jsPDF);
  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const booking = r.kind === 'booking';
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 14;
  let y = 18;
  const line = (text, { size = 10, bold = false, right, color = [17, 17, 17] } = {}) => {
    if (y > H - 16) { doc.addPage(); y = 18; }
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(String(text), M, y);
    if (right !== undefined) doc.text(String(right), W - M, y, { align: 'right' });
    y += size * 0.5 + 2;
  };
  const rule = () => { doc.setDrawColor(210); doc.line(M, y - 2, W - M, y - 2); y += 3; };

  line(r.merchant, { size: 15, bold: true });
  line(booking ? r.eventName : `Order ${r.ref}`, { size: 12, bold: true, color: [230, 30, 50] });
  if (booking) line(`${r.venue} · ${new Date(r.date).toLocaleString()}`, { color: [91, 102, 112] });
  line(`Reference ${r.ref} · ${r.name}`, { color: [91, 102, 112] });
  line(`Date ${new Date(r.created * 1000).toLocaleString()}`, { color: [91, 102, 112] });
  y += 2; rule();
  r.lines.forEach(l => line(`${l.qty} × ${l.name}`, { right: money(l.total) }));
  if (r.service) line(r.service.label, { right: money(r.service.amount) });
  if (r.tax) line(`${r.tax.label}${r.tax.included ? ' (included)' : ''}`, { right: money(r.tax.amount) });
  if (!booking && r.tip) line('Tip', { right: money(r.tip) });
  rule();
  line('Total', { size: 12, bold: true, right: money(r.total) });
  line(r.status === 'Cancelled' ? 'CANCELLED' : r.paid ? `PAID · ${r.settledBy || 'Online'}` : booking ? 'NOT PAID · pay at the entrance' : 'NOT PAID', { bold: true });
  if (r.tin) line(`TIN ${r.tin}${r.vatNumber ? ` · VAT reg. ${r.vatNumber}` : ''} · Not a fiscal receipt`, { size: 8, color: [91, 102, 112] });

  doc.save(`${(booking ? 'tickets' : 'receipt')}-${r.ref}.pdf`);
}
