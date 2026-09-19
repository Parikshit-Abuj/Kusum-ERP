const businessSettings = {
  shopName: 'Kusum Jewellers',
  shopAddress: 'Vithal Bhagwan Complex, Beed Road, Majalgaon, Maharashtra, 431131',
  gstin: '27ABDFK0780F1ZG',
  panNumber: '',
  primaryPhone: '9970737444',
  secondaryPhone: '9404023751',
  defaultGstRate: 3,
  signatureImage: null,
  signatureMimeType: null
};

const sale = {
  id: 900001,
  invoiceNumber: 'SB-DEMO-2026-001',
  saleDate: new Date('2026-09-20T12:30:00+05:30'),
  customerPan: '',
  customer: {
    name: 'Parikshit Abuj',
    phone: '9529138839',
    address: 'Pune',
    panNumber: null
  },
  subtotal: 42067.20,
  discount: 0,
  gstRate: 3,
  gstAmount: 1262.02,
  total: 43329.22,
  paid: 43329.22,
  balance: 0,
  cashPaid: 20000,
  upiPaid: 23329.22,
  cardPaid: 0,
  bankPaid: 0,
  paymentMethod: 'MIXED',
  notes: 'Portfolio demonstration invoice - rates are illustrative.',
  urdOffset: 0,
  urdPurchase: null,
  items: [
    {
      id: 900011,
      productName: '22K Gold Ring',
      productBarcode: 'DEMO-GOLD-22K-001',
      productSku: 'DEMO-GR-22K',
      productMetal: 'GOLD',
      productPurity: '22K',
      grossWeight: 5.200,
      netWeight: 4.850,
      weight: 4.850,
      quantity: 1,
      metalRate: 7350,
      makingChargeValue: 12,
      makingChargeType: 'PERCENTAGE',
      taxableAmount: 39925.20,
      lineTotal: 39925.20,
      huidCode: 'HUID-DEMO-001',
      hsnCode: '7113',
      product: {
        name: '22K Gold Ring',
        barcode: 'DEMO-GOLD-22K-001',
        category: 'Rings',
        metal: 'GOLD',
        purity: '22K',
        grossWeight: 5.200,
        netWeight: 4.850
      }
    },
    {
      id: 900012,
      productName: 'Silver Chain',
      productBarcode: 'DEMO-SILVER-001',
      productSku: 'DEMO-SC-925',
      productMetal: 'SILVER',
      productPurity: '925',
      grossWeight: 20.000,
      netWeight: 18.000,
      weight: 18.000,
      quantity: 1,
      metalRate: 94,
      makingChargeValue: 25,
      makingChargeType: 'PER_GRAM',
      taxableAmount: 2142.00,
      lineTotal: 2142.00,
      huidCode: '',
      hsnCode: '7113',
      product: {
        name: 'Silver Chain',
        barcode: 'DEMO-SILVER-001',
        category: 'Chains',
        metal: 'SILVER',
        purity: '925',
        grossWeight: 20.000,
        netWeight: 18.000
      }
    }
  ]
};

module.exports = { businessSettings, sale };
