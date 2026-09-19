const { businessSettings, sale } = require('./demo-sale.cjs');

const customer = sale.customer;

const customerOrder = {
  orderNumber: 'CO-DEMO-2026-001',
  orderDate: new Date('2026-09-20T13:15:00+05:30'),
  dueDate: '2026-10-05',
  status: 'OPEN',
  customer,
  itemName: 'Custom 22K Gold Pendant',
  category: 'Pendants',
  metal: 'GOLD',
  purity: '22K',
  quantity: 1,
  targetGrossWeight: 6.200,
  targetNetWeight: 5.800,
  quotedAmount: 47850,
  customerAdvance: 20000,
  refundedAmount: 0,
  advancePaymentMethod: 'UPI',
  notes: 'Illustrative customer order for the portfolio.',
  supplier: null,
  cashbookEntries: [{ entryDate: '2026-09-20', type: 'IN', paymentMethod: 'UPI', amount: 20000 }]
};

const schemeCustomer = { ...customer };
const schemePlan = {
  name: 'Suvarna Sanchay Yojana',
  durationMonths: 12,
  monthlyAmount: 5000,
  totalSchemeAmount: 60000
};
const schemeInstallments = [1, 2, 3].map((installmentNumber) => ({
  installmentNumber,
  dueDate: new Date(`2026-${String(installmentNumber + 8).padStart(2, '0')}-20T12:00:00+05:30`),
  paymentDate: new Date(`2026-${String(installmentNumber + 8).padStart(2, '0')}-20T12:00:00+05:30`),
  paidAmount: 5000,
  paymentMethod: installmentNumber === 1 ? 'UPI' : 'CASH',
  notes: installmentNumber === 1 ? 'First monthly contribution.' : '',
  payments: [{
    amount: 5000,
    paymentDate: new Date(`2026-${String(installmentNumber + 8).padStart(2, '0')}-20T12:00:00+05:30`),
    paymentMethod: installmentNumber === 1 ? 'UPI' : 'CASH'
  }]
}));
const enrollment = {
  enrollmentNumber: 'SCH-DEMO-2026-001',
  startDate: new Date('2026-09-20T12:00:00+05:30'),
  customer: schemeCustomer,
  schemePlan,
  installments: schemeInstallments,
  notes: 'Illustrative scheme record for the portfolio.'
};

const urdPurchase = {
  purchaseNumber: 'URD-DEMO-2026-001',
  purchaseDate: new Date('2026-09-20T15:30:00+05:30'),
  customer,
  description: 'Old gold bangle',
  metal: 'GOLD',
  purity: '22K',
  grossWeight: 8.300,
  netWeight: 7.700,
  ratePerGram: 7200,
  totalAmount: 55440,
  paid: 55440,
  saleOffset: 0,
  paymentMethod: 'BANK_TRANSFER',
  notes: 'Illustrative old-gold purchase for the portfolio.',
  cancelledAt: null,
  sale: null,
  items: [{
    description: 'Old gold bangle',
    metal: 'GOLD',
    purity: '22K',
    grossWeight: 8.300,
    netWeight: 7.700,
    ratePerGram: 7200,
    totalAmount: 55440
  }]
};

const pledgeLoan = {
  pledgeNumber: 'PL-DEMO-2026-001',
  pledgeDate: new Date('2026-09-20T16:00:00+05:30'),
  dueDate: '2027-03-20',
  customer,
  itemDescription: 'Gold necklace',
  metal: 'GOLD',
  purity: '22K',
  quantity: 1,
  grossWeight: 12.400,
  stoneWeight: 0.400,
  netWeight: 12.000,
  valuationAmount: 88200,
  principalAmount: 65000,
  principalRepaid: 15000,
  interestReceived: 1950,
  monthlyInterestRate: 2,
  status: 'ACTIVE',
  cashbookEntries: [{ paymentMethod: 'CASH' }],
  payments: [
    { paymentDate: new Date('2026-10-20T12:00:00+05:30'), paymentMethod: 'UPI', principalAmount: 10000, interestAmount: 1200 },
    { paymentDate: new Date('2026-11-20T12:00:00+05:30'), paymentMethod: 'CASH', principalAmount: 5000, interestAmount: 750 }
  ]
};

const excelPayload = {
  title: 'Kusum Jewellers - Sales invoices',
  subtitle: 'Portfolio sample register | 20-Sep-26 to 20-Sep-26',
  filename: 'Kusum-ERP-demo-sales-register.xlsx',
  shopName: businessSettings.shopName,
  metadata: {
    shopName: businessSettings.shopName,
    address: businessSettings.shopAddress,
    gstin: businessSettings.gstin,
    primaryPhone: businessSettings.primaryPhone,
    secondaryPhone: businessSettings.secondaryPhone,
    creator: 'Kusum Jewelers ERP portfolio demo'
  },
  columns: [
    { key: 'saleDate', label: 'Date', type: 'date', width: 14 },
    { key: 'invoiceNumber', label: 'Doc-no', type: 'identifier', width: 22 },
    { key: 'customerName', label: 'Customer', type: 'text', width: 28 },
    { key: 'grossWeight', label: 'Gr-wt', type: 'weight', width: 13 },
    { key: 'netWeight', label: 'Net-wt', type: 'weight', width: 13 },
    { key: 'taxableAmount', label: 'Taxable-amt', type: 'currency', width: 18 },
    { key: 'cgstAmount', label: 'CGST', type: 'currency', width: 16 },
    { key: 'sgstAmount', label: 'SGST', type: 'currency', width: 16 },
    { key: 'total', label: 'Total', type: 'currency', width: 18 },
    { key: 'paymentMethod', label: 'Payment', type: 'text', width: 16 }
  ],
  rows: [{
    saleDate: '2026-09-20',
    invoiceNumber: sale.invoiceNumber,
    customerName: customer.name,
    grossWeight: 25.200,
    netWeight: 22.850,
    taxableAmount: sale.subtotal,
    cgstAmount: sale.gstAmount / 2,
    sgstAmount: sale.gstAmount / 2,
    total: sale.total,
    paymentMethod: 'Cash + UPI'
  }]
};

module.exports = { customerOrder, enrollment, schemeInstallments, urdPurchase, pledgeLoan, excelPayload };
