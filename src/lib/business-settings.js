const DEFAULT_BUSINESS_SETTINGS = Object.freeze({
  id: 1,
  shopName: 'Kusum Jewellers',
  shopAddress: 'Vithal Bhagwan Complex, Beed Road, Majalgaon, Maharashtra, 431131',
  gstin: '27ABDFK0780F1ZG',
  panNumber: '',
  primaryPhone: '9970737444',
  secondaryPhone: '9404023751',
  facebookUrl: 'https://www.facebook.com/share/1CXw42f8Fb/',
  instagramUrl: 'https://www.instagram.com/kusum_jewellers_majalgaon7?igsi=MTFoaTAxYjM0Njk3',
  invoicePrefix: 'SB',
  financialYearStartMonth: 4,
  defaultGstRate: 3,
  defaultHsnCode: '7113',
  labelShopName: 'KUSUM JEWELLERS',
  labelWidthMm: 81,
  labelHeightMm: 12,
  labelGapMm: 3,
  labelSpeed: 2,
  labelDensity: 10,
  signatureImage: null,
  signatureMimeType: null,
  whatsappAutoSendInvoices: false
});

let cached = null;
let cachedAt = 0;

function plainSettings(record) {
  if (!record) return { ...DEFAULT_BUSINESS_SETTINGS };
  return {
    ...DEFAULT_BUSINESS_SETTINGS,
    ...record,
    financialYearStartMonth: Number(record.financialYearStartMonth),
    defaultGstRate: Number(record.defaultGstRate),
    labelWidthMm: Number(record.labelWidthMm),
    labelHeightMm: Number(record.labelHeightMm),
    labelGapMm: Number(record.labelGapMm),
    labelSpeed: Number(record.labelSpeed),
    labelDensity: Number(record.labelDensity)
  };
}

async function getBusinessSettings(db, { fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < 30000) return cached;
  if (!db?.businessSettings) return { ...DEFAULT_BUSINESS_SETTINGS };
  const record = await db.businessSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 }
  });
  cached = plainSettings(record);
  cachedAt = Date.now();
  return cached;
}

function clearBusinessSettingsCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { DEFAULT_BUSINESS_SETTINGS, getBusinessSettings, clearBusinessSettingsCache, plainSettings };
