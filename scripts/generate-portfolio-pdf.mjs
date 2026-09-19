import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSaleInvoicePdf } = require('../src/lib/sale-invoice-pdf');
const { businessSettings, sale } = require('../docs/portfolio/demo-sale.cjs');

const outputDir = path.resolve('docs/portfolio/assets');
const outputPath = path.join(outputDir, 'Kusum-ERP-demo-sales-invoice.pdf');

await fs.mkdir(outputDir, { recursive: true });
const pdf = await createSaleInvoicePdf(sale, businessSettings);
if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 4).toString() !== '%PDF') {
  throw new Error('The portfolio invoice generator did not return a valid PDF buffer.');
}
await fs.writeFile(outputPath, pdf);
console.log(`Generated ${outputPath} (${pdf.length} bytes)`);
