const { businessSettings, sale } = require('./demo-sale.cjs');

const customer = sale.customer;
const reportDate = '2026-09-20';

const metadata = {
  shopName: businessSettings.shopName,
  address: businessSettings.shopAddress,
  gstin: businessSettings.gstin,
  panNumber: businessSettings.panNumber,
  primaryPhone: businessSettings.primaryPhone,
  secondaryPhone: businessSettings.secondaryPhone,
  creator: businessSettings.shopName,
  lastModifiedBy: businessSettings.shopName
};

const col = {
  date: (key, label = 'Date', width = 14) => ({ key, label, type: 'date', width }),
  dateList: (key, label = 'Date', width = 18) => ({ key, label, type: 'date-list', width }),
  text: (key, label, width = 20) => ({ key, label, type: 'text', width }),
  identifier: (key, label, width = 18) => ({ key, label, type: 'identifier', width }),
  currency: (key, label, width = 18) => ({ key, label, type: 'currency', width }),
  number: (key, label, width = 12) => ({ key, label, type: 'number', width }),
  integer: (key, label, width = 12) => ({ key, label, type: 'integer', width }),
  weight: (key, label, width = 13) => ({ key, label, type: 'weight', width })
};

function sheet(name, title, columns, rows, options = {}) {
  return {
    name,
    title,
    subtitle: options.subtitle || `Portfolio sample | ${reportDate}`,
    columns,
    rows,
    ...options
  };
}

function report(filename, title, columns, rows, options = {}) {
  const sheets = options.sheets || [sheet('Report', title, columns, rows, options)];
  return {
    title,
    subtitle: options.subtitle || `Portfolio sample | ${reportDate}`,
    filename,
    shopName: businessSettings.shopName,
    metadata,
    columns,
    rows,
    sheets
  };
}

const salesColumns = [
  col.date('saleDate', 'Date'), col.identifier('invoiceNumber', 'Doc-no', 22), col.text('customerName', 'Customer', 28),
  col.weight('grossWeight', 'Gr-wt'), col.weight('netWeight', 'Net-wt'), col.currency('taxableAmount', 'Taxable-amt'),
  col.currency('cgstAmount', 'CGST'), col.currency('sgstAmount', 'SGST'), col.currency('igstAmount', 'IGST'),
  col.currency('total', 'Total'), col.currency('urdAdjustment', 'URD'), col.currency('discount', 'Discount'), col.currency('netAmount', 'Net-amt')
];
const salesRows = [{
  saleDate: reportDate, invoiceNumber: sale.invoiceNumber, customerName: customer.name,
  grossWeight: 25.2, netWeight: 22.85, taxableAmount: sale.subtotal, cgstAmount: sale.gstAmount / 2,
  sgstAmount: sale.gstAmount / 2, igstAmount: 0, total: sale.total, urdAdjustment: 0, discount: 0, netAmount: sale.total
}];

const topSellingColumns = [
  col.text('itemName', 'Item name', 28), col.text('metal', 'Metal', 12), col.text('purity', 'Purity', 12),
  col.integer('invoiceCount', 'Invoices'), col.integer('quantitySold', 'Pieces sold', 14), col.weight('netWeight', 'Net wt. sold (g)'), col.currency('salesValue', 'Sales value')
];
const topSellingGold = [{ itemName: '22K Gold Ring', metal: 'Gold', purity: '22K', invoiceCount: 1, quantitySold: 1, netWeight: 4.85, salesValue: 39925.2 }];
const topSellingSilver = [{ itemName: 'Silver Chain', metal: 'Silver', purity: '925', invoiceCount: 1, quantitySold: 1, netWeight: 18, salesValue: 2142 }];

const cancelledSalesColumns = [
  col.date('saleDate', 'Invoice date'), col.date('cancelledAt', 'Cancelled date'), col.identifier('invoiceNumber', 'Invoice no.', 20),
  col.identifier('customerPhone', 'Customer phone', 16), col.text('customerName', 'Customer', 24), col.integer('itemCount', 'Items'),
  col.currency('total', 'Invoice total'), col.currency('paid', 'Amount paid'), col.currency('urdValuation', 'URD valuation'), col.text('itemNames', 'Items', 38)
];

const urdColumns = [
  col.date('purchaseDate', 'Date'), col.identifier('purchaseNumber', 'Doc-no', 22), col.text('customerName', 'Customer', 28),
  col.weight('grossWeight', 'Gross-wt'), col.weight('netWeight', 'Net-wt'), col.currency('totalAmount', 'Amount'), col.text('remark', 'Remark', 34)
];

const pledgeColumns = [
  col.integer('srNo', 'Sr. No.', 9), col.date('pledgeDate', 'Date'), col.identifier('pledgeNumber', 'Doc-no', 22), col.text('customerName', 'Customer', 26),
  col.text('itemDescription', 'Jewellery held', 26), col.text('metal', 'Metal', 12), col.text('purity', 'Purity', 10), col.weight('grossWeight', 'Gross-wt'), col.weight('netWeight', 'Net-wt'),
  col.currency('valuationAmount', 'Valuation'), col.currency('principalAmount', 'Money lent'), col.currency('principalRepaid', 'Principal repaid'),
  col.currency('principalDue', 'Principal due'), col.currency('interestReceived', 'Interest received'), col.currency('totalAmountReceived', 'Total received'),
  col.date('dueDate', 'Return due'), col.text('status', 'Status', 14)
];

const supplierColumns = [
  col.date('purchaseDate', 'Date'), col.identifier('purchaseNumber', 'Doc-no', 22), col.text('supplierName', 'Supplier', 24), col.text('itemName', 'Item', 24),
  col.text('category', 'Category', 18), col.text('metal', 'Metal', 12), col.text('purity', 'Purity', 10), col.integer('quantity', 'Pieces'), col.identifier('barcode', 'Barcode', 16),
  col.weight('grossWeight', 'Gross-wt'), col.weight('netWeight', 'Net-wt'), col.currency('ratePerGram', 'Rate/g'), col.currency('totalAmount', 'Amount'),
  col.currency('paid', 'Paid'), col.currency('due', 'Due'), col.text('reference', 'Reference', 20)
];

const cancelledUrdColumns = [
  col.date('purchaseDate', 'Purchase date'), col.date('cancelledAt', 'Cancelled date'), col.identifier('purchaseNumber', 'URD no.', 22),
  col.identifier('customerPhone', 'Customer phone', 16), col.text('customerName', 'Customer', 24), col.text('metal', 'Metal', 12), col.text('purity', 'Purity', 10),
  col.weight('netWeight', 'Net wt. (g)'), col.currency('totalAmount', 'Valuation'), col.currency('saleOffset', 'Sale adjustment'), col.currency('paid', 'Payout / refund'), col.text('description', 'Description', 30)
];

const cashbookColumns = [
  col.date('entryDate', 'Date'), col.text('type', 'Type', 12), col.text('paymentMethod', 'Payment method', 16), col.text('description', 'Description', 34),
  col.currency('moneyIn', 'Money in'), col.currency('moneyOut', 'Money out'), col.currency('runningBalance', 'Running balance'), col.identifier('reference', 'Reference', 18),
  col.identifier('customerPhone', 'Customer phone', 16), col.text('customerName', 'Customer', 24), col.text('syncLedger', 'Ledger synced', 14), col.text('notes', 'Notes', 30)
];

const inventoryColumns = [
  col.date('createdAt', 'Date'), col.text('metal', 'Metal', 12), col.text('itemName', 'Item name', 24), col.text('category', 'Category', 18), col.text('purity', 'Purity', 10),
  col.identifier('barcode', 'Barcode', 16), col.weight('grossWeight', 'Gross wt. (g)'), col.weight('stoneWeight', 'Stone wt. (g)'), col.weight('netWeight', 'Net wt. (g)'), col.integer('quantity', 'Stock qty'),
  col.text('status', 'Status', 14), col.text('location', 'Location', 16), col.text('notes', 'Notes', 30)
];
const inventoryRows = [
  { createdAt: reportDate, metal: 'Gold', itemName: '22K Gold Ring', category: 'Rings', purity: '22K', barcode: 'DEMO-GOLD-22K-001', grossWeight: 5.2, stoneWeight: 0.35, netWeight: 4.85, quantity: 1, status: 'Available', location: 'Showcase A', notes: 'Portfolio sample stock' },
  { createdAt: reportDate, metal: 'Silver', itemName: 'Silver Chain', category: 'Chains', purity: '925', barcode: 'DEMO-SILVER-001', grossWeight: 20, stoneWeight: 0, netWeight: 18, quantity: 1, status: 'Available', location: 'Showcase B', notes: 'Portfolio sample stock' }
];

const stockMovementColumns = [
  col.date('createdAt', 'Movement date'), col.text('type', 'Movement type', 16), col.identifier('barcode', 'Barcode', 16), col.text('itemName', 'Item name', 24),
  col.text('metal', 'Metal', 12), col.text('purity', 'Purity', 10), col.integer('quantity', 'Qty change'), col.weight('netWeight', 'Net wt. (g)'), col.text('note', 'Note', 32)
];

const customerColumns = [
  col.date('createdAt', 'Registered date'), col.identifier('customerPhone', 'Phone / ID', 18), col.text('customerName', 'Customer name', 24), col.identifier('panNumber', 'PAN no.', 14),
  col.text('email', 'Email', 24), col.text('address', 'Address', 30), col.integer('salesCount', 'Total sales'), col.integer('urdCount', 'URD purchases'), col.integer('schemeCount', 'Savings schemes'), col.currency('outstanding', 'Outstanding due')
];

const schemeColumns = [col.integer('srNo', 'Sr. No.', 9), col.identifier('enrollmentNumber', 'Scheme Doc No.', 22), { ...col.text('customerName', 'Name', 40), wrap: true }, col.identifier('customerPhone', 'Mobile No.', 16), col.currency('amount', 'Amount')];
const schemeMonthColumns = [col.integer('srNo', 'Sr. No.', 9), col.identifier('enrollmentNumber', 'Scheme Doc No.', 22), { ...col.text('customerName', 'Name', 40), wrap: true }, col.identifier('customerPhone', 'Mobile No.', 16), col.dateList('paidDates', 'Paid Date', 20), { ...col.text('paymentType', 'Payment Type', 30), wrap: true }, col.currency('amount', 'Amount')];

const customerLedgerColumns = [col.integer('srNo', 'Sr No.', 9), col.date('date', 'Date'), col.text('customerName', 'Customer name', 26), col.identifier('customerPhone', 'Phone no.', 16), col.currency('due', 'Due')];
const rateColumns = [col.date('rateDate', 'Rate date'), col.currency('gold22k', '22K gold / g'), col.currency('gold24k', '24K gold / g'), col.currency('silver', 'Silver / g'), col.text('note', 'Note', 34)];

const salesPayload = report('Kusum-ERP-demo-sales-register.xlsx', 'Sales invoices', salesColumns, salesRows, {
  sheets: [
    sheet('All', 'All Sales Register', salesColumns, salesRows, { layout: 'ca-register', totalKeys: ['grossWeight', 'netWeight', 'taxableAmount', 'cgstAmount', 'sgstAmount', 'igstAmount', 'total', 'urdAdjustment', 'discount', 'netAmount'] }),
    sheet('Gold', 'Gold Sales Register', salesColumns, [{ ...salesRows[0], grossWeight: 5.2, netWeight: 4.85, taxableAmount: 39925.2, cgstAmount: 598.88, sgstAmount: 598.88, total: 41122.96, netAmount: 41122.96 }], { layout: 'ca-register', totalKeys: ['grossWeight', 'netWeight', 'taxableAmount', 'cgstAmount', 'sgstAmount', 'total', 'netAmount'] }),
    sheet('Silver', 'Silver Sales Register', salesColumns, [{ ...salesRows[0], grossWeight: 20, netWeight: 18, taxableAmount: 2142, cgstAmount: 32.13, sgstAmount: 32.13, total: 2206.26, netAmount: 2206.26 }], { layout: 'ca-register', totalKeys: ['grossWeight', 'netWeight', 'taxableAmount', 'cgstAmount', 'sgstAmount', 'total', 'netAmount'] })
  ]
});

const excelReports = [
  salesPayload,
  report('Kusum-ERP-demo-top-selling-items.xlsx', 'Top Selling Items', topSellingColumns, [...topSellingGold, ...topSellingSilver], {
    sheets: [
      sheet('Gold top sellers', 'Top Selling Items - Gold', topSellingColumns, topSellingGold, { infoRows: [{ label: 'Item types', value: 1, type: 'integer' }, { label: 'Pieces sold', value: 1, type: 'integer' }, { label: 'Net weight sold', value: 4.85, type: 'weight' }, { label: 'Sales value', value: 39925.2, type: 'currency' }] }),
      sheet('Silver top sellers', 'Top Selling Items - Silver', topSellingColumns, topSellingSilver, { infoRows: [{ label: 'Item types', value: 1, type: 'integer' }, { label: 'Pieces sold', value: 1, type: 'integer' }, { label: 'Net weight sold', value: 18, type: 'weight' }, { label: 'Sales value', value: 2142, type: 'currency' }] })
    ]
  }),
  report('Kusum-ERP-demo-cancelled-sales.xlsx', 'Cancelled Invoice Register', cancelledSalesColumns, [{ saleDate: '2026-09-18', cancelledAt: reportDate, invoiceNumber: 'SB-DEMO-2026-000', customerPhone: customer.phone, customerName: customer.name, itemCount: 1, total: 18500, paid: 18500, urdValuation: 0, itemNames: '22K Gold Pendant' }], { infoRows: [{ label: 'Cancelled invoices', value: 1, type: 'integer' }, { label: 'Cancelled invoice value', value: 18500, type: 'currency' }] }),
  report('Kusum-ERP-demo-urd-purchases.xlsx', '03. URD Purchase', urdColumns, [{ purchaseDate: reportDate, purchaseNumber: 'URD-DEMO-2026-001', customerName: customer.name, grossWeight: 8.3, netWeight: 7.7, totalAmount: 55440, remark: 'Standalone payout' }], { layout: 'ca-register', totalKeys: ['grossWeight', 'netWeight', 'totalAmount'] }),
  report('Kusum-ERP-demo-pledge-loans.xlsx', 'Gold / Silver Pledge Loan Register', pledgeColumns, [{ srNo: 1, pledgeDate: reportDate, pledgeNumber: 'PL-DEMO-2026-001', customerName: customer.name, itemDescription: 'Gold necklace', metal: 'Gold', purity: '22K', grossWeight: 12.4, netWeight: 12, valuationAmount: 88200, principalAmount: 65000, principalRepaid: 15000, principalDue: 50000, interestReceived: 1950, totalAmountReceived: 16950, dueDate: '2027-03-20', status: 'Active' }], { layout: 'ca-register', totalKeys: ['grossWeight', 'netWeight', 'valuationAmount', 'principalAmount', 'principalRepaid', 'principalDue', 'interestReceived', 'totalAmountReceived'] }),
  report('Kusum-ERP-demo-supplier-purchases.xlsx', 'Supplier Purchase Register', supplierColumns, [{ purchaseDate: reportDate, purchaseNumber: 'PUR-DEMO-2026-001', supplierName: 'Shree Bullion Traders', itemName: '22K Gold chain', category: 'Chains', metal: 'Gold', purity: '22K', quantity: 1, barcode: 'SUP-GOLD-001', grossWeight: 10.2, netWeight: 9.8, ratePerGram: 7280, totalAmount: 71344, paid: 50000, due: 21344, reference: 'Supplier bill SB-1042' }], { layout: 'ca-register', totalKeys: ['grossWeight', 'netWeight', 'totalAmount', 'paid', 'due'] }),
  report('Kusum-ERP-demo-cancelled-urd-purchases.xlsx', 'Cancelled URD Purchases', cancelledUrdColumns, [{ purchaseDate: '2026-09-15', cancelledAt: reportDate, purchaseNumber: 'URD-DEMO-2026-000', customerPhone: customer.phone, customerName: customer.name, metal: 'Gold', purity: '22K', netWeight: 4.2, totalAmount: 30240, saleOffset: 0, paid: 30240, description: 'Cancelled duplicate entry' }], { infoRows: [{ label: 'Cancelled purchases', value: 1, type: 'integer' }, { label: 'Cancelled valuation', value: 30240, type: 'currency' }] }),
  report('Kusum-ERP-demo-cashbook.xlsx', 'Daily Cashbook', cashbookColumns, [{ entryDate: reportDate, type: 'IN', paymentMethod: 'UPI', description: `Sale ${sale.invoiceNumber}`, moneyIn: sale.upiPaid, moneyOut: 0, runningBalance: sale.upiPaid, reference: sale.invoiceNumber, customerPhone: customer.phone, customerName: customer.name, syncLedger: 'Yes', notes: 'Portfolio sample receipt' }, { entryDate: reportDate, type: 'OUT', paymentMethod: 'Bank transfer', description: 'URD payout', moneyIn: 0, moneyOut: 55440, runningBalance: sale.upiPaid - 55440, reference: 'URD-DEMO-2026-001', customerPhone: customer.phone, customerName: customer.name, syncLedger: 'Yes', notes: '' }], {
    sheets: [
      sheet('Summary', 'Daily Cashbook - Summary', [col.text('paymentMethod', 'Payment method', 22), col.integer('entries', 'Total entries'), col.currency('openingBalance', 'Opening balance'), col.currency('moneyIn', 'Total money in'), col.currency('moneyOut', 'Total money out'), col.currency('netBalance', 'Net movement'), col.currency('closingBalance', 'Closing balance')], [{ paymentMethod: 'UPI', entries: 1, openingBalance: 0, moneyIn: sale.upiPaid, moneyOut: 0, netBalance: sale.upiPaid, closingBalance: sale.upiPaid }, { paymentMethod: 'Bank transfer', entries: 1, openingBalance: 0, moneyIn: 0, moneyOut: 55440, netBalance: -55440, closingBalance: -55440 }], { infoRows: [{ label: 'Total entries', value: 2, type: 'integer' }, { label: 'Money in', value: sale.upiPaid, type: 'currency' }, { label: 'Money out', value: 55440, type: 'currency' }] }),
      sheet('All entries', 'Daily Cashbook - All entries', cashbookColumns, [{ entryDate: reportDate, type: 'IN', paymentMethod: 'UPI', description: `Sale ${sale.invoiceNumber}`, moneyIn: sale.upiPaid, moneyOut: 0, runningBalance: sale.upiPaid, reference: sale.invoiceNumber, customerPhone: customer.phone, customerName: customer.name, syncLedger: 'Yes', notes: 'Portfolio sample receipt' }, { entryDate: reportDate, type: 'OUT', paymentMethod: 'Bank transfer', description: 'URD payout', moneyIn: 0, moneyOut: 55440, runningBalance: sale.upiPaid - 55440, reference: 'URD-DEMO-2026-001', customerPhone: customer.phone, customerName: customer.name, syncLedger: 'Yes', notes: '' }])
    ]
  }),
  report('Kusum-ERP-demo-savings-schemes.xlsx', 'Scheme Register', schemeColumns, [{ srNo: 1, enrollmentNumber: 'SCH-DEMO-2026-001', customerName: customer.name, customerPhone: customer.phone, amount: 15000 }], { layout: 'ca-register', totalKeys: ['amount'] }),
  report('Kusum-ERP-demo-inventory.xlsx', 'Inventory - All individual records', inventoryColumns, inventoryRows, {
    sheets: [
      sheet('All records', 'Inventory - All individual records', inventoryColumns, inventoryRows, { infoRows: [{ label: 'Stock pieces', value: 2, type: 'integer' }, { label: 'Net weight', value: 22.85, type: 'weight' }] }),
      sheet('Item summary', 'Inventory - Item-wise summary', [col.text('metal', 'Metal', 12), col.text('itemName', 'Item name', 24), col.text('category', 'Category', 18), col.text('purity', 'Purity', 10), col.integer('records', 'Barcode records'), col.integer('quantity', 'Stock pieces'), col.weight('grossWeight', 'Gross wt. (g)'), col.weight('netWeight', 'Net wt. (g)'), col.currency('value', 'Total value')], [{ metal: 'Gold', itemName: '22K Gold Ring', category: 'Rings', purity: '22K', records: 1, quantity: 1, grossWeight: 5.2, netWeight: 4.85, value: 39925.2 }, { metal: 'Silver', itemName: 'Silver Chain', category: 'Chains', purity: '925', records: 1, quantity: 1, grossWeight: 20, netWeight: 18, value: 2142 }], { infoRows: [{ label: 'Stock pieces', value: 2, type: 'integer' }, { label: 'Net weight', value: 22.85, type: 'weight' }] }),
      sheet('Gold', 'Inventory - Gold records', inventoryColumns, [inventoryRows[0]], { infoRows: [{ label: 'Stock pieces', value: 1, type: 'integer' }] }),
      sheet('Silver', 'Inventory - Silver records', inventoryColumns, [inventoryRows[1]], { infoRows: [{ label: 'Stock pieces', value: 1, type: 'integer' }] })
    ]
  }),
  report('Kusum-ERP-demo-stock-movements.xlsx', 'Stock Movement Register', stockMovementColumns, [{ createdAt: reportDate, type: 'Stock In', barcode: 'DEMO-GOLD-22K-001', itemName: '22K Gold Ring', metal: 'Gold', purity: '22K', quantity: 1, netWeight: 4.85, note: 'Received from supplier' }, { createdAt: reportDate, type: 'Sale', barcode: 'DEMO-SILVER-001', itemName: 'Silver Chain', metal: 'Silver', purity: '925', quantity: -1, netWeight: 18, note: `Sold in ${sale.invoiceNumber}` }], { infoRows: [{ label: 'Total movements', value: 2, type: 'integer' }, { label: 'Quantity in', value: 1, type: 'integer' }, { label: 'Quantity out', value: 1, type: 'integer' }, { label: 'Net quantity change', value: 0, type: 'integer' }] }),
  report('Kusum-ERP-demo-customers.xlsx', 'Customer Directory', customerColumns, [{ createdAt: reportDate, customerPhone: customer.phone, customerName: customer.name, panNumber: '', email: '', address: customer.address, salesCount: 1, urdCount: 1, schemeCount: 1, outstanding: 0 }], { infoRows: [{ label: 'Total customers', value: 1, type: 'integer' }, { label: 'Total outstanding', value: 0, type: 'currency' }] }),
  report('Kusum-ERP-demo-customer-ledger.xlsx', 'Customer Ledger Register', customerLedgerColumns, [{ srNo: 1, date: reportDate, customerName: customer.name, customerPhone: customer.phone, due: 0 }], { layout: 'ca-register' }),
  report('Kusum-ERP-demo-daily-rates.xlsx', 'Daily Metal Rate Register', rateColumns, [{ rateDate: reportDate, gold22k: 7350, gold24k: 7950, silver: 94, note: 'Illustrative portfolio rate card' }], { infoRows: [{ label: 'Rate days', value: 1, type: 'integer' }] }),
  report('Kusum-ERP-demo-scheme-consolidated-register.xlsx', 'Consolidated Scheme Report', schemeColumns, [{ srNo: 1, enrollmentNumber: 'SCH-DEMO-2026-001', customerName: customer.name, customerPhone: customer.phone, amount: 15000 }], { layout: 'ca-register', totalKeys: ['amount'] }),
  report('Kusum-ERP-demo-scheme-month-1-register.xlsx', 'Month 1 Scheme Report', schemeMonthColumns, [{ srNo: 1, enrollmentNumber: 'SCH-DEMO-2026-001', customerName: customer.name, customerPhone: customer.phone, paidDates: reportDate, paymentType: 'UPI ₹5,000.00', amount: 5000 }], { layout: 'ca-register', landscape: true, totalKeys: ['amount'] })
];

module.exports = { excelReports, metadata };
