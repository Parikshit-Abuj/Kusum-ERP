import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';

const require = createRequire(import.meta.url);
const { writeSaleInvoice } = require('../src/lib/sale-invoice-pdf');
const { writeCustomerOrderInvoice } = require('../src/lib/customer-order-pdf');
const { writeSchemeInstallmentReceipt, writeSchemeConsolidatedReceipt } = require('../src/lib/scheme-payment-pdf');
const { writeUrdPurchaseInvoice } = require('../src/lib/urd-invoice-pdf');
const { writePledgeLoanInvoice } = require('../src/lib/pledge-invoice-pdf');
const { buildExcelExport } = require('../src/lib/excel-export');
const { businessSettings, sale } = require('../docs/portfolio/demo-sale.cjs');
const { customerOrder, enrollment, schemeInstallments, urdPurchase, pledgeLoan } = require('../docs/portfolio/demo-documents.cjs');
const { excelReports } = require('../docs/portfolio/demo-excel-reports.cjs');

const outputDir = path.resolve('docs/portfolio/assets');

await fs.mkdir(outputDir, { recursive: true });
class CaptureResponse extends Writable {
  constructor() {
    super();
    this.chunks = [];
  }

  setHeader() {}

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  buffer() {
    return Buffer.concat(this.chunks);
  }
}

async function capturePdf(writer, ...args) {
  const response = new CaptureResponse();
  const finished = new Promise((resolve, reject) => {
    response.once('finish', () => resolve(response.buffer()));
    response.once('error', reject);
  });
  await writer(response, ...args);
  return finished;
}

async function writePdf(filename, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error(`${filename} was not generated as a valid PDF.`);
  }
  const outputPath = path.join(outputDir, filename);
  await fs.writeFile(outputPath, buffer);
  console.log(`Generated ${outputPath} (${buffer.length} bytes)`);
}

await writePdf('Kusum-ERP-demo-sales-invoice.pdf', await capturePdf(writeSaleInvoice, sale, businessSettings));
await writePdf('Kusum-ERP-demo-customer-order.pdf', await capturePdf(writeCustomerOrderInvoice, customerOrder, businessSettings));
await writePdf('Kusum-ERP-demo-scheme-payment.pdf', await capturePdf(writeSchemeInstallmentReceipt, enrollment, schemeInstallments[0], businessSettings));
await writePdf('Kusum-ERP-demo-scheme-consolidated.pdf', await capturePdf(writeSchemeConsolidatedReceipt, enrollment, businessSettings, { narration: 'Portfolio demonstration receipt.' }));
await writePdf('Kusum-ERP-demo-urd-purchase.pdf', await capturePdf(writeUrdPurchaseInvoice, urdPurchase, businessSettings));
await writePdf('Kusum-ERP-demo-pledge-loan.pdf', await capturePdf(writePledgeLoanInvoice, pledgeLoan, businessSettings));

for (const excelPayload of excelReports) {
  const workbook = await buildExcelExport(excelPayload);
  if (!Buffer.isBuffer(workbook) || workbook.subarray(0, 2).toString() !== 'PK') {
    throw new Error(`${excelPayload.filename} was not generated as an XLSX archive.`);
  }
  const workbookPath = path.join(outputDir, excelPayload.filename);
  await fs.writeFile(workbookPath, workbook);
  console.log(`Generated ${workbookPath} (${workbook.length} bytes)`);
}
