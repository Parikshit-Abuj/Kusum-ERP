const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { createQrImage } = require('./qr-code');

const bundledSignaturePath = path.join(__dirname, '..', 'assets', 'kusum-authorised-signature.jpg');
// Keep standalone URD receipts on the original A4 register layout: 42pt
// printable margins and a comfortable 511pt content width.
const page = { left: 42, right: 553, width: 511, footerY: 700 };

function amount(value) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(Number(value || 0));
}
function weight(value) { return `${Number(value || 0).toFixed(3)} g`; }
function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function dateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || '—') : `${dateOnly(date)} ${date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}
function text(value, fallback = '—') {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}
function purchaseItems(purchase) {
  const saved = Array.isArray(purchase.items) && purchase.items.length ? purchase.items : null;
  if (saved) return saved;
  // Legacy URD rows stored one item directly on UrdPurchase. Keep those
  // receipts printable after the multi-item migration.
  return [{
    description: purchase.description || 'Old jewellery purchase',
    metal: purchase.metal,
    purity: purchase.purity,
    grossWeight: purchase.grossWeight,
    netWeight: purchase.netWeight,
    ratePerGram: purchase.ratePerGram,
    totalAmount: purchase.totalAmount
  }];
}
function line(doc, y, color = '#d6d0c9', width = 0.6) {
  doc.save().moveTo(page.left, y).lineTo(page.right, y).lineWidth(width).strokeColor(color).stroke().restore();
}
function box(doc, x, y, width, height, widthValue = 0.65) {
  doc.save().rect(x, y, width, height).lineWidth(widthValue).strokeColor('#111').stroke().restore();
}
function vertical(doc, x, y, height, color = '#111', width = 0.45) {
  doc.save().moveTo(x, y).lineTo(x, y + height).lineWidth(width).strokeColor(color).stroke().restore();
}
function sectionHeading(doc, label, y) {
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), page.left, y);
  line(doc, y + 14, '#e5ddd1', 0.7);
  return y + 25;
}
function qrPayload(purchase) {
  const paid = Number(purchase.paid || 0);
  const total = Number(purchase.totalAmount || 0);
  const due = Math.max(0, total - Number(purchase.saleOffset || 0) - paid);
  const items = purchaseItems(purchase);
  return [
    `${text(purchase.customer?.name, 'Customer')}`,
    `URD: ${text(purchase.purchaseNumber)}`,
    `Date: ${dateOnly(purchase.purchaseDate)}`,
    `Metal/Purity: ${text(purchase.metal)}${purchase.purity ? ` / ${text(purchase.purity)}` : ''}`,
    `Items: ${items.length}`,
    `Net wt: ${weight(purchase.netWeight)}`,
    `Valuation: Rs. ${amount(total)}`,
    `Paid: Rs. ${amount(paid)}`,
    `Due: Rs. ${amount(due)}`,
    ...(purchase.sale?.invoiceNumber ? [`Settled in sale: ${purchase.sale.invoiceNumber}`] : [])
  ].join('\n');
}
function compactQrPayload(purchase) {
  const paid = Number(purchase.paid || 0);
  const total = Number(purchase.totalAmount || 0);
  const due = Math.max(0, total - Number(purchase.saleOffset || 0) - paid);
  const items = purchaseItems(purchase);
  return [
    `URD:${text(purchase.purchaseNumber)}`,
    `C:${text(purchase.customer?.name, 'Customer')}`,
    `DATE:${dateOnly(purchase.purchaseDate)}`,
    `M:${text(purchase.metal)}${purchase.purity ? `/${text(purchase.purity)}` : ''}`,
    `ITEMS:${items.length}`,
    `NW:${weight(purchase.netWeight)}`,
    `V:${amount(total)}`,
    `P:${amount(paid)}`,
    `DUE:${amount(due)}`,
    ...(purchase.sale?.invoiceNumber ? [`SALE:${text(purchase.sale.invoiceNumber)}`] : [])
  ].join('|');
}
async function qrImage(purchase) {
  return createQrImage({
    payload: qrPayload(purchase),
    compactPayload: compactQrPayload(purchase),
    label: `URD receipt ${text(purchase.purchaseNumber)}`
  });
}
function drawHeader(doc, purchase, settings) {
  const shopName = text(settings.shopName, 'Kusum Jewellers');
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(19).text(shopName, page.left, 42, { width: 330 });
  doc.fillColor('#111').font('Helvetica').fontSize(8.5);
  const address = String(settings.shopAddress || '').trim();
  const phones = [settings.primaryPhone, settings.secondaryPhone].filter(Boolean).join('  ·  ');
  let contactY = 66;
  if (address) { doc.text(address, page.left, contactY, { width: 350 }); contactY += 12; }
  if (phones) { doc.text(phones, page.left, contactY, { width: 350, ellipsis: true }); contactY += 12; }
  if (settings.gstin) doc.text(`GSTIN: ${settings.gstin}${settings.panNumber ? `  ·  PAN: ${settings.panNumber}` : ''}`, page.left, contactY, { width: 350, ellipsis: true });
  const headerRight = page.right - 200;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(14).text('URD PURCHASE RECEIPT', headerRight, 44, { width: 200, align: 'right', ellipsis: true });
  doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(`No. ${text(purchase.purchaseNumber)}`, headerRight, 66, { width: 200, align: 'right' });
  doc.text(dateTime(purchase.purchaseDate), headerRight, 79, { width: 200, align: 'right' });
  line(doc, 101, '#b88732', 1.1);
}
function drawCustomer(doc, purchase, y) {
  y = sectionHeading(doc, 'Purchased from', y);
  const top = y;
  const height = 62;
  const split = 310;
  box(doc, page.left, top, page.width, height);
  vertical(doc, split, top, height);
  const leftRows = [
    ['Name', text(purchase.customer?.name, 'Walk-in customer')],
    ['Mobile', purchase.customer?.phone || '-'],
    ['Address', purchase.customer?.address || '-']
  ];
  const rightRows = [
    ['URD No.', text(purchase.purchaseNumber)],
    ['Date & Time', dateTime(purchase.purchaseDate)],
    ['Status', purchase.cancelledAt ? 'CANCELLED' : 'ACTIVE']
  ];
  const drawRows = (rows, labelX, valueX, width) => rows.forEach(([label, value], index) => {
    const rowY = top + 7 + index * 19;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(7.6).text(`${label}:`, labelX, rowY, { width: 68 });
    doc.font('Helvetica').fontSize(8.4).text(value, valueX, rowY - 1, { width, ellipsis: true });
  });
  drawRows(leftRows, page.left + 9, page.left + 69, split - page.left - 82);
  drawRows(rightRows, split + 10, split + 72, page.right - split - 84);
  return top + height + 14;
}
function drawItemTableHeader(doc, y) {
  const headerHeight = 24;
  const columns = [
    ['DESCRIPTION', 140, 'left'], ['METAL', 65, 'left'], ['PURITY', 50, 'center'],
    ['GROSS WT.', 66, 'right'], ['NET WT.', 66, 'right'], ['RATE / G', 62, 'right'], ['VALUE', 62, 'right']
  ];
  doc.rect(page.left, y, page.width, headerHeight).fill('#f2eee8');
  box(doc, page.left, y, page.width, headerHeight);
  let x = page.left;
  columns.forEach(([label, width, align], index) => {
    if (index) vertical(doc, x, y, headerHeight);
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(7).text(label, x + 4, y + 8, { width: width - 8, align, ellipsis: true });
    x += width;
  });
  return y + headerHeight;
}
function drawUrdContinuationHeader(doc) {
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text('URD PURCHASE RECEIPT · CONTINUED', page.left, 36, { width: page.width, ellipsis: true });
  line(doc, 64, '#b88732', 0.8);
}
function drawUrdContinuationFooter(doc) {
  const y = page.footerY + 28;
  line(doc, y, '#ded5c8', 0.45);
  doc.fillColor('#111').font('Helvetica').fontSize(8).text('Continued on the next page.', page.left, y + 12, { width: page.width, align: 'center' });
}
function drawItems(doc, purchase, y) {
  y = sectionHeading(doc, 'Old jewellery / bullion received', y);
  const items = purchaseItems(purchase);
  const contentBottom = page.footerY - 32;
  const rowHeight = 32;
  let rowY = drawItemTableHeader(doc, y);
  items.forEach((item, index) => {
    if (rowY + rowHeight > contentBottom) {
      drawUrdContinuationFooter(doc);
      doc.addPage();
      drawUrdContinuationHeader(doc);
      rowY = drawItemTableHeader(doc, 84);
    }
    const columns = [
      ['DESCRIPTION', text(item.description, 'Old jewellery item'), 140, 'left'],
      ['METAL', text(item.metal), 65, 'left'],
      ['PURITY', text(item.purity), 50, 'center'],
      ['GROSS WT.', weight(item.grossWeight), 66, 'right'],
      ['NET WT.', weight(item.netWeight), 66, 'right'],
      ['RATE / G', amount(item.ratePerGram), 62, 'right'],
      ['VALUE', amount(item.totalAmount), 62, 'right']
    ];
    if (index % 2 === 0) doc.rect(page.left, rowY, page.width, rowHeight).fill('#fcfaf6');
    box(doc, page.left, rowY, page.width, rowHeight, 0.45);
    let x = page.left;
    columns.forEach(([label, value, width, align], index) => {
      if (index) vertical(doc, x, rowY, rowHeight);
      doc.fillColor('#111').font('Helvetica').fontSize(8.1).text(value, x + 4, rowY + 9, { width: width - 8, align, ellipsis: true });
      x += width;
    });
    rowY += rowHeight;
  });
  return rowY + 18;
}
function drawTotals(doc, purchase, y) {
  y = sectionHeading(doc, 'Valuation and settlement', y);
  const total = Number(purchase.totalAmount || 0); const offset = Number(purchase.saleOffset || 0); const paid = Number(purchase.paid || 0);
  const due = Math.max(0, total - offset - paid);
  const rows = [['Valuation amount', `Rs. ${amount(total)}`], ...(offset > 0 ? [['Adjusted against sale', `Rs. ${amount(offset)}`]] : []), ['Paid to customer', `Rs. ${amount(paid)}`], ['Balance due', `Rs. ${amount(due)}`]];
  const top = y;
  const height = 112;
  // Leave enough width for Indian-formatted amounts (including the Rs.
  // prefix) so large multi-item valuations do not wrap into two lines.
  const split = 360;
  box(doc, page.left, top, page.width, height);
  vertical(doc, split, top, height);
  const leftRows = [
    ['Payment method', text(purchase.paymentMethod, 'CASH').replaceAll('_', ' ')],
    ['Settlement', purchase.sale?.invoiceNumber ? `Sales invoice ${purchase.sale.invoiceNumber}` : 'Direct customer payout'],
    ['Narration', purchase.notes || '-']
  ];
  leftRows.forEach(([label, value], index) => {
    const rowY = top + 10 + index * 25;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.2).text(`${label}:`, page.left + 10, rowY, { width: 78 });
    doc.font('Helvetica').fontSize(8.2).text(text(value), page.left + 88, rowY, { width: split - page.left - 100, height: 18, ellipsis: true });
  });
  rows.forEach(([label, value], index) => {
    const rowY = top + 8 + index * 22;
    const emphasis = index === rows.length - 1;
    doc.fillColor('#111').font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 8.6 : 8.2).text(label, split + 10, rowY, { width: 95, ellipsis: true });
    doc.font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 8.6 : 8.2).text(value, page.right - 95, rowY, { width: 85, align: 'right', ellipsis: true });
    if (emphasis) doc.save().moveTo(split, rowY - 4).lineTo(page.right, rowY - 4).lineWidth(0.45).strokeColor('#111').stroke().restore();
  });
  return top + height + 12;
}
function drawFooter(doc, purchase, settings, qr) {
  const y = page.footerY;
  const height = 96;
  const qrSplit = page.left + 100;
  const authorisedSplit = page.right - 210;
  box(doc, page.left, y, page.width, height);
  vertical(doc, qrSplit, y, height);
  vertical(doc, authorisedSplit, y, height);
  if (qr) doc.image(qr, page.left + 14, y + 6, { fit: [58, 58] });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(6.6).text('SCAN URD DETAILS', page.left + 4, y + 69, { width: qrSplit - page.left - 8, align: 'center' });
  const customerX = qrSplit;
  const customerWidth = authorisedSplit - qrSplit;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.2).text('Customer signature', customerX + 10, y + 21, { width: customerWidth - 20, align: 'center' });
  doc.save().moveTo(customerX + 16, y + 61).lineTo(authorisedSplit - 16, y + 61).lineWidth(0.6).strokeColor('#111').stroke().restore();
  doc.fillColor('#111').font('Helvetica').fontSize(7.4).text('Customer acknowledgement', customerX + 10, y + 68, { width: customerWidth - 20, align: 'center' });
  const signatureX = authorisedSplit;
  const signatureWidth = page.right - authorisedSplit;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(9.2).text(`For ${text(settings.shopName, 'Kusum Jewellers')}`, signatureX + 10, y + 6, { width: signatureWidth - 20, align: 'center' });
  const signature = settings.signatureImage ? Buffer.from(settings.signatureImage) : (fs.existsSync(bundledSignaturePath) ? bundledSignaturePath : null);
  if (signature) doc.image(signature, signatureX + 32, y + 20, { fit: [140, 36], align: 'center', valign: 'center' });
  doc.save().moveTo(signatureX + 20, y + 61).lineTo(page.right - 10, y + 61).lineWidth(0.6).strokeColor('#111').stroke().restore();
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8).text('Authorised Signatory', signatureX, y + 68, { width: signatureWidth, align: 'center' });
}
async function writeUrdPurchaseInvoice(res, purchase, businessSettings = {}) {
  const qr = await qrImage(purchase);
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `URD Purchase Receipt ${purchase.purchaseNumber}` } });
  const filename = `${String(purchase.purchaseNumber || 'urd-purchase').replace(/[^A-Za-z0-9-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${filename}"`); doc.pipe(res);
  drawHeader(doc, purchase, businessSettings);
  let y = drawCustomer(doc, purchase, 123);
  y = drawItems(doc, purchase, y);
  // Keep valuation and settlement together on a page with the final
  // acknowledgement footer. If the item list filled the first page, continue
  // to a clean page before drawing totals.
  const totalsHeight = 25 + 112 + 12;
  if (y + totalsHeight > page.footerY - 32) {
    drawUrdContinuationFooter(doc);
    doc.addPage();
    drawUrdContinuationHeader(doc);
    y = 84;
  }
  drawTotals(doc, purchase, y);
  drawFooter(doc, purchase, businessSettings, qr);
  doc.end();
}
module.exports = { writeUrdPurchaseInvoice, qrPayload };
