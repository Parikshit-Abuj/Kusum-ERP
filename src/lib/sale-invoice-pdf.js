const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { urdSettlement } = require('./urd-settlement');

// The shop uses pre-printed A4 sheets. Keep the letterhead area clear and
// print the ruled invoice body in the same structure as the supplied invoice.
const page = { left: 19, right: 572, infoY: 124, bodyBottom: 510, bottom: 800 };
const authorisedSignaturePath = path.join(__dirname, '..', 'assets', 'kusum-authorised-signature.jpg');

function amount(value) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(Number(value || 0));
}

function weight(value) {
  return Number(value || 0).toFixed(3);
}

function compactNumber(value) {
  const parsed = Number(value || 0);
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: Number.isInteger(parsed) ? 0 : 2,
    maximumFractionDigits: 2
  }).format(parsed);
}

function makingDisplay(item) {
  if (Number(item.makingChargeValue || 0) <= 0) return '-';
  const value = compactNumber(item.makingChargeValue);
  if (item.makingChargeType === 'PERCENTAGE') return `${value}%`;
  if (item.makingChargeType === 'PER_GRAM') return `${value} per gram`;
  return `${value} fixed`;
}

function positiveInvoicePayments(sale) {
  const cashPaid = Number(sale.cashPaid || 0);
  const upiPaid = Number(sale.upiPaid || 0);
  const cardPaid = Number(sale.cardPaid || 0);
  const bankPaid = Number(sale.bankPaid || 0);
  const trackedPaid = cashPaid + upiPaid + cardPaid + bankPaid;
  const otherPaid = Math.max(0, Number(sale.paid || 0) - trackedPaid);
  return [
    ['CASH', cashPaid],
    ['UPI', upiPaid],
    ['CARD', cardPaid],
    ['BANK TRANSFER', bankPaid],
    ['OTHER', otherPaid]
  ].filter(([, value]) => value > 0);
}

function urdRefundDetails(sale) {
  const settlement = urdSettlement(sale.total, sale.urdOffset);
  if (!settlement.hasRefund) return null;
  const recordedAmount = Math.max(0, Number(sale.urdPurchase?.paid || 0));
  return {
    amount: recordedAmount > 0 ? recordedAmount : settlement.netRefundable,
    recorded: recordedAmount > 0,
    method: String(sale.urdPurchase?.paymentMethod || 'CASH').replaceAll('_', ' ')
  };
}

function line(doc, x1, y1, x2, y2, width = 0.5) {
  doc.save().moveTo(x1, y1).lineTo(x2, y2).lineWidth(width).strokeColor('#111').stroke().restore();
}

function box(doc, x, y, width, height, lineWidth = 0.65) {
  doc.save().rect(x, y, width, height).lineWidth(lineWidth).strokeColor('#111').stroke().restore();
}

const columns = [
  { label: 'HSN\nCODE', x: 19, width: 43, align: 'center' },
  { label: 'PARTICULARS', x: 62, width: 115 },
  { label: 'HUID', x: 177, width: 52, align: 'center' },
  { label: 'PURITY', x: 229, width: 37, align: 'center' },
  { label: 'PCS', x: 266, width: 27, align: 'center' },
  { label: 'GROSS\nWT.', x: 293, width: 53, align: 'right' },
  { label: 'NET\nWT.', x: 346, width: 52, align: 'right' },
  { label: 'RATE\n[PER GM]', x: 398, width: 57, align: 'right' },
  { label: 'MAKING', x: 455, width: 60, align: 'right' },
  { label: 'AMOUNT', x: 515, width: 57, align: 'right' }
];

function drawGrid(doc, y, height) {
  box(doc, page.left, y, page.right - page.left, height);
  columns.slice(1).forEach((column) => line(doc, column.x, y, column.x, y + height, 0.45));
}

function drawTableHeader(doc, y) {
  drawGrid(doc, y, 30);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.2);
  columns.forEach((column) => {
    doc.text(column.label, column.x + 3, y + 7, {
      width: column.width - 6,
      align: column.align || 'left',
      lineGap: -1
    });
  });
}

function labelValue(doc, label, value, labelX, valueX, y, valueWidth, fontSize = 8.8) {
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.7).text(label, labelX, y);
  doc.font('Helvetica').fontSize(fontSize).text(value || '-', valueX, y - 1, { width: valueWidth, ellipsis: true });
}

function formattedDateTime(value) {
  const date = new Date(value);
  // Deliberately use the Windows computer's local timezone. The coordinates,
  // typography and invoice layout remain unchanged.
  const options = {};
  const dateText = date.toLocaleDateString('en-IN', { ...options, day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeText = date.toLocaleTimeString('en-IN', { ...options, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  return `${dateText}  ${timeText}`;
}

function invoiceHeader(doc, sale, continuation = false) {
  const settings = sale._businessSettings || {};
  const title = continuation ? 'TAX INVOICE - CONTINUED' : 'TAX INVOICE';
  // The shop's pre-printed sheet already carries the visual header. Keep this
  // as the small form label directly above the customer information block.
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.8).text(title, 105, page.infoY - 15, { width: 190 });

  const y = page.infoY;
  const height = 75;
  const split = 310;
  box(doc, page.left, y, page.right - page.left, height);
  line(doc, split, y, split, y + height, 0.45);

  const pan = (sale.customerPan || sale.customer?.panNumber || '').trim();
  if (pan) {
    labelValue(doc, 'Name', sale.customer?.name || 'Walk-in customer', 27, 105, y + 8, 192, 9.0);
    labelValue(doc, 'Address', sale.customer?.address || '-', 27, 105, y + 24, 192, 8.2);
    labelValue(doc, 'Mob.', sale.customer?.phone || '-', 27, 105, y + 43, 192, 8.5);
    labelValue(doc, 'PAN', pan, 27, 105, y + 59, 192, 8.5);
  } else {
    labelValue(doc, 'Name', sale.customer?.name || 'Walk-in customer', 27, 105, y + 10, 192, 9.2);
    labelValue(doc, 'Address', sale.customer?.address || '-', 27, 105, y + 29, 192, 8.5);
    labelValue(doc, 'Mob.', sale.customer?.phone || '-', 27, 105, y + 57, 192, 8.8);
  }

  labelValue(doc, 'Invoice No.', sale.invoiceNumber, 326, 410, y + 8, 148, 9.0);
  labelValue(doc, 'Date & Time', formattedDateTime(sale.saleDate), 326, 410, y + 24, 148, 8.2);
  labelValue(doc, 'GSTIN No.', settings.gstin || '-', 326, 410, y + 43, 148, 8.5);
  labelValue(doc, 'GST Type', 'SGST + CGST', 326, 410, y + 59, 148, 8.5);
  return y + height + 5;
}

const smallNumbers = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function wordsUnderThousand(value) {
  const number = Math.floor(value);
  if (!number) return '';
  if (number < 20) return smallNumbers[number];
  if (number < 100) return `${tens[Math.floor(number / 10)]}${number % 10 ? ` ${smallNumbers[number % 10]}` : ''}`;
  return `${smallNumbers[Math.floor(number / 100)]} Hundred${number % 100 ? ` ${wordsUnderThousand(number % 100)}` : ''}`;
}

function amountInWords(value) {
  let remaining = Math.max(0, Math.round(Number(value || 0)));
  if (!remaining) return 'Zero Rupees Only';
  const parts = [];
  const crore = Math.floor(remaining / 10000000); remaining %= 10000000;
  const lakh = Math.floor(remaining / 100000); remaining %= 100000;
  const thousand = Math.floor(remaining / 1000); remaining %= 1000;
  if (crore) parts.push(`${wordsUnderThousand(crore)} Crore`);
  if (lakh) parts.push(`${wordsUnderThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${wordsUnderThousand(thousand)} Thousand`);
  if (remaining) parts.push(wordsUnderThousand(remaining));
  return `${parts.join(' ')} Rupees Only`;
}

function qrText(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function invoiceQrPayload(sale) {
  const settings = sale._businessSettings || {};
  const items = (sale.items || []).map((item, index) => {
    const product = item.product || {};
    const itemName = qrText(item.productName || product.name, 'Jewellery item');
    const netWeight = Number(item.weight || product.netWeight || 0);
    return `${index + 1}. ${itemName} - Net wt: ${weight(netWeight)} g`;
  });
  const balance = Number(sale.balance || 0);
  const settlement = urdSettlement(sale.total, sale.urdOffset);
  const refund = urdRefundDetails(sale);
  return [
    `${qrText(settings.shopName, 'KUSUM JEWELLERS').toUpperCase()} - SALES INVOICE`,
    `Invoice: ${qrText(sale.invoiceNumber, '—')}`,
    `Customer: ${qrText(sale.customer?.name, 'Walk-in customer')}`,
    'Items:',
    ...items,
    `Paid amount: Rs. ${amount(sale.paid)}`,
    ...(balance > 0 ? [`Balance / credit: Rs. ${amount(balance)}`] : []),
    ...(settlement.hasRefund ? [`Net refundable: Rs. ${amount(settlement.netRefundable)}`] : []),
    ...(refund?.recorded ? [`Refunded by ${refund.method}: Rs. ${amount(refund.amount)}`] : [])
  ].join('\n');
}

function compactQrText(value, maximum = 56) {
  const text = qrText(value, 'Jewellery item');
  return text.length <= maximum ? text : `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function compactInvoiceQrPayload(sale) {
  const settings = sale._businessSettings || {};
  // Phone scanner QR codes have a finite capacity. This compact form keeps
  // every sold line, its weight, paid value and due value when an unusually
  // long customer/item description does not fit in the full readable form.
  const items = (sale.items || []).map((item, index) => {
    const product = item.product || {};
    return `${index + 1}:${compactQrText(item.productName || product.name)} (${weight(item.weight || product.netWeight)}g)`;
  });
  const balance = Number(sale.balance || 0);
  const settlement = urdSettlement(sale.total, sale.urdOffset);
  const refund = urdRefundDetails(sale);
  return [
    `${compactQrText(settings.shopName || 'KUSUM', 30).toUpperCase()}|INV:${qrText(sale.invoiceNumber, '—')}`,
    `CUSTOMER:${compactQrText(sale.customer?.name || 'Walk-in customer', 72)}`,
    `ITEMS:${items.join('; ')}`,
    `PAID:Rs.${amount(sale.paid)}`,
    ...(balance > 0 ? [`BALANCE:Rs.${amount(balance)}`] : []),
    ...(settlement.hasRefund ? [`REFUNDABLE:Rs.${amount(settlement.netRefundable)}`] : []),
    ...(refund?.recorded ? [`REFUND:${refund.method}:Rs.${amount(refund.amount)}`] : [])
  ].join('\n');
}

async function invoiceQrImage(sale) {
  // Keep expensive QR encoding bounded. QR capacity is finite and an invoice
  // can contain an arbitrary number of long item names; trying to encode the
  // entire unbounded string first can delay or fail PDF generation.
  const maximumPayloadBytes = 2200;
  const options = {
    type: 'png', errorCorrectionLevel: 'L', margin: 0, width: 420,
    color: { dark: '#000000', light: '#FFFFFF' }
  };
  const safeQrBuffer = async (payload) => {
    if (Buffer.byteLength(payload, 'utf8') > maximumPayloadBytes) return null;
    try {
      return await QRCode.toBuffer(payload, options);
    } catch (_) {
      return null;
    }
  };
  const full = await safeQrBuffer(invoiceQrPayload(sale));
  if (full) return full;
  const compact = await safeQrBuffer(compactInvoiceQrPayload(sale));
  if (compact) return compact;
  // Do not let a very large invoice fail to produce its tax PDF. The full
  // invoice remains the source of truth if a normal phone QR code cannot hold
  // all item text within its physical capacity.
  return QRCode.toBuffer(`${qrText(sale._businessSettings?.shopName, 'KUSUM JEWELLERS').toUpperCase()}\nInvoice: ${qrText(sale.invoiceNumber, '—')}\nSee this invoice for complete item details.`, options);
}

function drawItem(doc, item, y) {
  const product = item.product || {
    name: item.productName, barcode: item.productBarcode, sku: item.productSku,
    metal: item.productMetal, purity: item.productPurity, grossWeight: item.grossWeight, netWeight: item.weight
  };
  const textY = y + 8;
  // Older bills stored the final line total in unitPrice/lineTotal while the
  // newer weight/rate/taxable fields were zero. Prefer the new fields, then
  // use those legacy values so historical invoices remain truthful.
  const saleWeight = Number(item.weight || 0) > 0 ? item.weight : product.netWeight;
  const metalRate = Number(item.metalRate || 0) > 0 ? item.metalRate : item.unitPrice;
  const lineAmount = Number(item.taxableAmount || 0) > 0 ? item.taxableAmount : item.lineTotal;
  doc.fillColor('#111').font('Helvetica').fontSize(8.1);
  doc.text(item.hsnCode || '', 22, textY, { width: 37, align: 'center', ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(8.1).text(product.name || 'Jewellery item', 66, textY, { width: 107, ellipsis: true });
  doc.font('Helvetica').fontSize(7.8).text(item.huidCode || '', 180, textY, { width: 46, align: 'center', ellipsis: true });
  doc.text(product.purity || '-', 232, textY, { width: 31, align: 'center', ellipsis: true });
  doc.text(String(item.quantity || 1), 269, textY, { width: 21, align: 'center' });
  doc.text(weight(product.grossWeight), 296, textY, { width: 47, align: 'right' });
  doc.text(weight(saleWeight), 349, textY, { width: 46, align: 'right' });
  doc.text(amount(metalRate), 401, textY, { width: 51, align: 'right', ellipsis: true });
  doc.fontSize(7.25).text(makingDisplay(item), 458, textY + 1, { width: 54, align: 'right', ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(8.1).text(amount(lineAmount), 518, textY, { width: 51, align: 'right', ellipsis: true });
}

function renderItems(doc, sale, tableY) {
  const rowHeight = 24;
  const rowsPerPage = Math.floor((page.bodyBottom - (tableY + 30)) / rowHeight);
  let startIndex = 0;
  let activeTableY = tableY;

  while (startIndex < sale.items.length || startIndex === 0) {
    drawTableHeader(doc, activeTableY);
    const count = Math.min(rowsPerPage, Math.max(0, sale.items.length - startIndex));
    const bodyY = activeTableY + 30;
    const isLastPage = startIndex + count >= sale.items.length;
    const bodyHeight = isLastPage ? page.bodyBottom - bodyY : rowsPerPage * rowHeight;
    drawGrid(doc, bodyY, bodyHeight);

    for (let index = 0; index < count; index += 1) drawItem(doc, sale.items[startIndex + index], bodyY + index * rowHeight);
    if (isLastPage) return bodyY + bodyHeight;

    startIndex += count;
    doc.addPage();
    activeTableY = invoiceHeader(doc, sale, true);
  }
  return page.bodyBottom;
}

function footerTotals(doc, sale, y) {
  const gross = Number(sale.subtotal || 0);
  const discount = Number(sale.discount || 0);
  const gst = Number(sale.gstAmount || 0);
  const cgst = Math.round((gst / 2) * 100) / 100;
  const sgst = Math.round((gst - cgst) * 100) / 100;
  const taxRate = Number(sale.gstRate || 0) / 2;
  const urd = Number(sale.urdOffset || 0);
  const settlement = urdSettlement(sale.total, urd);
  const netPayable = settlement.netPayable;
  const netRefundable = settlement.netRefundable;
  const calculatedInvoiceTotal = Math.max(0, gross - discount) + gst;
  const roundOff = Math.round((Number(sale.total || 0) - calculatedInvoiceTotal) * 100) / 100;
  const refund = urdRefundDetails(sale);
  const totalX = 414;
  const footerHeight = 140;
  const rows = [
    ['Gross Amt.', amount(gross)],
    [`ADD CGST ${compactNumber(taxRate)}%`, amount(cgst)],
    [`ADD SGST ${compactNumber(taxRate)}%`, amount(sgst)],
    ['ADD IGST 3.0%', '0.00'],
    ['Less URD', amount(urd)],
    ['Less Disc.', amount(discount)],
    ['Round Off', amount(roundOff)],
    [settlement.hasRefund ? 'Net Refundable' : 'Net Payable', amount(settlement.hasRefund ? netRefundable : netPayable)]
  ];

  box(doc, page.left, y, page.right - page.left, footerHeight);
  line(doc, totalX, y, totalX, y + footerHeight, 0.45);
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(8.5).text('Invoice Value [ In Words ] :', 27, y + 8);
  doc.font('Helvetica').fontSize(8.4).text(
    settlement.hasRefund ? `Refundable: Rs. ${amountInWords(netRefundable)}` : `Rs. : ${amountInWords(netPayable)}`,
    160, y + 8, { width: totalX - 174, ellipsis: true }
  );
  line(doc, page.left, y + 31, totalX, y + 31, 0.45);
  doc.font('Helvetica-Bold').fontSize(8.4).text('Narration :', 27, y + 38);
  doc.font('Helvetica').fontSize(8.2).text(sale.notes || '', 85, y + 38, { width: totalX - 99, height: 17, ellipsis: true });
  line(doc, page.left, y + 60, totalX, y + 60, 0.45);
  const cashPaid = Number(sale.cashPaid || 0);
  const upiPaid = Number(sale.upiPaid || 0);
  const cardPaid = Number(sale.cardPaid || 0);
  const bankPaid = Number(sale.bankPaid || 0);
  const detailedPayments = positiveInvoicePayments(sale);

  // Preserve the established Cash/UPI payment box. Blank zero-amount methods
  // are omitted; borders, columns, fonts and the PDF page format do not move.
  if (refund) {
    doc.font('Helvetica-Bold').fontSize(8.2).text(refund.recorded ? `Refunded by ${refund.method}` : 'Refund Due', 50, y + 70, { width: 180 });
    doc.text(amount(refund.amount), 50, y + 84, { width: 155 });
  } else if (cardPaid <= 0 && bankPaid <= 0 && (cashPaid > 0 || upiPaid > 0)) {
    const cashAndUpi = detailedPayments.filter(([method]) => method === 'CASH' || method === 'UPI');
    cashAndUpi.forEach(([method, value], index) => {
      doc.font('Helvetica-Bold').fontSize(8.2).text(`By ${method}`, 50, y + 68 + index * 27, { width: 155 });
      doc.text(amount(value), 50, y + 81 + index * 27, { width: 155 });
    });
    if (Number(sale.balance || 0) > 0) doc.font('Helvetica').fontSize(7.8).text(`Balance Due: ${amount(sale.balance)}`, 50, y + 123, { width: 210 });
  } else if (detailedPayments.length > 1) {
    detailedPayments.forEach(([method, value], index) => {
      doc.font('Helvetica-Bold').fontSize(7.8).text(`By ${method}: ${amount(value)}`, 50, y + 67 + index * 13, { width: 300 });
    });
    if (Number(sale.balance || 0) > 0) doc.font('Helvetica').fontSize(7.6).text(`Balance Due: ${amount(sale.balance)}`, 50, y + 126, { width: 210 });
  } else {
    const paymentLabel = String(sale.paymentMethod || 'CASH').replaceAll('_', ' ');
    doc.font('Helvetica-Bold').fontSize(8.7).text(`By ${paymentLabel}`, 50, y + 70, { width: 155 });
    doc.text(amount(sale.paid), 50, y + 84, { width: 155 });
    if (Number(sale.balance || 0) > 0) doc.font('Helvetica').fontSize(8.2).text(`Balance Due: ${amount(sale.balance)}`, 50, y + 103, { width: 210 });
  }

  rows.forEach(([label, value], index) => {
    const rowY = y + 7 + index * 16;
    const emphasis = label === 'Net Payable' || label === 'Net Refundable';
    if (emphasis) line(doc, totalX, rowY - 3, page.right, rowY - 3, 0.45);
    doc.fillColor('#111').font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 9.3 : 8.8).text(label, totalX + 9, rowY, { width: 90 });
    doc.font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 9.3 : 8.8).text(value, 510, rowY, { width: 54, align: 'right' });
  });
  return y + footerHeight;
}

function signatureBox(doc, y, qrImage, sale) {
  const settings = sale._businessSettings || {};
  const height = 82;
  const qrSplit = page.left + 108;
  const authorisedSplit = page.right - 203;
  box(doc, page.left, y, page.right - page.left, height);
  line(doc, qrSplit, y, qrSplit, y + height, 0.45);
  line(doc, authorisedSplit, y, authorisedSplit, y + height, 0.45);
  // Keep the existing footer box and page size/table coordinates. The footer
  // now carries QR, customer acknowledgement, and the shop signature in
  // three clearly separated columns.
  doc.image(qrImage, page.left + 25, y + 5, { fit: [58, 58] });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(6.6).text('SCAN INVOICE DETAILS', page.left + 4, y + 67, { width: qrSplit - page.left - 8, align: 'center' });

  const customerX = qrSplit;
  const customerWidth = authorisedSplit - qrSplit;
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(9).text('Customer signature', customerX + 10, y + 20, { width: customerWidth - 20, align: 'center' });
  line(doc, customerX + 16, y + 56, authorisedSplit - 16, y + 56, 0.6);
  doc.fillColor('#111').font('Helvetica').fontSize(7.4).text('Customer acknowledgement', customerX + 10, y + 63, { width: customerWidth - 20, align: 'center' });

  const signatureX = authorisedSplit;
  const signatureWidth = page.right - authorisedSplit - 20;
  doc.font('Helvetica-Bold').fontSize(9.2).text(`For ${settings.shopName || 'Kusum Jewellers'}`, signatureX + 10, y + 6, { width: signatureWidth, align: 'center' });
  const signatureImage = settings.signatureImage ? Buffer.from(settings.signatureImage) : authorisedSignaturePath;
  if (!settings.signatureImage && !fs.existsSync(authorisedSignaturePath)) {
    throw new Error('The authorised signature image is missing from the ERP installation.');
  }
  doc.image(signatureImage, signatureX + 10, y + 16, { fit: [signatureWidth, 36], align: 'center', valign: 'center' });
  line(doc, signatureX + 10, y + 56, page.right - 10, y + 56, 0.6);
  doc.font('Helvetica-Bold').fontSize(8).text('Authorised Signatory', signatureX + 10, y + 63, { width: signatureWidth, align: 'center' });
}

async function createSaleInvoicePdf(sale, businessSettings = {}) {
  const invoice = { ...sale, _businessSettings: businessSettings };
  const qrImage = await invoiceQrImage(invoice);
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `Tax Invoice ${invoice.invoiceNumber}` } });
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    const tableY = invoiceHeader(doc, invoice);
    const itemsEnd = renderItems(doc, invoice, tableY);
    const footerEnd = footerTotals(doc, invoice, itemsEnd + 2);
    signatureBox(doc, footerEnd, qrImage, invoice);
    doc.end();
  });
}

async function writeSaleInvoice(res, sale, businessSettings = {}) {
  const invoice = { ...sale, _businessSettings: businessSettings };
  const filename = `${invoice.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.end(await createSaleInvoicePdf(sale, businessSettings));
}

module.exports = { writeSaleInvoice, createSaleInvoicePdf, makingDisplay, amountInWords, invoiceQrPayload, positiveInvoicePayments, urdRefundDetails };
