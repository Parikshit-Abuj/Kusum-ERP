const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { createQrImage } = require('./qr-code');

const bundledSignaturePath = path.join(__dirname, '..', 'assets', 'kusum-authorised-signature.jpg');
// Standalone scheme receipts use the original A4 register layout rather than
// the sales invoice's pre-printed 19pt content area.
const page = { left: 42, right: 553, width: 511, footerY: 700 };

function money(value) {
  // Use an ASCII currency prefix instead of the Unicode rupee glyph. The
  // built-in PDF fonts do not contain that glyph reliably, which can make it
  // appear as a stray superscript/"1" before the amount in some viewers.
  return `Rs. ${new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2, minimumFractionDigits: 2
  }).format(Number(value || 0))}`;
}

function text(value, fallback = '—') {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean || fallback;
}

function dateOnly(value) {
  const raw = String(value ?? '').trim();
  const direct = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (direct) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${direct[3]}-${monthNames[Number(direct[2]) - 1] || direct[2]}-${direct[1]}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? text(value)
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function methodLabel(method) {
  return ({ CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer' }[method] || text(method));
}

function paymentParts(installment = {}) {
  const saved = Array.isArray(installment.payments) && installment.payments.length
    ? installment.payments
    : Number(installment.paidAmount || 0) > 0 && installment.paymentDate
      ? [{ amount: installment.paidAmount, paymentDate: installment.paymentDate, paymentMethod: installment.paymentMethod }]
      : [];
  return saved
    .filter((part) => Number(part.amount || 0) > 0)
    .map((part) => ({
      amount: Number(part.amount || 0),
      paymentDate: part.paymentDate || installment.paymentDate || null,
      paymentMethod: part.paymentMethod || installment.paymentMethod || null
    }));
}

function totalParts(parts) {
  return parts.reduce((sum, part) => sum + Number(part.amount || 0), 0);
}

function paymentSummary(parts) {
  return parts.map((part) => `${methodLabel(part.paymentMethod)} ${money(part.amount)}`).join(' + ');
}

function schemeQrPayload(enrollment, installment, parts, settings = {}) {
  const paymentDate = parts.map((part) => part.paymentDate).filter(Boolean).sort().at(-1) || installment?.paymentDate;
  return [
    `${text(settings.shopName, 'Kusum Jewellers')} - SCHEME PAYMENT`,
    `Customer: ${text(enrollment.customer?.name, 'Customer')}`,
    `Scheme: ${text(enrollment.schemePlan?.name, 'Savings scheme')}`,
    `Enrollment: ${text(enrollment.enrollmentNumber)}`,
    `Installment: ${installment.installmentNumber} of ${enrollment.schemePlan?.durationMonths || '—'}`,
    `Due date: ${dateOnly(installment.dueDate)}`,
    `Paid date: ${dateOnly(paymentDate)}`,
    `Payment: ${parts.map((part) => `${dateOnly(part.paymentDate)} ${methodLabel(part.paymentMethod)} ${money(part.amount)}`).join(' + ') || 'No payment recorded'}`,
    `Total received: ${money(totalParts(parts))}`,
    ...(installment.notes ? [`Narration: ${text(installment.notes)}`] : [])
  ].join('\n');
}

function consolidatedSchemeQrPayload(enrollment, paidRows, settings = {}) {
  const totalPaid = paidRows.reduce((sum, row) => sum + totalParts(row.parts), 0);
  const duration = Number(enrollment.schemePlan?.durationMonths || 0);
  // The PDF already contains the complete month-by-month payment table. Keep
  // the QR a compact identity and total summary so even a long 60-month plan
  // with split receipts remains scannable within QR byte capacity.
  return [
    `${text(settings.shopName, 'Kusum Jewellers')} - CONSOLIDATED SCHEME`,
    `Customer: ${text(enrollment.customer?.name, 'Customer')}`,
    `Scheme: ${text(enrollment.schemePlan?.name, 'Savings scheme')}`,
    `Enrollment: ${text(enrollment.enrollmentNumber)}`,
    `Installments paid: ${paidRows.length} of ${duration || '—'}`,
    `Total received: ${money(totalPaid)}`
  ].join('\n');
}

function compactSchemeInstallmentQrPayload(enrollment, installment, parts, settings = {}) {
  return [
    `SCHEME:${text(enrollment.schemePlan?.name, 'Savings scheme')}`,
    `C:${text(enrollment.customer?.name, 'Customer')}`,
    `E:${text(enrollment.enrollmentNumber)}`,
    `M${installment.installmentNumber}/${enrollment.schemePlan?.durationMonths || '—'}:${parts.map((part) => `${dateOnly(part.paymentDate)},${methodLabel(part.paymentMethod)},${money(part.amount)}`).join(';') || 'NONE'}`,
    `TOTAL:${money(totalParts(parts))}`,
    ...(installment.notes ? [`N:${text(installment.notes)}`] : [])
  ].join('|');
}

function compactConsolidatedSchemeQrPayload(enrollment, paidRows, settings = {}) {
  const totalPaid = paidRows.reduce((sum, row) => sum + totalParts(row.parts), 0);
  const duration = Number(enrollment.schemePlan?.durationMonths || 0);
  return [
    `SCHEME:${text(enrollment.schemePlan?.name, 'Savings scheme')}`,
    `C:${text(enrollment.customer?.name, 'Customer')}`,
    `E:${text(enrollment.enrollmentNumber)}`,
    `PAID:${paidRows.length}/${duration || '—'}`,
    `TOTAL:${money(totalPaid)}`
  ].join('|');
}

async function qrImage(payload, compactPayload, label) {
  return createQrImage({ payload, compactPayload, label });
}

function drawLine(doc, y, color = '#d6d0c9', width = 0.6) {
  doc.save().moveTo(page.left, y).lineTo(page.right, y).lineWidth(width).strokeColor(color).stroke().restore();
}

function box(doc, x, y, width, height, lineWidth = 0.65) {
  doc.save().rect(x, y, width, height).lineWidth(lineWidth).strokeColor('#111').stroke().restore();
}

function vertical(doc, x, y, height, color = '#111', width = 0.45) {
  doc.save().moveTo(x, y).lineTo(x, y + height).lineWidth(width).strokeColor(color).stroke().restore();
}

function drawHeader(doc, settings, title, documentNo, date, options = {}) {
  const shopName = text(settings.shopName, 'Kusum Jewellers');
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(19).text(shopName, page.left, 42, { width: 330 });
  doc.fillColor('#111').font('Helvetica').fontSize(8.5);
  const address = String(settings.shopAddress || '').trim();
  const phones = [settings.primaryPhone, settings.secondaryPhone].filter(Boolean).join('  ·  ');
  let contactY = 66;
  if (address) { doc.text(address, page.left, contactY, { width: 350 }); contactY += 12; }
  if (phones) { doc.text(phones, page.left, contactY, { width: 350, ellipsis: true }); contactY += 12; }
  if (settings.gstin) {
    // Keep GSTIN/PAN on its own clearly separated line. The old fixed rule
    // could sit too close to this line when all business details were filled.
    doc.text(`GSTIN: ${settings.gstin}${settings.panNumber ? `  ·  PAN: ${settings.panNumber}` : ''}`, page.left, contactY, { width: 350, ellipsis: true });
    contactY += 12;
  }
  // The consolidated title is longer than the monthly title. Reduce only its
  // header size so it stays on one line and never collides with the receipt
  // number/date lines below it.
  const titleSize = title.length > 22 ? 10.5 : 13;
  const headerRight = page.right - 200;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(titleSize).text(title, headerRight, 44, { width: 200, align: 'right', ellipsis: true });
  doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(`Receipt ${text(documentNo)}`, headerRight, 66, { width: 200, align: 'right' });
  const showPaymentDate = options.showPaymentDate !== false;
  if (showPaymentDate) doc.text(`Payment date ${dateOnly(date)}`, headerRight, 79, { width: 200, align: 'right' });
  drawLine(doc, Math.max(showPaymentDate ? 104 : 91, contactY + 2), '#b88732', 1.1);
}

function drawCustomerAndPlan(doc, enrollment, y) {
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8).text('CUSTOMER AND SCHEME', page.left, y);
  drawLine(doc, y + 14, '#e5ddd1', 0.7);
  const top = y + 25;
  const half = page.width / 2;
  const height = 66;
  doc.rect(page.left, top, page.width, height).fill('#f6f1e8');
  box(doc, page.left, top, page.width, height);
  vertical(doc, page.left + half, top, height);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7).text('CUSTOMER', page.left + 12, top + 11);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(11).text(text(enrollment.customer?.name, 'Customer'), page.left + 12, top + 26, { width: half - 28, ellipsis: true });
  doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(enrollment.customer?.phone || 'No mobile saved', page.left + 12, top + 43, { width: half - 28, ellipsis: true });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7).text('SCHEME', page.left + half + 12, top + 11);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(10).text(text(enrollment.schemePlan?.name, 'Savings scheme'), page.left + half + 12, top + 26, { width: half - 28, ellipsis: true });
  doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(`${text(enrollment.enrollmentNumber)} · ${enrollment.schemePlan?.durationMonths || 0} months`, page.left + half + 12, top + 43, { width: half - 28, ellipsis: true });
  return top + 88;
}

function drawSectionHeading(doc, label, y) {
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8).text(label.toUpperCase(), page.left, y);
  drawLine(doc, y + 14, '#e5ddd1', 0.7);
  return y + 25;
}

function drawSignatureFooter(doc, settings, note, qr = null) {
  const y = page.footerY;
  const height = 96;
  const qrSplit = page.left + 100;
  const authorisedSplit = page.right - 210;
  box(doc, page.left, y, page.width, height);
  vertical(doc, qrSplit, y, height);
  vertical(doc, authorisedSplit, y, height);
  if (qr) {
    doc.image(qr, page.left + 14, y + 6, { fit: [58, 58] });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(6.6).text('SCAN SCHEME DETAILS', page.left + 4, y + 69, { width: qrSplit - page.left - 8, align: 'center' });
  }
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
  doc.fillColor('#111').font('Helvetica').fontSize(6.8).text(note, customerX + 10, y + 80, { width: customerWidth - 20, height: 10, align: 'center', ellipsis: true });
}

function drawInstallmentPaymentTable(doc, enrollment, installment, parts, y) {
  y = drawSectionHeading(doc, `Month ${installment.installmentNumber} installment payment`, y);
  const top = y;
  const rowHeight = 28;
  const metaHeight = 32;
  const headerHeight = 26;
  const totalRowHeight = 28;
  const displayRows = Math.max(1, parts.length);
  const totalHeight = metaHeight + headerHeight + displayRows * rowHeight + totalRowHeight;
  // One table keeps the installment context, split payment entries, and the
  // aggregate total together. A monthly receipt has no MONTH column (that
  // belongs in the consolidated receipt); its installment and due date live
  // in a compact context band above the payment columns.
  const amountBoundary = page.right - 95;
  const columns = [page.left, page.left + 155, amountBoundary, page.right];
  const labels = ['PAYMENT DATE', 'PAYMENT METHOD', 'AMOUNT'];
  doc.rect(page.left, top, page.width, metaHeight).fill('#f6f1e8');
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.5)
    .text(`INSTALLMENT ${installment.installmentNumber} OF ${enrollment.schemePlan?.durationMonths || '—'}`, page.left + 10, top + 10, { width: 230, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(8.5)
    .text(`DUE DATE  ${dateOnly(installment.dueDate)}`, page.left + 240, top + 10, { width: page.width - 250, align: 'right', ellipsis: true });
  const headerTop = top + metaHeight;
  doc.rect(page.left, headerTop, page.width, headerHeight).fill('#f2eee8');
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7);
  labels.forEach((label, index) => {
    const x = columns[index] + 9;
    const width = columns[index + 1] - columns[index] - 18;
    doc.text(label, x, headerTop + 9, { width, align: index === labels.length - 1 ? 'right' : 'left' });
  });

  let rowY = headerTop + headerHeight;
  parts.forEach((part, index) => {
    if (index % 2 === 0) doc.rect(page.left, rowY, page.width, rowHeight).fill('#fcfaf6');
    doc.fillColor('#111').font('Helvetica').fontSize(8.2);
    doc.text(dateOnly(part.paymentDate), columns[0] + 9, rowY + 9, { width: columns[1] - columns[0] - 18, ellipsis: true });
    doc.text(methodLabel(part.paymentMethod), columns[1] + 9, rowY + 9, { width: columns[2] - columns[1] - 18, ellipsis: true });
    doc.font('Helvetica-Bold').text(money(part.amount), columns[2] + 9, rowY + 9, { width: columns[3] - columns[2] - 18, align: 'right' });
    rowY += rowHeight;
  });
  if (!parts.length) {
    doc.fillColor('#111').font('Helvetica').fontSize(8.2);
    doc.text('—', columns[0] + 9, rowY + 9, { width: columns[1] - columns[0] - 18 });
    doc.text('No payment recorded', columns[1] + 9, rowY + 9, { width: columns[2] - columns[1] - 18, ellipsis: true });
    doc.font('Helvetica-Bold').text(money(0), columns[2] + 9, rowY + 9, { width: columns[3] - columns[2] - 18, align: 'right' });
    rowY += rowHeight;
  }

  doc.rect(page.left, rowY, page.width, totalRowHeight).fill('#f6f1e8');
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.5).text('TOTAL RECEIVED', columns[0] + 9, rowY + 9, { width: columns[2] - columns[0] - 18 });
  doc.text(money(totalParts(parts)), columns[2] + 9, rowY + 9, { width: columns[3] - columns[2] - 18, align: 'right' });

  // Paint all fills before drawing the grid so every separator remains
  // continuous and visible in print and in PDF viewers.
  box(doc, page.left, top, page.width, totalHeight);
  // Context and total rows are merged; separators only run through the
  // payment header and payment-part rows.
  columns.slice(1, -1).forEach((x) => vertical(doc, x, headerTop, rowY - headerTop));
  drawLine(doc, headerTop, '#111', 0.4);
  for (let row = 0; row <= displayRows; row += 1) {
    drawLine(doc, headerTop + headerHeight + row * rowHeight, '#111', 0.4);
  }
  drawLine(doc, rowY, '#111', 0.4);
  return top + totalHeight + 18;
}

function writeResponse(res, doc, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
}

async function writeSchemeInstallmentReceipt(res, enrollment, installment, settings = {}) {
  const parts = paymentParts(installment);
  const paymentDate = parts.map((part) => part.paymentDate).filter(Boolean).sort().at(-1) || installment.paymentDate;
  const filename = `${String(enrollment.enrollmentNumber || 'scheme')}-month-${installment.installmentNumber}-receipt.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Scheme Payment Receipt ${enrollment.enrollmentNumber} Month ${installment.installmentNumber}`, Author: text(settings.shopName, 'Kusum Jewellers') } });
  const qr = await qrImage(
    schemeQrPayload(enrollment, installment, parts, settings),
    compactSchemeInstallmentQrPayload(enrollment, installment, parts, settings),
    `Scheme receipt ${text(enrollment.enrollmentNumber)} month ${installment.installmentNumber}`
  );
  writeResponse(res, doc, filename);
  drawHeader(doc, settings, 'SCHEME PAYMENT RECEIPT', enrollment.enrollmentNumber, paymentDate);
  let y = drawCustomerAndPlan(doc, enrollment, 123);
  y = drawInstallmentPaymentTable(doc, enrollment, installment, parts, y);
  if (installment.notes || enrollment.notes) {
    const narration = installment.notes || enrollment.notes;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.5).text('Narration:', page.left, y);
    doc.font('Helvetica').text(text(narration), page.left + 52, y, { width: 459, height: 30, ellipsis: true });
  }
  drawSignatureFooter(doc, settings, 'Thank you. Please retain this receipt with your scheme passbook.', qr);
  doc.end();
}

function drawTableHeader(doc, y) {
  const height = 24;
  const amountBoundary = page.right - 75;
  const xPositions = [page.left, page.left + 60, page.left + 141, page.left + 226, amountBoundary, page.right];
  doc.rect(page.left, y, page.width, height).fill('#f2eee8');
  box(doc, page.left, y, page.width, height);
  xPositions.slice(1, -1).forEach((x) => vertical(doc, x, y, height));
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7);
  doc.text('MONTH', page.left + 9, y + 8);
  doc.text('DUE DATE', page.left + 69, y + 8, { width: 72 });
  doc.text('PAID ON', page.left + 150, y + 8, { width: 72 });
  doc.text('PAYMENT METHOD', page.left + 235, y + 8, { width: amountBoundary - page.left - 245 });
  doc.text('AMOUNT', amountBoundary + 8, y + 8, { width: 60, align: 'right' });
  return y + 24;
}

function drawContinuationHeader(doc) {
  // Business identity and receipt number belong to page 1 only. Repeating
  // them on continuation pages can collide with a wrapped address or the
  // table header, especially when the consolidated receipt spans pages.
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text('CONSOLIDATED SCHEME RECEIPT · CONTINUED', page.left, 36, { width: page.width, ellipsis: true });
  drawLine(doc, 64, '#b88732', 0.8);
}

function drawContinuationFooter(doc) {
  // Only the final page carries the QR and signature acknowledgements. A
  // continuation page needs a lightweight note instead of an empty signature
  // box that could be mistaken for the receipt's final acknowledgement.
  const y = page.footerY + 28;
  drawLine(doc, y, '#ded5c8', 0.45);
  doc.fillColor('#111').font('Helvetica').fontSize(8).text('Continued on the next page.', page.left, y + 12, { width: page.width, align: 'center' });
}

async function writeSchemeConsolidatedReceipt(res, enrollment, settings = {}, options = {}) {
  const paidRows = (enrollment.installments || []).map((installment) => ({ installment, parts: paymentParts(installment) })).filter((row) => row.parts.length);
  const totalPaid = paidRows.reduce((sum, row) => sum + totalParts(row.parts), 0);
  const lastPaymentDate = paidRows.flatMap((row) => row.parts.map((part) => part.paymentDate)).filter(Boolean).sort().at(-1) || enrollment.startDate;
  // A consolidated receipt has one optional narration for the whole receipt.
  // Installment-level notes remain available on each monthly receipt, but are
  // intentionally not repeated here because that makes the consolidated PDF
  // look like a long month-by-month log.
  const consolidatedNarration = String(options.narration || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const filename = `${String(enrollment.enrollmentNumber || 'scheme')}-consolidated-receipt.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Consolidated Scheme Payment Receipt ${enrollment.enrollmentNumber}`, Author: text(settings.shopName, 'Kusum Jewellers') } });
  const qr = await qrImage(
    consolidatedSchemeQrPayload(enrollment, paidRows, settings),
    compactConsolidatedSchemeQrPayload(enrollment, paidRows, settings),
    `Consolidated scheme receipt ${text(enrollment.enrollmentNumber)}`
  );
  writeResponse(res, doc, filename);
  drawHeader(doc, settings, 'CONSOLIDATED SCHEME RECEIPT', enrollment.enrollmentNumber, lastPaymentDate, { showPaymentDate: false });
  let y = drawCustomerAndPlan(doc, enrollment, 123);
  y = drawSectionHeading(doc, 'Payment summary', y);
  const summaryHeight = 58;
  const summarySplit1 = page.left + 184;
  const summarySplit2 = page.left + 353;
  doc.rect(page.left, y, page.width, summaryHeight).fill('#f6f1e8');
  box(doc, page.left, y, page.width, summaryHeight);
  vertical(doc, summarySplit1, y, summaryHeight);
  vertical(doc, summarySplit2, y, summaryHeight);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7).text('TOTAL RECEIVED', page.left + 12, y + 11);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(14).text(money(totalPaid), page.left + 12, y + 27, { width: summarySplit1 - page.left - 24 });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7).text('INSTALLMENTS PAID', summarySplit1 + 12, y + 11);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(13).text(`${paidRows.length} / ${enrollment.schemePlan?.durationMonths || 0}`, summarySplit1 + 12, y + 27, { width: summarySplit2 - summarySplit1 - 24 });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(7).text('BALANCE INSTALLMENTS', summarySplit2 + 12, y + 11);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(13).text(String(Math.max(0, Number(enrollment.schemePlan?.durationMonths || 0) - paidRows.length)), summarySplit2 + 12, y + 27, { width: page.right - summarySplit2 - 24 });
  y += 82;
  y = drawSectionHeading(doc, 'Installment payment history', y);
  y = drawTableHeader(doc, y);
  const contentBottom = page.footerY - 32;
  paidRows.forEach(({ installment, parts }, index) => {
    const rowHeight = 27;
    // Keep the fixed signature footer clear of the payment rows.
    if (y + rowHeight > contentBottom) {
      drawContinuationFooter(doc);
      doc.addPage();
      drawContinuationHeader(doc);
      y = drawTableHeader(doc, 84);
    }
    if (index % 2 === 0) doc.rect(page.left, y, page.width, rowHeight).fill('#fcfaf6');
    const amountBoundary = page.right - 75;
    const rowColumns = [page.left, page.left + 60, page.left + 141, page.left + 226, amountBoundary, page.right];
    box(doc, page.left, y, page.width, rowHeight, 0.45);
    rowColumns.slice(1, -1).forEach((x) => vertical(doc, x, y, rowHeight, '#111', 0.4));
    const paymentDate = parts.map((part) => part.paymentDate).filter(Boolean).sort().at(-1) || installment.paymentDate;
    doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(`Month ${installment.installmentNumber}`, page.left + 9, y + 9, { width: 55, ellipsis: true });
    doc.text(dateOnly(installment.dueDate), page.left + 69, y + 9, { width: 72, ellipsis: true });
    doc.text(dateOnly(paymentDate), page.left + 150, y + 9, { width: 72, ellipsis: true });
    doc.text(paymentSummary(parts), page.left + 235, y + 9, { width: amountBoundary - page.left - 245, ellipsis: true });
    doc.font('Helvetica-Bold').text(money(totalParts(parts)), amountBoundary + 8, y + 9, { width: 60, align: 'right' });
    y += rowHeight;
  });
  // Leave room for the summary and narration before the fixed signature
  // footer. If the table reaches the bottom of the page, continue on a clean
  // page rather than letting those lines overlap the footer.
  const hasNarration = Boolean(consolidatedNarration);
  let summaryY = y;
  if (summaryY + (hasNarration ? 90 : 44) > contentBottom) {
    drawContinuationFooter(doc);
    doc.addPage();
    drawContinuationHeader(doc);
    summaryY = 84;
  }
  drawLine(doc, summaryY, '#ded5c8', 0.45);
  doc.fillColor('#111').font('Helvetica').fontSize(8).text(
    paidRows.length ? 'This receipt consolidates the scheme payments recorded in the ERP for this customer.' : 'No installment payments have been recorded for this scheme yet.',
    page.left, summaryY + 14, { width: 330, height: 28, ellipsis: true }
  );
  if (hasNarration) {
    const headingY = summaryY + 49;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(8).text('NARRATION', page.left, headingY);
    doc.fillColor('#111').font('Helvetica').fontSize(8.5).text(consolidatedNarration, page.left, headingY + 16, { width: page.width, height: 36, ellipsis: true });
  }
  drawSignatureFooter(doc, settings, 'Please retain this consolidated receipt with the customer scheme records.', qr);
  doc.end();
}

module.exports = { writeSchemeInstallmentReceipt, writeSchemeConsolidatedReceipt, paymentParts };
