// A guest's receipt as a PDF, with one QR code per ticket so it can be shown at the entrance from the file.
// jsPDF loads only when a guest asks for the download.
import QRCode from 'qrcode';

export async function downloadReceipt(r, money) {
  const { jsPDF } = await import('jspdf');
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

  if (booking && r.status !== 'Cancelled') {
    for (const t of r.tickets) {
      const size = 52;
      if (y + size + 14 > H - 10) { doc.addPage(); y = 18; }
      y += 4;
      const png = await QRCode.toDataURL(`${r.ref}:${t.serial}:${t.token}`, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
      doc.addImage(png, 'PNG', (W - size) / 2, y, size, size, undefined, 'FAST'); // compressed: keeps the file small for phones
      y += size + 5;
      doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(17, 17, 17);
      doc.text(`Ticket ${t.serial} of ${r.qty}${t.used ? ' · used' : ''}`, W / 2, y, { align: 'center' });
      y += 6;
    }
  }
  doc.save(`${(booking ? 'tickets' : 'receipt')}-${r.ref}.pdf`);
}
