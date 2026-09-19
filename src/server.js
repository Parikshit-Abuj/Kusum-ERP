const os = require('os');
const dotenv = require('dotenv');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const { defaultShopDataDirectory } = require('./lib/app-paths');
const appRoot = path.join(__dirname, '..');
const shopDataDirectory = defaultShopDataDirectory();
const configPath = process.env.KUSUM_CONFIG_PATH
  || (process.env.KUSUM_APP_DATA ? path.join(shopDataDirectory, '.env') : path.join(appRoot, '.env'));
dotenv.config({ path: configPath });
// Keep one unpredictable signing secret for the whole desktop process. Fresh
// setup persists this exact value so restarting the ERP does not invalidate all
// active sessions merely because setup occurred after the server booted.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('base64url');
const { createPrisma } = require('./lib/prisma');
const { writeUrdPurchaseInvoice } = require('./lib/urd-invoice-pdf');
const { writePledgeLoanInvoice } = require('./lib/pledge-invoice-pdf');
const { writeSaleInvoice } = require('./lib/sale-invoice-pdf');
const { writeCustomerOrderInvoice } = require('./lib/customer-order-pdf');
const { writeSchemeInstallmentReceipt, writeSchemeConsolidatedReceipt, paymentParts } = require('./lib/scheme-payment-pdf');
const { buildTsplJob, checkTcpPrinter, sendTsplToPrinter } = require('./lib/tspl-labels');
const printerBackend = process.platform === 'win32'
  ? require('./lib/windows-printers')
  : require('./lib/unix-printers');
const { resolveTscPrinter, cachedTscPrinterStatus } = printerBackend;
const { provisionShopDatabase, enableNetworkSharing, updatePrinterConfiguration, updateLoginConfiguration, parseDatabaseConnection, isLocalHost, runBundledMigrations, verifyClientConnection } = require('./lib/shop-provisioning');
const { buildExcelExport } = require('./lib/excel-export');
const { RESOURCE_LIST, resourceFor, parseDateRange, getExportPayload, getSchemePlanExportPayload, archiveData } = require('./lib/data-lifecycle');
const { paymentMethodFromComponents, reverseAndDeleteCashbookEntry, deleteSettledUrdPurchase, cancelUrdPurchase, cancelSale } = require('./lib/accounting-reversal');
const { urdSettlement } = require('./lib/urd-settlement');
const { productSearchClauses } = require('./lib/product-search-filters');
const { normalizeTopSellingFilters, countTopSellingItems, listTopSellingItems, summarizeTopSellingItems } = require('./lib/top-selling-items');
const { number, roundToNearestRupee, asArray, dateInput, startOfToday, dateTimeFromInput, localDateTimeRange, money, grams, formatDateDisplay, nextDocumentNumber, nextBatchDocumentNumber, metalRateFromDailyRate, makingAmount, titleCase } = require('./lib/helpers');
const { nextBarcode } = require('./lib/barcode-sequence');
const { upsertItemName } = require('./lib/item-names');
const { createInstallmentSchedule, schemeEndDate, isFullInstallmentPayment } = require('./lib/scheme-schedule');
const { hasConfiguredPassword, passwordMatchesEnvironment, secureTextMatch, usesKnownDefaultPassword } = require('./lib/auth-security');
const { PrismaSessionStore } = require('./lib/mysql-session-store');
const { DEFAULT_BUSINESS_SETTINGS, getBusinessSettings, clearBusinessSettingsCache } = require('./lib/business-settings');
const { getWhatsAppStatus, queueSaleInvoiceMessage, startWhatsAppWorker, verifyWebhookSignature, handleWebhook } = require('./lib/whatsapp');
let prisma = createPrisma();
let databaseHealth = { checkedAt: 0, error: null };
const app = express();
const port = Number(process.env.PORT || 3000);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(expressLayouts);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({
  limit: '256kb',
  verify: (req, res, buffer) => {
    if (req.path === '/webhooks/whatsapp') req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
if (process.env.NODE_ENV === 'development') app.use(require('morgan')('dev'));
app.use(session({
  name: 'kusum.erp.sid',
  secret: process.env.SESSION_SECRET,
  store: new PrismaSessionStore(() => prisma, () => !shopSetupRequired()),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
}));

app.locals.money = money;
app.locals.grams = grams;
app.locals.dateInput = dateInput;
app.locals.formatDate = formatDateDisplay;
app.locals.formatDateDisplay = formatDateDisplay;
app.locals.businessSettings = DEFAULT_BUSINESS_SETTINGS;

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.money = money;
  res.locals.grams = grams;
  res.locals.dateInput = dateInput;
  res.locals.formatDate = formatDateDisplay;
  res.locals.formatDateDisplay = formatDateDisplay;
  res.locals.message = req.query.message || null;
  res.locals.error = req.query.error || null;
  res.locals.loggedInUser = req.session?.username || null;
  next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

function redirectWith(res, route, type, message) {
  const separator = route.includes('?') ? '&' : '?';
  res.redirect(`${route}${separator}${type}=${encodeURIComponent(message)}`);
}

function excelBusinessMetadata(settings = {}) {
  const shopName = String(settings.shopName || '').trim();
  return {
    shopName,
    address: String(settings.shopAddress || '').trim(),
    gstin: String(settings.gstin || '').trim(),
    panNumber: String(settings.panNumber || '').trim(),
    primaryPhone: String(settings.primaryPhone || '').trim(),
    secondaryPhone: String(settings.secondaryPhone || '').trim(),
    creator: shopName,
    lastModifiedBy: shopName
  };
}

function schemePlanReturnPath(value, planId) {
  const fallback = `/schemes/plans/${planId}`;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const candidate = new URL(value, 'http://127.0.0.1');
    // A passbook can return only to its own plan page. This preserves the
    // selected page/filter/row without turning a query parameter into an
    // external redirect target.
    if (candidate.origin !== 'http://127.0.0.1' || candidate.pathname !== fallback) return fallback;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch (_) {
    return fallback;
  }
}

// The session store is MySQL-backed. Explicitly save a regenerated session
// before redirecting, otherwise a very fast next request can arrive before
// the new cashier login has reached MySQL.
function regenerateAndSaveSession(req, res, values, destination, failureTitle) {
  req.session.regenerate((regenerateError) => {
    if (regenerateError) {
      return res.status(500).render('error', { title: failureTitle, detail: regenerateError.message });
    }
    Object.assign(req.session, values);
    return req.session.save((saveError) => {
      if (saveError) {
        return res.status(500).render('error', { title: failureTitle, detail: saveError.message || String(saveError) });
      }
      return res.redirect(destination);
    });
  });
}

function paginationFor(req, totalItems, requestedPage, pageSize, pageParam = 'page') {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(number(requestedPage, 1))));
  const pageUrl = (targetPage) => {
    const params = new URLSearchParams();
    Object.entries(req.query || {}).forEach(([key, value]) => {
      if (key === pageParam || value === undefined || value === null || value === '') return;
      params.set(key, String(Array.isArray(value) ? value[0] : value));
    });
    params.set(pageParam, String(targetPage));
    return `${req.path}?${params.toString()}`;
  };
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    fromItem: totalItems ? (page - 1) * pageSize + 1 : 0,
    toItem: Math.min(totalItems, page * pageSize),
    previousUrl: page > 1 ? pageUrl(page - 1) : null,
    nextUrl: page < totalPages ? pageUrl(page + 1) : null
  };
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase();
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function requireLoopback(req, res, next) {
  if (isLoopbackRequest(req)) return next();
  return res.status(403).send('ERP setup and connection repair are available only on this PC.');
}

function labelRequests(body) {
  return [...new Set(asArray(body.productId).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    .map((id) => ({
      id,
      copies: 1
    }));
}

function saleRows(body) {
  const productIds = asArray(body.productId);
  const saleItemIds = asArray(body.saleItemId);
  const barcodes = asArray(body.barcode);
  const weights = asArray(body.weight);
  const metalRates = asArray(body.metalRate);
  const makingTypes = asArray(body.makingChargeType);
  const makingValues = asArray(body.makingChargeValue);
  const taxableAmounts = asArray(body.taxableAmount);
  const purities = asArray(body.purity);
  const hsnCodes = asArray(body.hsnCode);
  const huidCodes = asArray(body.huidCode);
  const count = Math.max(productIds.length, saleItemIds.length, barcodes.length);
  const rows = [];
  for (let index = 0; index < count; index++) {
    const productId = Number(productIds[index]) || null;
    const saleItemId = Number(saleItemIds[index]) || null;
    if (!productId && !saleItemId) continue;
    rows.push({
      productId: productId > 0 ? productId : null,
      saleItemId: saleItemId > 0 ? saleItemId : null,
      barcode: String(barcodes[index] || '').trim().toUpperCase(),
      // Each inventory row is one physical jewellery piece and therefore one
      // barcode. Quantity is deliberately fixed at one server-side; a modified
      // browser form must never turn a single barcode into several sold pieces.
      quantity: 1,
      weight: weights[index] === undefined || weights[index] === '' ? null : number(weights[index]),
      metalRate: number(metalRates[index]),
      makingChargeType: ['FIXED', 'PER_GRAM', 'PERCENTAGE'].includes(makingTypes[index]) ? makingTypes[index] : null,
      makingChargeValue: makingValues[index] === undefined || makingValues[index] === '' ? null : number(makingValues[index]),
      taxableAmount: taxableAmounts[index] === '' || taxableAmounts[index] === undefined ? null : Math.max(0, number(taxableAmounts[index])),
      purity: purities[index] === undefined ? null : String(purities[index] || '').trim().toUpperCase() || null,
      hsnCode: (hsnCodes[index] || '').trim() || null,
      huidCode: (huidCodes[index] || '').trim() || null
    });
  }
  return rows;
}

function urdRows(body) {
  const descriptions = asArray(body.urdItemDescription);
  const metals = asArray(body.urdItemMetal);
  const purities = asArray(body.urdItemPurity);
  const grossWeights = asArray(body.urdItemGrossWeight);
  const netWeights = asArray(body.urdItemNetWeight);
  const rates = asArray(body.urdItemRatePerGram);
  const totals = asArray(body.urdItemTotalAmount);
  const count = Math.max(descriptions.length, metals.length, purities.length, grossWeights.length, netWeights.length, rates.length, totals.length);

  // Keep accepting the original one-item form while new forms submit arrays.
  // This lets an older browser tab finish safely after the multi-item release.
  if (!count && (body.description || body.metal || body.purity || body.grossWeight || body.netWeight || body.ratePerGram || body.totalAmount)) {
    return [{
      description: (String(body.description || '').trim().toUpperCase() || 'OLD JEWELLERY ITEM').slice(0, 255),
      metal: ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(String(body.metal || '').toUpperCase()) ? String(body.metal).toUpperCase() : 'GOLD',
      purity: String(body.purity || '').trim().toUpperCase() || null,
      grossWeight: number(body.grossWeight),
      netWeight: number(body.netWeight),
      ratePerGram: roundedMoney(number(body.ratePerGram)),
      totalAmount: roundedMoney(number(body.totalAmount))
    }];
  }

  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const metal = String(metals[index] || 'GOLD').trim().toUpperCase();
    rows.push({
      description: (String(descriptions[index] || '').trim().toUpperCase() || 'OLD JEWELLERY ITEM').slice(0, 255),
      metal: ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(metal) ? metal : 'GOLD',
      purity: String(purities[index] || '').trim().toUpperCase() || null,
      grossWeight: number(grossWeights[index]),
      netWeight: number(netWeights[index]),
      ratePerGram: roundedMoney(number(rates[index])),
      totalAmount: roundedMoney(number(totals[index]))
    });
  }
  return rows;
}

async function getRateForDate(db, rateDate = dateInput()) {
  // Keep rate lookups on the same strict YYYY-MM-DD contract as every other
  // financial date. Without this normalization a crafted API value such as
  // "2026-99-99" could be stored/used as a lexicographic rate key.
  const normalizedRateDate = dateInput(dateTimeFromInput(rateDate || dateInput()));
  const exact = await db.dailyRate.findUnique({ where: { rateDate: normalizedRateDate } });
  if (exact) return { rate: exact, sourceDate: normalizedRateDate, isFallback: false };
  const latest = await db.dailyRate.findFirst({ where: { rateDate: { lte: normalizedRateDate } }, orderBy: { rateDate: 'desc' } });
  return { rate: latest, sourceDate: latest?.rateDate || null, isFallback: Boolean(latest) };
}

function chunkArray(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size));
  return chunks;
}

function salePaymentBreakdown(body) {
  const selectedMethod = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'MIXED'].includes(body.paymentMethod)
    ? body.paymentMethod
    : 'CASH';
  if (selectedMethod !== 'MIXED') {
    // CREDIT is not a money movement. Ignore a stale or manipulated paid
    // value so the sale and cashbook can never disagree.
    const paid = selectedMethod === 'CREDIT' ? 0 : Math.max(0, roundedMoney(number(body.paid)));
    return {
      paid,
      cashPaid: selectedMethod === 'CASH' ? paid : 0,
      upiPaid: selectedMethod === 'UPI' ? paid : 0,
      cardPaid: selectedMethod === 'CARD' ? paid : 0,
      bankPaid: selectedMethod === 'BANK_TRANSFER' ? paid : 0,
      paymentMethod: paid > 0 ? selectedMethod : 'CREDIT',
      cashbookPayments: paid > 0 ? [{ method: selectedMethod, amount: paid }] : []
    };
  }
  const cashPaid = Math.max(0, roundedMoney(number(body.cashPaid)));
  const upiPaid = Math.max(0, roundedMoney(number(body.upiPaid)));
  const cardPaid = Math.max(0, roundedMoney(number(body.cardPaid)));
  const bankPaid = Math.max(0, roundedMoney(number(body.bankPaid)));
  const cashbookPayments = [];
  if (cashPaid > 0) {
    cashbookPayments.push({ method: 'CASH', amount: cashPaid });
  }
  if (upiPaid > 0) {
    cashbookPayments.push({ method: 'UPI', amount: upiPaid });
  }
  if (cardPaid > 0) {
    cashbookPayments.push({ method: 'CARD', amount: cardPaid });
  }
  if (bankPaid > 0) {
    cashbookPayments.push({ method: 'BANK_TRANSFER', amount: bankPaid });
  }
  const components = { CASH: cashPaid, UPI: upiPaid, CARD: cardPaid, BANK_TRANSFER: bankPaid };
  const paid = roundedMoney(cashPaid + upiPaid + cardPaid + bankPaid);
  return {
    paid,
    cashPaid,
    upiPaid,
    cardPaid,
    bankPaid,
    paymentMethod: paymentMethodFromComponents(components, paid),
    cashbookPayments
  };
}

function schemePaymentBreakdown(body) {
  // Scheme screens always submit the four receipt boxes. Keep support for the
  // earlier single-method form too, so a bookmarked or interrupted old page
  // cannot create an invalid payment after the ERP is upgraded.
  const componentKeys = ['cashPaid', 'upiPaid', 'cardPaid', 'bankPaid'];
  const usesSplitFields = componentKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (usesSplitFields) return salePaymentBreakdown({ ...body, paymentMethod: 'MIXED' });
  return salePaymentBreakdown({ ...body, paid: body.amount });
}

function receiptMethodAmounts(paymentMethod, amount) {
  const paymentData = {};
  if (paymentMethod === 'CASH') paymentData.cashPaid = { increment: amount };
  if (paymentMethod === 'UPI') paymentData.upiPaid = { increment: amount };
  if (paymentMethod === 'CARD') paymentData.cardPaid = { increment: amount };
  if (paymentMethod === 'BANK_TRANSFER') paymentData.bankPaid = { increment: amount };
  return paymentData;
}

const RECEIPT_PAYMENT_METHODS = new Set(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER']);

function receiptPaymentMethod(value) {
  const method = String(value || 'CASH').toUpperCase();
  if (!RECEIPT_PAYMENT_METHODS.has(method)) {
    throw new Error('Choose Cash, UPI, Card or Bank Transfer as the payment method.');
  }
  return method;
}

function roundedMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function stockMovementSnapshot(product, type, quantity, note, overrides = {}) {
  return {
    saleId: overrides.saleId ?? null,
    productId: product.id,
    productBarcode: product.barcode || null,
    productSku: product.sku || '',
    productName: product.name || '',
    productMetal: product.metal || null,
    productPurity: product.purity || null,
    // Billing permits a final negotiated net weight. Keep the immutable stock
    // movement snapshot aligned with the SaleItem/PDF rather than silently
    // recording the older inventory weight.
    netWeight: overrides.netWeight ?? product.netWeight ?? 0,
    type,
    quantity,
    note
  };
}

// Keep movement snapshots in sync while an item is still present in
// inventory. Once the Product row is removed, these saved fields are the
// historical source used by the movement register and its exports.
async function syncStockMovementSnapshot(tx, product) {
  if (!product?.id) return;
  await tx.stockMovement.updateMany({
    where: { productId: product.id },
    data: {
      productBarcode: product.barcode || null,
      productSku: product.sku || '',
      productName: product.name || '',
      productMetal: product.metal || null,
      productPurity: product.purity || null,
      netWeight: product.netWeight ?? 0
    }
  });
}

function expectsJson(req) {
  return req.path.startsWith('/api/')
    || Boolean(req.xhr)
    || String(req.headers.accept || '').includes('application/json');
}

function generatedReference(prefix, value = new Date()) {
  const dateKey = dateInput(value).replaceAll('-', '');
  const nonce = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${prefix}-${dateKey}-${nonce}`;
}

async function lockCustomerForLedger(tx, customerId) {
  if (!Number.isInteger(customerId) || customerId <= 0) throw new Error('Select a valid customer.');
  // All ledger mutations for one customer take the same row lock. This keeps
  // receipts correct when two LAN clients submit at nearly the same time.
  const rows = await tx.$queryRaw`SELECT id FROM \`Customer\` WHERE id = ${customerId} FOR UPDATE`;
  if (!rows.length) throw new Error('The selected customer no longer exists.');
}

async function allocateCustomerPayment(tx, { customerId, amount, paymentMethod, reference, note, cashbookEntryId = null, entryDate = dateInput() }) {
  await lockCustomerForLedger(tx, customerId);

  const ledgerTotal = await tx.customerLedger.aggregate({
    where: { customerId },
    _sum: { amount: true }
  });
  const outstanding = Math.max(0, roundedMoney(ledgerTotal._sum.amount || 0));
  if (outstanding <= 0) throw new Error('This customer has no outstanding credit or loan.');
  if (amount > outstanding) {
    throw new Error(`Payment is greater than the outstanding amount of ${money(outstanding)}.`);
  }

  let remaining = roundedMoney(amount);
  let after = null;
  // Process oldest invoices in bounded pages so a large customer history does
  // not load every open sale into memory in one request.
  while (remaining > 0) {
    const where = {
      customerId, cancelledAt: null, balance: { gt: 0 },
      ...(after ? { OR: [{ saleDate: { gt: after.saleDate } }, { saleDate: after.saleDate, id: { gt: after.id } }] } : {})
    };
    const openSales = await tx.sale.findMany({
      where,
      select: { id: true, invoiceNumber: true, saleDate: true, balance: true, paid: true, paymentMethod: true },
      orderBy: [{ saleDate: 'asc' }, { id: 'asc' }], take: 200
    });
    if (!openSales.length) break;
    for (const sale of openSales) {
      if (remaining <= 0) break;
      const currentBalance = Number(sale.balance);
      const currentPaid = Number(sale.paid);
      const allocation = roundedMoney(Math.min(remaining, currentBalance));
      const nextPaymentMethod = currentPaid <= 0 || sale.paymentMethod === 'CREDIT'
        ? paymentMethod
        : sale.paymentMethod === paymentMethod ? sale.paymentMethod : 'MIXED';
      await tx.sale.update({
        where: { id: sale.id },
        data: {
          paid: roundedMoney(currentPaid + allocation),
          balance: Math.max(0, roundedMoney(currentBalance - allocation)),
          paymentMethod: nextPaymentMethod,
          ...receiptMethodAmounts(paymentMethod, allocation)
        }
      });
      await tx.customerLedger.create({
        data: {
          customerId,
          saleId: sale.id,
          type: 'PAYMENT_RECEIVED',
          amount: -allocation,
          entryDate,
          paymentMethod,
          cashbookEntryId,
          reference,
          note: note || `Payment received against ${sale.invoiceNumber}`
        }
      });
      remaining = roundedMoney(remaining - allocation);
    }
    const last = openSales[openSales.length - 1];
    after = { saleDate: last.saleDate, id: last.id };
  }

  // Any amount left after invoices pays down a manual loan/adjustment. Without
  // this entry the cashbook would show money received while the ledger stayed due.
  if (remaining > 0) {
    await tx.customerLedger.create({
      data: {
        customerId,
        type: 'PAYMENT_RECEIVED',
        amount: -remaining,
        entryDate,
        paymentMethod,
        cashbookEntryId,
        reference,
        note: note || 'Payment received against customer loan / adjustment'
      }
    });
  }

  return { outstanding, remainingAfterInvoices: remaining };
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return digits;
}

function validCustomerPhone(phone) {
  return /^\d{10,15}$/.test(phone);
}

async function resolveBillingCustomer(tx, body) {
  const phone = normalizePhone(body.customerPhone);
  if (phone && !validCustomerPhone(phone)) throw new Error('Enter a valid customer mobile number (10 to 15 digits), or leave it blank.');
  const whatsappOptIn = body.whatsappOptIn === 'on';
  const panNumber = String(body.customerPan || body.existingCustomerPan || '').trim().toUpperCase() || null;
  // A blank mobile number is valid for a walk-in customer. Never look up an
  // empty value: otherwise unrelated walk-in customers could be merged.
  const existing = phone ? await tx.customer.findUnique({ where: { phone } }) : null;
  if (existing) {
    if (panNumber && existing.panNumber !== panNumber) {
      await tx.customer.update({ where: { id: existing.id }, data: { panNumber } });
      existing.panNumber = panNumber;
    }
    if (whatsappOptIn && !existing.whatsappOptIn) {
      await tx.customer.update({ where: { id: existing.id }, data: { whatsappOptIn: true, whatsappOptInAt: new Date() } });
      existing.whatsappOptIn = true;
      existing.whatsappOptInAt = new Date();
    }
    return existing;
  }
  // Billing customer details are stored in a consistent print-ready form even
  // when a request is submitted without the browser's title-case formatting.
  const name = titleCase(body.customerName);
  if (!name) throw new Error('Enter the customer name to create their customer ledger.');
  return tx.customer.create({ data: {
    phone: phone || null, name, email: String(body.customerEmail || '').trim() || null,
    address: titleCase(body.customerAddress) || null,
    panNumber,
    whatsappOptIn,
    whatsappOptInAt: whatsappOptIn ? new Date() : null
  } });
}

function shopSetupRequired() {
  return !process.env.DATABASE_URL || !process.env.AUTH_USERNAME || !hasConfiguredPassword(process.env);
}

async function reloadPrismaClient() {
  const previous = prisma;
  prisma = createPrisma();
  clearBusinessSettingsCache();
  databaseHealth = { checkedAt: 0, error: null };
  await previous.$disconnect().catch(() => {});
}

async function databaseConnectionError(force = false) {
  if (shopSetupRequired()) return null;
  const now = Date.now();
  if (!force && now - databaseHealth.checkedAt < 5000) return databaseHealth.error;
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    databaseHealth = { checkedAt: now, error: null };
    return null;
  } catch (error) {
    databaseHealth = { checkedAt: now, error };
    return error;
  }
}

function nativePrinterMode() {
  return process.platform === 'win32' ? 'WINDOWS' : 'CUPS';
}

function normalisePrinterMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  if (mode === 'TCP') return 'TCP';
  if (mode === 'WINDOWS' && process.platform === 'win32') return 'WINDOWS';
  if (mode === 'CUPS' && process.platform !== 'win32') return 'CUPS';
  return nativePrinterMode();
}

function printerPlatformName() {
  return process.platform === 'win32' ? 'windows' : 'cups';
}

function setupDefaults() {
  const defaults = {
    setupMode: 'SERVER', mysqlHost: 'localhost', mysqlPort: '3306', databaseName: 'kusum_erp',
    databaseUser: 'kusum_erp_shared', appUsername: process.env.AUTH_USERNAME || 'kusum',
    printerMode: normalisePrinterMode(process.env.TSC_PRINTER_MODE),
    printerName: process.env.TSC_PRINTER_NAME || (process.platform === 'win32' ? 'TSC TTP-244 Pro' : ''),
    printerHost: process.env.TSC_PRINTER_HOST || '',
    printerPort: process.env.TSC_PRINTER_PORT || '9100'
  };
  if (!process.env.DATABASE_URL) return defaults;
  try {
    const connection = parseDatabaseConnection(process.env.DATABASE_URL);
    const url = new URL(process.env.DATABASE_URL);
    return {
      ...defaults,
      setupMode: process.env.KUSUM_DEPLOYMENT_MODE || (isLocalHost(connection.host) ? 'SERVER' : 'CLIENT'),
      mysqlHost: connection.host,
      mysqlPort: String(connection.port),
      databaseName: connection.database,
      databaseUser: decodeURIComponent(url.username) || defaults.databaseUser
    };
  } catch (_) {
    return defaults;
  }
}

function configuredLabelPrinter() {
  const mode = normalisePrinterMode(process.env.TSC_PRINTER_MODE);
  return {
    mode,
    name: String(process.env.TSC_PRINTER_NAME || (process.platform === 'win32' ? 'TSC TTP-244 Pro' : '')).trim(),
    host: String(process.env.TSC_PRINTER_HOST || '').trim(),
    port: Number(process.env.TSC_PRINTER_PORT || 9100)
  };
}

function printerNeedsQueueName(printer) {
  return printer.mode === 'WINDOWS' || printer.mode === 'CUPS';
}

function printerDisplayName(printer) {
  if (printer.mode === 'TCP') return `TCP ${printer.host}:${printer.port}`;
  if (printer.mode === 'CUPS') return `CUPS ${printer.name || 'printer queue'}`;
  return printer.name || 'Windows printer queue';
}

function printerSavedMessage(values) {
  if (values.TSC_PRINTER_MODE === 'TCP') {
    return `Direct TCP printer saved: ${values.TSC_PRINTER_HOST}:${values.TSC_PRINTER_PORT}. Use Test TSC to verify the printer.`;
  }
  if (values.TSC_PRINTER_MODE === 'CUPS') {
    return `CUPS printer saved: ${values.TSC_PRINTER_NAME}. Use Test TSC to verify the printer.`;
  }
  return `Windows printer saved: ${values.TSC_PRINTER_NAME}. Use Test TSC to verify the printer.`;
}

async function resolveLabelPrinter(force = false) {
  const printer = configuredLabelPrinter();
  if (printer.mode === 'TCP') {
    if (!force) {
      return {
        available: null,
        name: `TCP ${printer.host || 'printer IP'}:${printer.port || 9100}`,
        message: 'Direct TCP printer is configured. No automatic connection check is run; printing sends native TSPL directly to the printer.',
        checked: false
      };
    }
    return checkTcpPrinter(printer.host, printer.port);
  }
  return force ? resolveTscPrinter(printer.name, true) : cachedTscPrinterStatus(printer.name);
}

function renderSetup(res, { repair = false, error = null } = {}) {
  return res.render('setup', {
    layout: false,
    title: repair ? 'Repair ERP connection' : 'Shop setup',
    repair,
    error,
    defaults: setupDefaults(),
    printerPlatform: printerPlatformName()
  });
}

function localNetworkAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === 'IPv4' && !address.internal)
    .map((address) => address.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

app.get('/setup', requireLoopback, (req, res) => {
  if (!shopSetupRequired()) return res.redirect('/login');
  renderSetup(res, { error: req.query.error || null });
});

app.post('/setup', requireLoopback, async (req, res) => {
  if (!shopSetupRequired()) return res.redirect('/login');
  try {
    const values = await provisionShopDatabase({ appRoot, configPath, form: req.body });
    Object.assign(process.env, values);
    if (values.AUTH_PASSWORD_HASH) delete process.env.AUTH_PASSWORD;
    await reloadPrismaClient();
    res.redirect('/login?message=Shop setup is complete. Sign in to begin.');
  } catch (error) {
    redirectWith(res, '/setup', 'error', error.message || 'Could not set up the shop database.');
  }
});

app.get('/connection-repair', requireLoopback, (req, res) => {
  renderSetup(res, { repair: true, error: req.query.error || null });
});

app.post('/connection-repair', requireLoopback, async (req, res) => {
  try {
    const values = await provisionShopDatabase({ appRoot, configPath, form: req.body });
    Object.assign(process.env, values);
    if (values.AUTH_PASSWORD_HASH) delete process.env.AUTH_PASSWORD;
    await reloadPrismaClient();
    res.redirect('/login?message=ERP connection saved. Sign in to continue.');
  } catch (error) {
    redirectWith(res, '/connection-repair', 'error', error.message || 'Could not save the ERP connection.');
  }
});

app.get('/login', async (req, res) => {
  if (shopSetupRequired()) return res.redirect('/setup');
  if (await databaseConnectionError()) return redirectWith(res, '/connection-repair', 'error', 'The saved database connection is unavailable. Enter the current database details below.');
  if (req.session?.authenticated) return res.redirect('/');
  res.render('auth/login', { layout: false, title: 'Sign in', businessSettings: await getBusinessSettings(prisma), error: req.query.error || null, message: req.query.message || null });
});

app.post('/login', async (req, res) => {
  if (shopSetupRequired()) return res.redirect('/setup');
  if (await databaseConnectionError(true)) return redirectWith(res, '/connection-repair', 'error', 'The saved database connection is unavailable. Enter the current database details below.');
  const enteredUsername = String(req.body.username || '').trim();
  const configuredUsername = String(process.env.AUTH_USERNAME || '').trim();
  const usernameOk = Boolean(enteredUsername) && Boolean(configuredUsername) && (
    secureTextMatch(enteredUsername, configuredUsername) ||
    secureTextMatch(enteredUsername.toLowerCase(), configuredUsername.toLowerCase())
  );
  const passwordOk = passwordMatchesEnvironment(req.body.password, process.env);
  if (!usernameOk || !passwordOk) return redirectWith(res, '/login', 'error', 'Incorrect username or password.');

  if (usesKnownDefaultPassword(process.env)) {
    return regenerateAndSaveSession(req, res, {
      pendingPasswordChange: true,
      username: process.env.AUTH_USERNAME
    }, '/change-password?message=Choose your own ERP password before continuing.', 'Sign-in failed');
  }

  // Transparently replace plaintext credentials from older releases after the
  // user has proved that password. No business data or database login changes.
  if (!process.env.AUTH_PASSWORD_HASH && process.env.NODE_ENV !== 'test') {
    try {
      const updated = updateLoginConfiguration({
        configPath,
        currentEnv: process.env,
        username: process.env.AUTH_USERNAME,
        password: req.body.password
      });
      Object.assign(process.env, updated);
      delete process.env.AUTH_PASSWORD;
    } catch (error) {
      return redirectWith(res, '/login', 'error', `Could not secure the saved ERP login: ${error.message}`);
    }
  }
  return regenerateAndSaveSession(req, res, {
    authenticated: true,
    username: process.env.AUTH_USERNAME
  }, '/welcome', 'Sign-in failed');
});

app.get('/change-password', (req, res) => {
  if (shopSetupRequired()) return res.redirect('/setup');
  if (!req.session?.authenticated && !req.session?.pendingPasswordChange) return res.redirect('/login');
  res.render('auth/change-password', {
    layout: false,
    title: 'Change ERP password',
    requireCurrentPassword: Boolean(req.session.authenticated),
    username: req.session.username || process.env.AUTH_USERNAME,
    error: req.query.error || null,
    message: req.query.message || null
  });
});

app.post('/change-password', async (req, res) => {
  if (shopSetupRequired()) return res.redirect('/setup');
  if (!req.session?.authenticated && !req.session?.pendingPasswordChange) return res.redirect('/login');
  try {
    if (req.session.authenticated && !passwordMatchesEnvironment(req.body.currentPassword, process.env)) {
      throw new Error('Current ERP password is incorrect.');
    }
    const newPassword = String(req.body.newPassword || '');
    const confirmation = String(req.body.confirmPassword || '');
    if (!newPassword) throw new Error('Choose a new ERP password.');
    if (newPassword !== confirmation) throw new Error('New password and confirmation do not match.');
    const configuredUser = String(process.env.AUTH_USERNAME || '').trim().toLowerCase();
    if (configuredUser === 'kusum' && secureTextMatch(newPassword, 'kusum@123')) {
      throw new Error('Choose your own password instead of the old default password.');
    }
    const updated = updateLoginConfiguration({
      configPath,
      currentEnv: process.env,
      username: process.env.AUTH_USERNAME,
      password: newPassword
    });
    Object.assign(process.env, updated);
    delete process.env.AUTH_PASSWORD;
    return regenerateAndSaveSession(req, res, {
      authenticated: true,
      username: process.env.AUTH_USERNAME
    }, '/welcome?message=ERP login password changed securely.', 'Password change failed');
  } catch (error) {
    redirectWith(res, '/change-password', 'error', error.message || 'Could not change the ERP password.');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// WhatsApp calls this public webhook before the authenticated ERP middleware.
// The verify token and optional app-secret signature keep it separate from
// the shop UI while delivery updates stay minimal in the outbox table.
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  if (mode === 'subscribe' && token && token === String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '')) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhooks/whatsapp', async (req, res, next) => {
  try {
    if (!verifyWebhookSignature(req, req.rawBody || Buffer.from(JSON.stringify(req.body || {})))) return res.sendStatus(403);
    await handleWebhook(prisma, req.body || {});
    return res.sendStatus(200);
  } catch (error) { return next(error); }
});

app.use(async (req, res, next) => {
  if (shopSetupRequired()) return res.redirect('/setup');
  if (!req.session?.authenticated) return res.redirect('/login');
  if (await databaseConnectionError()) {
    return redirectWith(res, '/connection-repair', 'error', 'The saved database connection is unavailable. Enter the current database details below.');
  }
  try {
    res.locals.businessSettings = await getBusinessSettings(prisma);
    res.locals.whatsappStatus = getWhatsAppStatus();
    return next();
  } catch (error) {
    return next(error);
  }
});

app.get('/welcome', (req, res) => {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  res.render('welcome', {
    title: 'Welcome',
    greeting,
    todayLabel: now.toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  });
});

function optionalText(value, maximumLength = 1000) {
  const result = String(value || '').trim();
  if (result.length > maximumLength) throw new Error(`A settings value is longer than ${maximumLength} characters.`);
  return result || null;
}

function boundedSetting(value, label, minimum, maximum, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function safeWebUrl(value, label) {
  const text = optionalText(value, 1000);
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch (_) { throw new Error(`${label} must be a complete https:// link.`); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error(`${label} must be a web link.`);
  return parsed.toString();
}

function signatureFromDataUrl(value) {
  const text = String(value || '');
  if (!text) return null;
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(text);
  if (!match) throw new Error('Choose a PNG or JPEG signature image.');
  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > 1024 * 1024) throw new Error('Signature image must be smaller than 1 MB.');
  const isPng = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  if ((match[1] === 'image/png' && !isPng) || (match[1] === 'image/jpeg' && !isJpeg)) {
    throw new Error('The selected signature file is not a valid PNG or JPEG image.');
  }
  return { signatureImage: image, signatureMimeType: match[1] };
}

app.get('/business-settings', requireLoopback, async (req, res, next) => {
  try {
    const [settings, blockedBilling] = await Promise.all([
      getBusinessSettings(prisma, { fresh: true }),
      prisma.whatsAppMessage.count({ where: { status: 'BLOCKED_BILLING' } })
    ]);
    const whatsappStatus = blockedBilling > 0
      ? { key: 'billing', label: 'Billing action needed', configured: getWhatsAppStatus().configured, detail: `${blockedBilling} sales invoice message${blockedBilling === 1 ? '' : 's'} paused after a provider billing error.` }
      : getWhatsAppStatus();
    res.render('business-settings', {
      title: 'Business settings',
      settings,
      whatsappStatus
    });
  } catch (error) { next(error); }
});

app.get('/business-settings/signature', async (req, res, next) => {
  try {
    const settings = await getBusinessSettings(prisma);
    if (!settings.signatureImage) return res.status(404).end();
    res.setHeader('Content-Type', settings.signatureMimeType || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.send(Buffer.from(settings.signatureImage));
  } catch (error) { next(error); }
});

app.post('/business-settings', requireLoopback, async (req, res) => {
  try {
    const shopName = optionalText(req.body.shopName, 255);
    if (!shopName) throw new Error('Shop name is required.');
    const invoicePrefix = String(req.body.invoicePrefix || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(invoicePrefix)) throw new Error('Invoice prefix must contain 1 to 8 English letters or numbers.');
    const signature = signatureFromDataUrl(req.body.signatureData);
    const removeSignature = req.body.removeSignature === 'on';
    // Printer and label controls now live in the dedicated Printer setup flow.
    // Preserve existing label values when older clients submit this form
    // without those fields, while still accepting them from older builds.
    const existingSettings = await getBusinessSettings(prisma, { fresh: true });
    const labelSetting = (value, fallback, label, minimum, maximum, integer = false) => (
      value === undefined || value === '' ? fallback : boundedSetting(value, label, minimum, maximum, integer)
    );
    const labelShopName = (optionalText(req.body.labelShopName, 80) || existingSettings.labelShopName || shopName).toUpperCase();
    const labelWidthMm = labelSetting(req.body.labelWidthMm, existingSettings.labelWidthMm, 'Label width', 20, 120);
    const labelHeightMm = labelSetting(req.body.labelHeightMm, existingSettings.labelHeightMm, 'Label height', 8, 100);
    const labelGapMm = labelSetting(req.body.labelGapMm, existingSettings.labelGapMm, 'Label gap', 0, 20);
    const labelSpeed = labelSetting(req.body.labelSpeed, existingSettings.labelSpeed, 'Label speed', 1, 6, true);
    const labelDensity = labelSetting(req.body.labelDensity, existingSettings.labelDensity, 'Label density', 0, 15, true);
    await prisma.businessSettings.upsert({
      where: { id: 1 },
      create: {
          id: 1,
          shopName,
          shopAddress: optionalText(req.body.shopAddress, 5000),
          gstin: optionalText(req.body.gstin, 20)?.toUpperCase() || null,
          panNumber: optionalText(req.body.panNumber, 20)?.toUpperCase() || null,
          primaryPhone: optionalText(req.body.primaryPhone, 30),
          secondaryPhone: optionalText(req.body.secondaryPhone, 30),
          facebookUrl: safeWebUrl(req.body.facebookUrl, 'Facebook link'),
          instagramUrl: safeWebUrl(req.body.instagramUrl, 'Instagram link'),
          invoicePrefix,
          financialYearStartMonth: boundedSetting(req.body.financialYearStartMonth, 'Financial-year start month', 1, 12, true),
          defaultGstRate: boundedSetting(req.body.defaultGstRate, 'Default GST rate', 0, 100),
          defaultHsnCode: optionalText(req.body.defaultHsnCode, 50)?.toUpperCase() || null,
          labelShopName,
          labelWidthMm,
          labelHeightMm,
          labelGapMm,
          labelSpeed,
          labelDensity,
          whatsappAutoSendInvoices: req.body.whatsappAutoSendInvoices === 'on',
          ...(signature || {})
      },
      update: {
          shopName,
          shopAddress: optionalText(req.body.shopAddress, 5000),
          gstin: optionalText(req.body.gstin, 20)?.toUpperCase() || null,
          panNumber: optionalText(req.body.panNumber, 20)?.toUpperCase() || null,
          primaryPhone: optionalText(req.body.primaryPhone, 30),
          secondaryPhone: optionalText(req.body.secondaryPhone, 30),
          facebookUrl: safeWebUrl(req.body.facebookUrl, 'Facebook link'),
          instagramUrl: safeWebUrl(req.body.instagramUrl, 'Instagram link'),
          invoicePrefix,
          financialYearStartMonth: boundedSetting(req.body.financialYearStartMonth, 'Financial-year start month', 1, 12, true),
          defaultGstRate: boundedSetting(req.body.defaultGstRate, 'Default GST rate', 0, 100),
          defaultHsnCode: optionalText(req.body.defaultHsnCode, 50)?.toUpperCase() || null,
          labelShopName,
          labelWidthMm,
          labelHeightMm,
          labelGapMm,
          labelSpeed,
          labelDensity,
          whatsappAutoSendInvoices: req.body.whatsappAutoSendInvoices === 'on',
          ...(removeSignature ? { signatureImage: null, signatureMimeType: null } : (signature || {}))
      }
    });
    clearBusinessSettingsCache();
    redirectWith(res, '/business-settings', 'message', 'Business and invoice settings saved.');
  } catch (error) {
    redirectWith(res, '/business-settings', 'error', error.message || 'Could not save business settings.');
  }
});

app.get('/network-setup', requireLoopback, (req, res, next) => {
  try {
    const connection = parseDatabaseConnection(process.env.DATABASE_URL);
    res.render('network-setup', {
      title: 'Network PC setup',
      connection,
      addresses: localNetworkAddresses(),
      canEnableSharing: isLocalHost(connection.host)
    });
  } catch (error) { next(error); }
});

app.post('/network-setup', requireLoopback, async (req, res, next) => {
  try {
    const access = await enableNetworkSharing({ databaseUrl: process.env.DATABASE_URL, configPath, currentEnv: process.env, form: req.body });
    if (access.updatedConfig) {
      Object.assign(process.env, access.updatedConfig);
      await reloadPrismaClient();
    }
    redirectWith(res, '/network-setup', 'message', `Client PC access is ready for database ${access.database} on port ${access.port}. Use the selected database username on each client.`);
  } catch (error) {
    redirectWith(res, '/network-setup', 'error', error.message || 'Could not enable client PC access.');
  }
});

app.get('/printer-setup', requireLoopback, (req, res) => {
  res.render('printer-setup', { title: 'Barcode printer setup', printer: configuredLabelPrinter(), printerPlatform: printerPlatformName() });
});

app.post('/printer-setup', requireLoopback, (req, res) => {
  const returnTo = req.body.returnTo === '/inventory' ? '/inventory' : '/printer-setup';
  try {
    const values = updatePrinterConfiguration({ configPath, currentEnv: process.env, form: req.body });
    Object.assign(process.env, values);
    redirectWith(res, returnTo, 'message', printerSavedMessage(values));
  } catch (error) {
    redirectWith(res, returnTo, 'error', error.message || 'Could not save barcode printer settings.');
  }
});

app.get('/data-management', (req, res, next) => {
  try {
    const selectedResource = req.query.resource || 'sales';
    const resource = resourceFor(selectedResource);
    const range = parseDateRange(req.query);
    res.render('data-management/index', { title: 'Data export & archive', resources: RESOURCE_LIST, selectedResource, resource, range });
  } catch (error) { next(error); }
});

app.post('/data/export', async (req, res) => {
  let resource;
  let range;
  try {
    resource = resourceFor(req.body.resource);
    range = parseDateRange(req.body);
    const businessSettings = await getBusinessSettings(prisma);
    const payload = await getExportPayload(prisma, resource.key, range, {
      salesMetal: req.body.salesMetal,
      shopName: businessSettings.shopName,
      metadata: excelBusinessMetadata(businessSettings)
    });
    const workbook = await buildExcelExport(payload);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
    res.send(workbook);
  } catch (error) {
    const query = new URLSearchParams({ resource: resource?.key || req.body.resource || 'sales', from: range?.from || req.body.from || '', to: range?.to || req.body.to || '', error: error.message || 'Could not create Excel export.' });
    res.redirect(`/data-management?${query.toString()}`);
  }
});

app.post('/data/archive', requireLoopback, async (req, res) => {
  let resource;
  let range;
  try {
    resource = resourceFor(req.body.resource);
    range = parseDateRange(req.body);
    if (req.body.archiveAcknowledged !== 'on' || String(req.body.archiveConfirm || '').trim().toUpperCase() !== 'DELETE') {
      throw new Error('Tick the confirmation box and type DELETE before permanently removing data.');
    }
    const result = await archiveData(prisma, resource.key, range);
    const skipped = result.skipped ? ` ${result.skipped} protected record${result.skipped === 1 ? '' : 's'} kept.` : '';
    const note = result.note ? ` ${result.note}` : '';
    redirectWith(res, `/data-management?resource=${resource.key}&from=${range.from}&to=${range.to}`, 'message', `${result.deleted} ${resource.label.toLowerCase()} record${result.deleted === 1 ? '' : 's'} permanently deleted.${skipped}${note}`);
  } catch (error) {
    const query = new URLSearchParams({ resource: resource?.key || req.body.resource || 'sales', from: range?.from || req.body.from || '', to: range?.to || req.body.to || '', error: error.message || 'Could not remove data.' });
    res.redirect(`/data-management?${query.toString()}`);
  }
});

app.get('/', async (req, res, next) => {
  try {
    const today = startOfToday();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayKey = dateInput(today);
    const [productCount, stockSummaryRows, itemBreakdownRows, todaySales, lowStock, recentSales, todayCashbook, customerDue, topSellingRows] = await Promise.all([
      prisma.product.count({ where: { quantity: { gt: 0 }, status: 'AVAILABLE' } }),
      prisma.$queryRaw`
        SELECT metal, SUM(quantity) AS pieces, SUM(netWeight * quantity) AS weight
        FROM Product
        WHERE quantity > 0 AND status = 'AVAILABLE'
        GROUP BY metal
      `,
      prisma.$queryRaw`
        SELECT name, category, metal, SUM(quantity) AS pieces, SUM(netWeight * quantity) AS weight
        FROM Product
        WHERE quantity > 0 AND status = 'AVAILABLE'
        GROUP BY name, category, metal
        ORDER BY weight DESC, name ASC
        LIMIT 100
      `,
      prisma.sale.aggregate({ where: { cancelledAt: null, saleDate: { gte: today, lt: tomorrow } }, _sum: { total: true, paid: true, balance: true, urdOffset: true }, _count: true }),
      prisma.product.findMany({ where: { quantity: { lte: 1 }, status: 'AVAILABLE' }, orderBy: { quantity: 'asc' }, take: 6 }),
      prisma.sale.findMany({ where: { cancelledAt: null }, include: { customer: true }, orderBy: { saleDate: 'desc' }, take: 6 }),
      prisma.cashbookEntry.groupBy({ by: ['type'], where: { entryDate: todayKey }, _sum: { amount: true } }),
      prisma.customerLedger.aggregate({ _sum: { amount: true } }),
      prisma.$queryRaw`
        SELECT
          COALESCE(NULLIF(si.productName, ''), 'Jewellery item') AS name,
          COALESCE(si.productMetal, 'OTHER') AS metal,
          COALESCE(si.productPurity, '') AS purity,
          SUM(si.quantity) AS quantity,
          SUM(si.lineTotal) AS billed
        FROM \`SaleItem\` si
        INNER JOIN \`Sale\` s ON s.id = si.saleId
        WHERE s.cancelledAt IS NULL AND s.saleDate >= ${today} AND s.saleDate < ${tomorrow}
        GROUP BY
          COALESCE(NULLIF(si.productName, ''), 'Jewellery item'),
          COALESCE(si.productMetal, 'OTHER'),
          COALESCE(si.productPurity, '')
        ORDER BY billed DESC
        LIMIT 1
      `
    ]);
    const cashFlow = todayCashbook.reduce((summary, entry) => {
      if (entry.type === 'IN') summary.in += Number(entry._sum.amount || 0);
      if (entry.type === 'OUT') summary.out += Number(entry._sum.amount || 0);
      return summary;
    }, { in: 0, out: 0 });
    const metalWeights = { GOLD: { pieces: 0, weight: 0 }, SILVER: { pieces: 0, weight: 0 }, OTHER: { pieces: 0, weight: 0 } };
    stockSummaryRows.forEach((row) => {
      const bucket = row.metal === 'GOLD' ? metalWeights.GOLD : row.metal === 'SILVER' ? metalWeights.SILVER : metalWeights.OTHER;
      bucket.pieces += Number(row.pieces || 0);
      bucket.weight += Number(row.weight || 0);
    });
    const itemWeightBreakdown = itemBreakdownRows.map((row) => ({
      name: row.name,
      category: row.category,
      metal: row.metal,
      pieces: Number(row.pieces || 0),
      weight: Number(row.weight || 0)
    }));
    const inventoryByMetal = stockSummaryRows.map((row) => ({
      metal: row.metal,
      pieces: Number(row.pieces || 0),
      weight: Number(row.weight || 0)
    }));
    const topSellingItem = topSellingRows[0] ? {
      name: topSellingRows[0].name,
      metal: topSellingRows[0].metal,
      purity: topSellingRows[0].purity || null,
      quantity: Number(topSellingRows[0].quantity || 0),
      billed: Number(topSellingRows[0].billed || 0)
    } : null;
    res.render('dashboard', {
      title: 'Dashboard',
      stats: {
        productCount,
        stockPieces: metalWeights.GOLD.pieces + metalWeights.SILVER.pieces + metalWeights.OTHER.pieces,
        stockWeight: metalWeights.GOLD.weight + metalWeights.SILVER.weight + metalWeights.OTHER.weight,
        goldPieces: metalWeights.GOLD.pieces, goldWeight: metalWeights.GOLD.weight,
        silverPieces: metalWeights.SILVER.pieces, silverWeight: metalWeights.SILVER.weight,
        otherPieces: metalWeights.OTHER.pieces, otherWeight: metalWeights.OTHER.weight,
        sales: todaySales._sum.total || 0,
        invoices: todaySales._count,
        cashIn: cashFlow.in,
        cashOut: cashFlow.out,
        cashNet: cashFlow.in - cashFlow.out,
        customerDue: Math.max(0, Number(customerDue._sum.amount || 0)),
        amountCollected: Number(todaySales._sum.paid || 0)
      },
      lowStock,
      recentSales,
      itemWeightBreakdown,
      inventoryByMetal,
      topSellingItem
    });
  } catch (error) { next(error); }
});

app.get('/rates', async (req, res, next) => {
  try {
    const selectedDate = req.query.date || dateInput();
    const [rateInfo, history] = await Promise.all([
      getRateForDate(prisma, selectedDate),
      prisma.dailyRate.findMany({ orderBy: { rateDate: 'desc' }, take: 14 })
    ]);
    const exactRate = await prisma.dailyRate.findUnique({ where: { rateDate: selectedDate } });
    res.render('rates/index', { title: 'Daily metal rates', selectedDate, rate: exactRate || rateInfo.rate, rateInfo, history });
  } catch (error) { next(error); }
});

app.post('/rates', async (req, res, next) => {
  try {
    const rateDate = dateInput(dateTimeFromInput(req.body.rateDate || dateInput()));
    const gold22k = number(req.body.gold22k);
    const gold24k = number(req.body.gold24k);
    const silver = number(req.body.silver);
    await prisma.dailyRate.upsert({
      where: { rateDate },
      create: { rateDate, gold22k, gold24k, silver, note: req.body.note ? String(req.body.note).trim().toUpperCase() : null },
      update: { gold22k, gold24k, silver, note: req.body.note ? String(req.body.note).trim().toUpperCase() : null }
    });
    redirectWith(res, `/rates?date=${rateDate}`, 'message', `Rates saved for ${rateDate}.`);
  } catch (error) { next(error); }
});

app.get('/inventory', async (req, res, next) => {
  try {
    const filters = {
      itemName: String(req.query.itemName || req.query.q || '').trim(),
      weight: String(req.query.weight || '').trim(),
      barcode: String(req.query.barcode || '').trim()
    };
    const availableStock = { status: 'AVAILABLE', quantity: { gt: 0 } };
    const searchClauses = productSearchClauses(filters);
    const where = searchClauses.length ? { AND: [availableStock, ...searchClauses] } : availableStock;
    const totalItems = await prisma.product.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 150);
    const products = await prisma.product.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    const printerStatus = await resolveLabelPrinter(req.query.checkPrinter === '1');
    const printerTransport = configuredLabelPrinter();
    res.render('inventory/index', { title: 'Inventory', products, filters, pagination, printerName: printerStatus.name || printerTransport.name, printerStatus, printerTransport, printerPlatform: printerPlatformName() });
  } catch (error) { next(error); }
});

// Batch removal keeps the quick inventory-cleanup workflow separate from the
// regular inventory table. Only unsold, single-piece records can be selected;
// the barcode sequence is deliberately never decremented, so removed labels
// can never be allocated again.
app.get('/api/inventory/batch-remove', async (req, res, next) => {
  try {
    const filters = {
      itemName: String(req.query.itemName || req.query.q || '').trim(),
      weight: String(req.query.weight || '').trim(),
      barcode: String(req.query.barcode || '').trim(),
      batchDocNo: String(req.query.batchDocNo || '').trim()
    };
    const availablePiece = { status: 'AVAILABLE', quantity: 1 };
    const searchClauses = productSearchClauses(filters);
    if (filters.batchDocNo) searchClauses.push({ batchDocNo: { contains: filters.batchDocNo } });
    const where = searchClauses.length ? { AND: [availablePiece, ...searchClauses] } : availablePiece;
    const totalItems = await prisma.product.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 30);
    const products = await prisma.product.findMany({
      where,
      select: { id: true, barcode: true, name: true, category: true, metal: true, purity: true, netWeight: true, batchDocNo: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.json({
      items: products.map((product) => ({
        ...product,
        netWeight: Number(product.netWeight || 0)
      })),
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalItems: pagination.totalItems,
      totalPages: pagination.totalPages,
      hasNext: Boolean(pagination.nextUrl),
      hasPrevious: Boolean(pagination.previousUrl),
      filters
    });
  } catch (error) { next(error); }
});

app.post('/api/inventory/batch-remove', express.json(), async (req, res, next) => {
  try {
    const ids = [...new Set(asArray(req.body.productIds || req.body.productId)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one inventory piece to remove.' });
    if (ids.length > 500) return res.status(400).json({ error: 'Remove up to 500 pieces at a time.' });

    const removed = await prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: ids }, status: 'AVAILABLE', quantity: 1 },
        select: { id: true, barcode: true, sku: true, name: true, metal: true, purity: true, netWeight: true, quantity: true }
      });
      if (products.length !== ids.length) {
        throw new Error('One or more selected pieces are no longer available. Refresh the list and try again.');
      }
      // Keep an auditable removal movement before deleting the live inventory
      // rows. The product relation is set to null on delete, but the snapshot
      // fields remain available in Stock Movement and its exports.
      await tx.stockMovement.createMany({
        data: products.map((product) => stockMovementSnapshot(
          product,
          'ADJUSTMENT_OUT',
          -Math.max(1, Number(product.quantity || 1)),
          `Removed from inventory · ${product.barcode || product.name}`
        ))
      });
      await tx.product.deleteMany({ where: { id: { in: ids } } });
      return products;
    });

    res.json({
      success: true,
      count: removed.length,
      barcodes: removed.map((product) => product.barcode).filter(Boolean)
    });
  } catch (error) {
    console.error('Batch inventory removal error:', error);
    res.status(500).json({ error: error.message || 'Could not remove the selected pieces.' });
  }
});

app.post('/labels/test-print', async (req, res) => {
  try {
    const printerTransport = configuredLabelPrinter();
    if (printerNeedsQueueName(printerTransport) && !printerTransport.name) {
      throw new Error(printerTransport.mode === 'CUPS'
        ? 'Set the installed CUPS printer queue before sending labels.'
        : 'Set the installed Windows printer name before sending labels.');
    }
    const printerName = printerDisplayName(printerTransport);
    const tspl = buildTsplJob([{ product: {
      metal: 'GOLD', barcode: 'TSC TEST', name: 'PRINTER TEST',
      grossWeight: 0, stoneWeight: 0, netWeight: 0
    } }], await getBusinessSettings(prisma));
    const result = await sendTsplToPrinter(printerTransport, tspl);
    redirectWith(res, '/inventory', 'message', `TSC test label ${printerTransport.mode === 'TCP' ? 'sent to' : 'queued to'} ${printerName}. ${result}`);
  } catch (error) {
    redirectWith(res, '/inventory', 'error', error.message || 'Could not send the TSC test label.');
  }
});

// Run printer checks only on demand. Page rendering must stay fast when the
// printer is disconnected or its Windows queue is slow to respond.
app.get('/api/printer/check', async (req, res) => {
  try {
    const status = await resolveLabelPrinter(true);
    res.json({ success: true, status });
  } catch (error) {
    res.status(503).json({ success: false, error: error.message || 'Could not check the configured label printer.' });
  }
});

app.post('/labels/print', express.json(), async (req, res, next) => {
  const isJson = req.is('json') || req.headers['content-type']?.includes('application/json') || req.body?.isJson;
  try {
    let requests;
    if (req.body.batchDocNo) {
      const batchDocProducts = await prisma.product.findMany({
        where: { batchDocNo: String(req.body.batchDocNo).trim(), status: 'AVAILABLE', quantity: 1 },
        orderBy: { id: 'asc' }
      });
      requests = batchDocProducts.map(p => ({ id: p.id, copies: 1 }));
    } else if (Array.isArray(req.body.productIds)) {
      requests = req.body.productIds.map(id => ({ id: Number(id), copies: Number(req.body.copies || 1) }));
    } else {
      requests = labelRequests(req.body);
    }
    requests = requests.map((request) => ({
      id: Number(request.id),
      copies: Number(request.copies)
    }));
    if (requests.some((request) => !Number.isInteger(request.id) || request.id <= 0 || !Number.isInteger(request.copies) || request.copies < 1 || request.copies > 20)) {
      throw new Error('Each selected item must request between 1 and 20 label copies.');
    }
    const totalRequestedLabels = requests.reduce((total, request) => total + request.copies, 0);
    if (totalRequestedLabels > 500) throw new Error('A single print job is limited to 500 labels. Split this into smaller batches.');
    if (!requests.length) {
      if (isJson) return res.status(400).json({ error: 'Select at least one inventory item to print labels.' });
      return redirectWith(res, '/inventory', 'error', 'Select at least one inventory item to print labels.');
    }
    const printerTransport = configuredLabelPrinter();
    if (printerNeedsQueueName(printerTransport) && !printerTransport.name) {
      const message = printerTransport.mode === 'CUPS'
        ? 'Set the installed CUPS printer queue before sending labels.'
        : 'Set the installed Windows printer name before sending labels.';
      if (isJson) return res.status(400).json({ error: message });
      return redirectWith(res, '/inventory', 'error', message);
    }
    const printerName = printerDisplayName(printerTransport);
    const products = await prisma.product.findMany({
      where: { id: { in: requests.map((row) => row.id) }, status: 'AVAILABLE', quantity: 1 }
    });
    if (products.length !== requests.length) {
      if (isJson) return res.status(400).json({ error: 'One or more selected inventory items could not be found.' });
      return redirectWith(res, '/inventory', 'error', 'One or more selected inventory items could not be found.');
    }
    const orderedProducts = requests.map(r => products.find(p => p.id === r.id)).filter(Boolean);
    const labels = requests.flatMap(({ id, copies }) => {
      const product = orderedProducts.find((item) => item.id === id);
      if (!product.barcode) throw new Error(`${product.name} has no barcode yet.`);
      return Array.from({ length: copies }, (_, copyIndex) => ({ product, copyIndex: copyIndex + 1, copies }));
    });
    const tspl = buildTsplJob(labels, await getBusinessSettings(prisma));
    const result = await sendTsplToPrinter(printerTransport, tspl);
    const successMsg = `${labels.length} native TSPL label${labels.length === 1 ? '' : 's'} ${printerTransport.mode === 'TCP' ? 'sent to' : 'queued to'} ${printerName}. ${result}`;
    if (isJson) {
      return res.json({ success: true, message: successMsg, count: labels.length });
    }
    redirectWith(res, '/inventory', 'message', successMsg);
  } catch (error) {
    if (isJson) return res.status(500).json({ error: error.message || 'Could not send native TSPL labels to the printer.' });
    redirectWith(res, '/inventory', 'error', error.message || 'Could not send native TSPL labels to the printer.');
  }
});

// A batch document is allocated atomically with its first physical piece. A
// page open/cancel must never consume a document number or merge two PCs into
// a pre-reserved batch.
app.all(['/api/inventory/batch-docs/reserve', '/api/inventory/batch-docs/next'], (req, res) => {
  res.status(410).json({ error: 'Refresh Batch Add. The batch number is assigned when the first piece is saved.' });
});

app.get('/api/inventory/batch-docs', async (req, res, next) => {
  try {
    const pageSize = 30;
    const requestedPage = Number(req.query.page || 1);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const q = String(req.query.q || '').trim();
    const date = String(req.query.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Choose a valid batch date.' });
    }
    let dateRange = null;
    if (date) {
      try {
        dateRange = localDateTimeRange(date, date);
      } catch (_) {
        return res.status(400).json({ error: 'Choose a valid batch date.' });
      }
    }

    const searchClause = q
      ? Prisma.sql`AND (m.batchDocNo LIKE ${`%${q}%`}
        OR m.name LIKE ${`%${q}%`}
        OR m.category LIKE ${`%${q}%`}
        OR m.barcode LIKE ${`%${q}%`})`
      : Prisma.empty;
    const dateClause = dateRange
      ? Prisma.sql`AND m.createdAt >= ${dateRange.gte} AND m.createdAt <= ${dateRange.lte}`
      : Prisma.empty;

    // Read one extra group so the client can render a reliable Next button
    // without a second COUNT query. The list remains bounded at 30 batches
    // per page, while older batches stay reachable through pagination/search.
    // The inner query identifies matching batches; the outer query totals
    // every piece in each matched batch, even for a barcode-specific search.
    const batchGroups = await prisma.$queryRaw(Prisma.sql`
      SELECT p.batchDocNo, COUNT(p.id) AS pieceCount,
             COALESCE(SUM(p.netWeight), 0) AS totalWeight,
             COALESCE(SUM(p.sellingPrice), 0) AS totalValue
      FROM Product p
      WHERE p.batchDocNo IS NOT NULL
        AND p.batchDocNo IN (
          SELECT DISTINCT m.batchDocNo
          FROM Product m
          WHERE m.batchDocNo IS NOT NULL ${searchClause} ${dateClause}
        )
      GROUP BY p.batchDocNo
      ORDER BY p.batchDocNo DESC
      LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}
    `);
    const visibleGroups = batchGroups.slice(0, pageSize);
    const batchNumbers = visibleGroups.map((group) => group.batchDocNo).filter(Boolean);
    let samples = [];
    if (batchNumbers.length) {
      // Fetch one representative product for every visible batch in a single
      // statement. This replaces the previous one-query-per-batch N+1 loop.
      samples = await prisma.$queryRaw(Prisma.sql`
        SELECT p.batchDocNo, p.name, p.category, p.metal, p.purity,
               p.createdAt, p.makingChargeType, p.makingChargeValue, p.location
        FROM Product p
        INNER JOIN (
          SELECT batchDocNo, MIN(id) AS firstId
          FROM Product
          WHERE batchDocNo IN (${Prisma.join(batchNumbers)})
          GROUP BY batchDocNo
        ) firstBatch ON firstBatch.batchDocNo = p.batchDocNo
                    AND firstBatch.firstId = p.id
      `);
    }
    const sampleByBatch = new Map(samples.map((sample) => [sample.batchDocNo, sample]));
    const docs = visibleGroups.map((bg) => {
      const sample = sampleByBatch.get(bg.batchDocNo);
      return {
        batchDocNo: bg.batchDocNo,
        pieceCount: Number(bg.pieceCount || 0),
        totalWeight: Number(bg.totalWeight || 0),
        totalValue: Number(bg.totalValue || 0),
        createdAt: sample?.createdAt,
        name: sample?.name,
        category: sample?.category,
        metal: sample?.metal,
        purity: sample?.purity,
        makingChargeType: sample?.makingChargeType,
        makingChargeValue: sample?.makingChargeValue,
        location: sample?.location
      };
    });
    res.json({ docs, page, pageSize, hasNext: batchGroups.length > pageSize, q, date });
  } catch (error) { next(error); }
});

app.get('/api/inventory/batch-docs/:batchDocNo', async (req, res, next) => {
  try {
    const batchDocNo = req.params.batchDocNo.trim();
    const products = await prisma.product.findMany({
      where: { batchDocNo },
      orderBy: { id: 'asc' }
    });
    const formatted = products.map((p) => ({
      ...p,
      formattedSellingPrice: money(Number(p.sellingPrice || 0)),
      formattedNetWeight: grams(Number(p.netWeight || 0)),
      formattedGrossWeight: grams(Number(p.grossWeight || p.netWeight || 0))
    }));
    res.json({ batchDocNo, products: formatted, count: formatted.length });
  } catch (error) { next(error); }
});

app.post('/api/inventory/batch-piece', express.json(), async (req, res, next) => {
  try {
    const name = titleCase(req.body.name);
    const category = titleCase(req.body.category);
    const metal = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(req.body.metal) ? req.body.metal : 'SILVER';
    const purity = String(req.body.purity || '').trim().toUpperCase() || null;
    const grossWeight = Math.max(0, number(req.body.grossWeight));
    const stoneWeight = Math.max(0, number(req.body.stoneWeight));
    const netWeight = number(req.body.netWeight) > 0 ? number(req.body.netWeight) : Math.max(0, grossWeight - stoneWeight);
    const makingChargeType = ['FIXED', 'PER_GRAM', 'PERCENTAGE'].includes(req.body.makingChargeType) ? req.body.makingChargeType : 'PER_GRAM';
    const makingChargeValue = number(req.body.makingChargeValue);
    const location = req.body.location ? String(req.body.location).trim().toUpperCase() : null;
    const requestedBatchDocNo = req.body.batchDocNo ? String(req.body.batchDocNo).trim() : null;
    const notes = req.body.notes ? String(req.body.notes).trim().toUpperCase() : null;

    if (!name) return res.status(400).json({ error: 'Item name is required.' });
    if (!category) return res.status(400).json({ error: 'Category is required.' });
    if (netWeight <= 0) return res.status(400).json({ error: 'Net weight must be greater than 0.' });

    const product = await prisma.$transaction(async (tx) => {
      // A batch number is assigned only while saving the first piece.  This
      // keeps it atomic across counter PCs: two empty batch dialogs cannot
      // accidentally receive the same document number.
      const existingBatch = requestedBatchDocNo
        ? await tx.product.findFirst({
          where: { batchDocNo: requestedBatchDocNo, status: 'AVAILABLE', quantity: 1 },
          select: { id: true }
        })
        : null;
      const batchDocNo = existingBatch ? requestedBatchDocNo : await nextBatchDocumentNumber(tx);
      const rateInfo = await getRateForDate(tx);
      const metalAmount = metalRateFromDailyRate({ metal, purity }, rateInfo.rate) * netWeight;
      const suggestedPrice = metalAmount + makingAmount(makingChargeType, makingChargeValue, metalAmount, netWeight);
      const barcode = await nextBarcode(tx, metal);
      const newProduct = await tx.product.create({
        data: {
          barcode,
          sku: barcode.replaceAll(' ', '-').toUpperCase(),
          name,
          category,
          metal,
          purity,
          grossWeight: grossWeight || netWeight,
          stoneWeight,
          netWeight,
          quantity: 1,
          reorderLevel: 0,
          purchasePrice: 0,
          sellingPrice: suggestedPrice,
          makingChargePerGram: makingChargeType === 'PER_GRAM' ? makingChargeValue : 0,
          makingChargeType,
          makingChargeValue,
          location,
          batchDocNo,
          notes,
          status: 'AVAILABLE'
        }
      });
      await tx.stockMovement.create({
        data: stockMovementSnapshot(
          newProduct,
          'OPENING',
          1,
          'Opening stock'
        )
      });
      // Register in master autocomplete list
      await upsertItemName(tx, name, category, { updateCategory: false });
      return {
        ...newProduct,
        formattedSellingPrice: money(suggestedPrice),
        formattedNetWeight: grams(netWeight),
        formattedGrossWeight: grams(grossWeight || netWeight)
      };
    });

    res.json({ success: true, product });
  } catch (error) {
    console.error('Batch piece addition error:', error);
    res.status(500).json({ error: error.message || 'Failed to create piece.' });
  }
});

app.put('/api/inventory/batch-piece/:id', express.json(), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid piece ID.' });
    const grossWeight = Math.max(0, number(req.body.grossWeight));
    const stoneWeight = Math.max(0, number(req.body.stoneWeight));
    const netWeight = number(req.body.netWeight) > 0 ? number(req.body.netWeight) : Math.max(0, grossWeight - stoneWeight);
    if (netWeight <= 0) return res.status(400).json({ error: 'Net weight must be greater than 0.' });

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUniqueOrThrow({ where: { id } });
      const rateInfo = await getRateForDate(tx);
      const metal = req.body.metal || existing.metal;
      if (metal !== existing.metal) {
        throw new Error(`Metal cannot be changed after barcode ${existing.barcode || 'generation'}. Delete the unsold item and add it again so its barcode remains correct.`);
      }
      const requestedPurity = req.body.purity !== undefined ? req.body.purity : existing.purity;
      const purity = String(requestedPurity || '').trim().toUpperCase() || null;
      const name = req.body.name ? titleCase(req.body.name) : existing.name;
      const category = req.body.category ? titleCase(req.body.category) : existing.category;
      const makingChargeType = ['FIXED', 'PER_GRAM', 'PERCENTAGE'].includes(req.body.makingChargeType) ? req.body.makingChargeType : existing.makingChargeType;
      const makingChargeValue = req.body.makingChargeValue !== undefined ? number(req.body.makingChargeValue) : Number(existing.makingChargeValue);
      const location = req.body.location !== undefined ? (req.body.location ? String(req.body.location).trim().toUpperCase() : null) : existing.location;

      const metalAmount = metalRateFromDailyRate({ metal, purity }, rateInfo.rate) * netWeight;
      const suggestedPrice = metalAmount + makingAmount(makingChargeType, makingChargeValue, metalAmount, netWeight);

      const product = await tx.product.update({
        where: { id },
        data: {
          name, category, metal, purity,
          grossWeight: grossWeight || netWeight,
          stoneWeight,
          netWeight,
          sellingPrice: suggestedPrice,
          makingChargePerGram: makingChargeType === 'PER_GRAM' ? makingChargeValue : 0,
          makingChargeType,
          makingChargeValue,
          location
        }
      });

      await syncStockMovementSnapshot(tx, product);

      await upsertItemName(tx, name, category, { updateCategory: false });

      return {
        ...product,
        formattedSellingPrice: money(suggestedPrice),
        formattedNetWeight: grams(netWeight),
        formattedGrossWeight: grams(grossWeight || netWeight)
      };
    });

    res.json({ success: true, product: updated });
  } catch (error) {
    console.error('Batch piece update error:', error);
    res.status(500).json({ error: error.message || 'Failed to update piece.' });
  }
});

app.delete('/api/inventory/batch-piece/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid piece ID.' });
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUniqueOrThrow({ where: { id } });
      await tx.stockMovement.create({
        data: stockMovementSnapshot(product, 'ADJUSTMENT_OUT', -Math.max(1, Number(product.quantity || 1)), `Removed from inventory · ${product.barcode || product.name}`)
      });
      await tx.product.delete({ where: { id } });
    });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Batch piece delete error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete piece.' });
  }
});

app.get('/inventory/new', async (req, res, next) => {
  try {
    const rateInfo = await getRateForDate(prisma);
    res.render('inventory/form', { title: 'Add jewellery item', product: null, rateInfo });
  } catch (error) { next(error); }
});

app.post('/inventory', async (req, res, next) => {
  try {
    const reorderLevel = req.body.reorderLevel !== undefined && req.body.reorderLevel !== ''
      ? Math.max(0, Math.floor(number(req.body.reorderLevel, 0)))
      : 0;
    const product = await prisma.$transaction(async (tx) => {
      const rateInfo = await getRateForDate(tx);
      const metal = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(req.body.metal) ? req.body.metal : 'GOLD';
      const purity = String(req.body.purity || '').trim().toUpperCase() || null;
      const itemName = titleCase(req.body.name);
      const category = titleCase(req.body.category);
      const netWeight = number(req.body.netWeight);
      if (netWeight <= 0) throw new Error('Net weight must be greater than zero.');
      const makingChargeType = ['FIXED', 'PER_GRAM', 'PERCENTAGE'].includes(req.body.makingChargeType) ? req.body.makingChargeType : 'PER_GRAM';
      const makingChargeValue = number(req.body.makingChargeValue);
      const metalAmount = metalRateFromDailyRate({ metal, purity }, rateInfo.rate) * netWeight;
      const suggestedPrice = metalAmount + makingAmount(makingChargeType, makingChargeValue, metalAmount, netWeight);
      const barcode = await nextBarcode(tx, metal);
      const product = await tx.product.create({
        data: {
          barcode,
          sku: (req.body.sku || barcode.replaceAll(' ', '-')).trim().toUpperCase(), name: itemName, category,
          metal, purity,
          grossWeight: number(req.body.grossWeight), stoneWeight: number(req.body.stoneWeight), netWeight,
          // One record always represents one physical piece. Identical name,
          // metal and weight still receive a different database-reserved code.
          quantity: 1, reorderLevel,
          purchasePrice: number(req.body.purchasePrice), sellingPrice: suggestedPrice,
          makingChargePerGram: makingChargeType === 'PER_GRAM' ? makingChargeValue : 0,
          makingChargeType, makingChargeValue, location: req.body.location ? String(req.body.location).trim().toUpperCase() : null,
          notes: req.body.notes ? String(req.body.notes).trim().toUpperCase() : null, status: 'AVAILABLE'
        }
      });
      await tx.stockMovement.create({ data: stockMovementSnapshot(product, 'OPENING', 1, `Opening stock · ${barcode}`) });
      // Auto-register item name in the master list for future autocomplete
      await upsertItemName(tx, itemName, category, { updateCategory: false });
      return product;
    });
    redirectWith(res, '/inventory', 'message', `${product.barcode} saved to inventory.`);
  } catch (error) {
    if (error.code === 'P2002') return redirectWith(res, '/inventory/new', 'error', 'Barcode already exists.');
    next(error);
  }
});

app.get('/inventory/:id/edit', async (req, res, next) => {
  try {
    const [product, rateInfo] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: Number(req.params.id) } }),
      getRateForDate(prisma)
    ]);
    res.render('inventory/form', { title: `Edit ${product.barcode || 'item'}`, product, rateInfo });
  } catch (error) { next(error); }
});

app.post('/inventory/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const reorderLevel = req.body.reorderLevel !== undefined && req.body.reorderLevel !== ''
      ? Math.max(0, Math.floor(number(req.body.reorderLevel, 0)))
      : 0;
    await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUniqueOrThrow({ where: { id } });
      const metal = req.body.metal || existing.metal;
      if (metal !== existing.metal) {
        throw new Error(`Metal cannot be changed after barcode ${existing.barcode || 'generation'}. Delete the unsold item and add it again so its barcode remains correct.`);
      }
      const purity = String(req.body.purity || '').trim().toUpperCase() || null;
      const itemName = titleCase(req.body.name);
      const category = titleCase(req.body.category);
      const netWeight = number(req.body.netWeight);
      const makingChargeType = ['FIXED', 'PER_GRAM', 'PERCENTAGE'].includes(req.body.makingChargeType) ? req.body.makingChargeType : 'PER_GRAM';
      const makingChargeValue = Math.max(0, number(req.body.makingChargeValue));
      if (netWeight <= 0) throw new Error('Net weight must be greater than zero.');
      const rateInfo = await getRateForDate(tx);
      const metalAmount = metalRateFromDailyRate({ metal, purity }, rateInfo.rate) * netWeight;
      const suggestedPrice = roundedMoney(metalAmount + makingAmount(makingChargeType, makingChargeValue, metalAmount, netWeight));
      const updatedProduct = await tx.product.update({ where: { id }, data: {
        sku: String(req.body.sku || existing.sku).trim().toUpperCase(), name: itemName, category, metal,
        purity, grossWeight: number(req.body.grossWeight), stoneWeight: number(req.body.stoneWeight), netWeight,
        reorderLevel, purchasePrice: number(req.body.purchasePrice), sellingPrice: suggestedPrice,
        makingChargePerGram: makingChargeType === 'PER_GRAM' ? makingChargeValue : 0,
        makingChargeType, makingChargeValue, location: req.body.location ? String(req.body.location).trim().toUpperCase() : null, notes: req.body.notes ? String(req.body.notes).trim().toUpperCase() : null, status: 'AVAILABLE'
      } });
      await syncStockMovementSnapshot(tx, updatedProduct);
      await upsertItemName(tx, itemName, category, { updateCategory: false });
    });
    redirectWith(res, '/inventory', 'message', 'Item details updated.');
  } catch (error) { next(error); }
});

app.post('/inventory/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return redirectWith(res, '/inventory', 'error', 'Invalid item ID.');
    const deleted = await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id } });
      if (!product) return null;
      await tx.stockMovement.create({
        data: stockMovementSnapshot(product, 'ADJUSTMENT_OUT', -Math.max(1, Number(product.quantity || 1)), `Removed from inventory · ${product.barcode || product.name}`)
      });
      await tx.product.delete({ where: { id } });
      return product;
    });
    if (!deleted) return redirectWith(res, '/inventory', 'error', 'Item not found.');
    redirectWith(res, '/inventory', 'message', `Item "${deleted.barcode || deleted.name}" deleted successfully.`);
  } catch (error) { next(error); }
});

app.post('/inventory/:id/adjust', async (req, res, next) => {
  try {
    // A stock adjustment used to increase/decrease Product.quantity. That
    // creates extra physical pieces under one barcode and later allows a sale
    // to delete more than the billed item. Keep this old endpoint harmless so
    // bookmarked pages cannot violate the one-item/one-barcode invariant.
    return redirectWith(res, '/inventory', 'error', 'Quantity adjustment is no longer available. Add each physical piece separately so every item keeps its own barcode.');
  } catch (error) { redirectWith(res, '/inventory', 'error', error.message || 'Could not adjust stock.'); }
});

app.get('/customers', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const where = q ? { OR: [
      { name: { contains: q } },
      { phone: { contains: q } },
      { email: { contains: q } }
    ] } : {};
    const totalItems = await prisma.customer.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const customers = await prisma.customer.findMany({
      where,
      // Cancelled invoices remain available in the cancelled register, but
      // they are not active customer sales. Keep the directory count aligned
      // with the Sales register and the customer's visible invoice list.
      include: { _count: { select: { sales: { where: { cancelledAt: null } } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    const balances = customers.length ? await prisma.customerLedger.groupBy({
      by: ['customerId'],
      where: { customerId: { in: customers.map((customer) => customer.id) } },
      _sum: { amount: true }
    }) : [];
    const balanceByCustomer = new Map(balances.map((row) => [row.customerId, Number(row._sum.amount || 0)]));
    const customerRows = customers.map((customer) => ({
      ...customer,
      outstanding: balanceByCustomer.get(customer.id) || 0
    }));
    res.render('contacts/customers', { title: 'Customers', customers: customerRows, q, pagination });
  } catch (error) { next(error); }
});

app.post('/customers', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (phone && !validCustomerPhone(phone)) return redirectWith(res, '/customers', 'error', 'Enter a valid customer mobile number (10 to 15 digits), or leave it blank.');
    const whatsappOptIn = req.body.whatsappOptIn === 'on';
    await prisma.customer.create({ data: { name: titleCase(req.body.name), phone: phone || null, email: req.body.email || null, address: titleCase(req.body.address) || null, panNumber: String(req.body.panNumber || '').trim().toUpperCase() || null, whatsappOptIn, whatsappOptInAt: whatsappOptIn ? new Date() : null } });
    redirectWith(res, '/customers', 'message', 'Customer added.');
  } catch (error) {
    if (error.code === 'P2002') return redirectWith(res, '/customers', 'error', 'That phone number already belongs to a customer.');
    next(error);
  }
});

app.post('/customers/:id', async (req, res, next) => {
  const customerId = Number(req.params.id);
  try {
    const phone = normalizePhone(req.body.phone);
    const name = titleCase(req.body.name);
    if (!name) return redirectWith(res, `/customers/${customerId}`, 'error', 'Enter the customer name.');
    if (phone && !validCustomerPhone(phone)) return redirectWith(res, `/customers/${customerId}`, 'error', 'Enter a valid customer mobile number (10 to 15 digits), or leave it blank.');
    const whatsappOptIn = req.body.whatsappOptIn === 'on';
    await prisma.customer.update({ where: { id: customerId }, data: {
      name, phone: phone || null, email: String(req.body.email || '').trim() || null,
      address: titleCase(req.body.address) || null, panNumber: String(req.body.panNumber || '').trim().toUpperCase() || null,
      whatsappOptIn, whatsappOptInAt: whatsappOptIn ? new Date() : null
    } });
    redirectWith(res, `/customers/${customerId}`, 'message', 'Customer details updated across linked invoices and registers.');
  } catch (error) {
    if (error.code === 'P2002') return redirectWith(res, `/customers/${customerId}`, 'error', 'That mobile number already belongs to another customer.');
    next(error);
  }
});

app.get('/customers/:id', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const [customer, ledgerCount, ledgerTotal, unpaidSalesCount] = await Promise.all([
      prisma.customer.findUniqueOrThrow({
        where: { id: customerId },
        include: {
          sales: { where: { cancelledAt: null }, orderBy: { saleDate: 'desc' }, take: 10 },
          schemeEnrollments: {
            where: { status: { not: 'CANCELLED' } },
            include: { schemePlan: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 20
          },
          pledgeLoans: {
            orderBy: [{ pledgeDate: 'desc' }, { id: 'desc' }],
            take: 20
          }
        }
      }),
      prisma.customerLedger.count({ where: { customerId } }),
      prisma.customerLedger.aggregate({ where: { customerId }, _sum: { amount: true } }),
      prisma.sale.count({ where: { customerId, cancelledAt: null, balance: { gt: 0 } } })
    ]);
    const pagination = paginationFor(req, ledgerCount, req.query.page, 200);
    const skip = (pagination.page - 1) * pagination.pageSize;
    const ledger = await prisma.customerLedger.findMany({
      where: { customerId },
      include: { sale: true },
      orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
      skip,
      take: pagination.pageSize
    });
    const outstanding = Number(ledgerTotal._sum.amount || 0);
    const [newerTotalRow] = skip > 0 ? await prisma.$queryRaw`
      SELECT COALESCE(SUM(recent.amount), 0) AS amount
      FROM (
        SELECT amount FROM CustomerLedger
        WHERE customerId = ${customerId}
        ORDER BY entryDate DESC, id DESC
        LIMIT ${skip}
      ) AS recent
    ` : [{ amount: 0 }];
    let runningDue = roundedMoney(outstanding - Number(newerTotalRow?.amount || 0));
    ledger.forEach((entry) => {
      entry.runningDue = runningDue;
      runningDue = roundedMoney(runningDue - Number(entry.amount));
    });
    customer.ledger = ledger;
    res.render('contacts/customer-detail', { title: customer.name, customer, outstanding, unpaidSalesCount, pagination });
  } catch (error) { next(error); }
});

app.get('/customers/:id/activity', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) throw new Error('Customer not found.');
    const pageSize = 50;
    const [customer, counts] = await Promise.all([
      prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { id: true, name: true, phone: true } }),
      Promise.all([
        prisma.sale.count({ where: { customerId, cancelledAt: null } }),
        prisma.customerLedger.count({ where: { customerId, type: { not: 'SALE_CREDIT' } } }),
        prisma.urdPurchase.count({ where: { customerId, cancelledAt: null } }),
        prisma.schemeEnrollment.count({ where: { customerId, status: { not: 'CANCELLED' } } }),
        prisma.pledgeLoan.count({ where: { customerId } }),
        prisma.customerOrder.count({ where: { customerId } }),
        prisma.schemeInstallmentPayment.count({ where: { installment: { enrollment: { customerId, status: { not: 'CANCELLED' } } } } }),
        prisma.pledgeLoanPayment.count({ where: { pledgeLoan: { customerId } } })
      ])
    ]);
    const totalEvents = counts.reduce((sum, count) => sum + count, 0);
    const pagination = paginationFor(req, totalEvents, req.query.page, pageSize);
    // Fetch enough of each independently ordered stream to build the requested
    // global page. This keeps the first page small while allowing every older
    // event to be reached through normal pagination.
    const windowSize = pagination.page * pageSize;
    const [sales, payments, purchases, enrollments, pledgeLoans, orders, schemePayments, pledgePayments] = await Promise.all([
      prisma.sale.findMany({ where: { customerId, cancelledAt: null }, select: { id: true, invoiceNumber: true, saleDate: true, total: true }, orderBy: [{ saleDate: 'desc' }, { id: 'desc' }], take: windowSize }),
      prisma.customerLedger.findMany({ where: { customerId, type: { not: 'SALE_CREDIT' } }, select: { id: true, saleId: true, entryDate: true, amount: true, paymentMethod: true, type: true, reference: true, note: true }, orderBy: [{ entryDate: 'desc' }, { id: 'desc' }], take: windowSize }),
      prisma.urdPurchase.findMany({ where: { customerId, cancelledAt: null }, select: { id: true, purchaseNumber: true, purchaseDate: true, totalAmount: true, metal: true }, orderBy: [{ purchaseDate: 'desc' }, { id: 'desc' }], take: windowSize }),
      prisma.schemeEnrollment.findMany({ where: { customerId, status: { not: 'CANCELLED' } }, include: { schemePlan: { select: { name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: windowSize }),
      prisma.pledgeLoan.findMany({ where: { customerId }, select: { id: true, pledgeNumber: true, pledgeDate: true, itemDescription: true, metal: true, principalAmount: true, principalRepaid: true, status: true }, orderBy: [{ pledgeDate: 'desc' }, { id: 'desc' }], take: windowSize }),
      prisma.customerOrder.findMany({ where: { customerId }, select: { id: true, orderNumber: true, orderDate: true, itemName: true, status: true, quotedAmount: true, customerAdvance: true }, orderBy: [{ orderDate: 'desc' }, { id: 'desc' }], take: windowSize }),
      prisma.schemeInstallmentPayment.findMany({
        where: { installment: { enrollment: { customerId, status: { not: 'CANCELLED' } } } },
        select: { id: true, amount: true, paymentDate: true, paymentMethod: true, installment: { select: { installmentNumber: true, enrollment: { select: { id: true, enrollmentNumber: true, schemePlan: { select: { name: true } } } } } } },
        orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }], take: windowSize
      }),
      prisma.pledgeLoanPayment.findMany({
        where: { pledgeLoan: { customerId } },
        select: { id: true, paymentDate: true, principalAmount: true, interestAmount: true, paymentMethod: true, pledgeLoan: { select: { pledgeNumber: true } } },
        orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }], take: windowSize
      })
    ]);
    const activity = [
      ...sales.map((sale) => ({ kind: 'SALE', occurredAt: sale.saleDate, title: sale.invoiceNumber, amount: Number(sale.total), detail: 'Bill generated', href: `/sales/${sale.id}` })),
      ...payments.map((entry) => ({ kind: 'PAYMENT', occurredAt: entry.entryDate, title: entry.reference || 'Payment received', amount: Math.abs(Number(entry.amount)), detail: `${entry.type === 'ADJUSTMENT' ? 'Customer order balance' : 'Payment received'} · ${entry.paymentMethod?.replace('_', ' ') || 'Payment'}${entry.note ? ` · ${entry.note}` : ''}`, href: entry.saleId ? `/sales/${entry.saleId}` : null })),
      ...purchases.map((purchase) => ({ kind: 'URD', occurredAt: purchase.purchaseDate, title: purchase.purchaseNumber, amount: Number(purchase.totalAmount), detail: `${purchase.metal} purchase`, href: `/urd-purchases?q=${encodeURIComponent(purchase.purchaseNumber)}` })),
      ...enrollments.map((enrollment) => ({ kind: 'SCHEME', occurredAt: enrollment.createdAt, title: enrollment.schemePlan.name, detail: `Scheme joined · ${enrollment.enrollmentNumber}`, href: `/schemes/enrollments/${enrollment.id}` })),
      ...pledgeLoans.map((loan) => ({ kind: 'PLEDGE', occurredAt: loan.pledgeDate, title: loan.pledgeNumber, amount: Math.max(0, Number(loan.principalAmount) - Number(loan.principalRepaid)), detail: `${loan.metal} collateral · ${loan.itemDescription} · ${loan.status.toLowerCase()}`, href: `/pledges/${loan.id}` })),
      ...orders.map((order) => ({ kind: 'ORDER', occurredAt: order.orderDate, title: order.orderNumber, detail: `Order placed · ${order.itemName} · ${order.status.toLowerCase()}${Number(order.customerAdvance) > 0 ? ` · advance ${money(order.customerAdvance)}` : ''}`, href: `/customer-orders?q=${encodeURIComponent(order.orderNumber)}` })),
      ...schemePayments.map((payment) => ({ kind: 'SCHEME_PAYMENT', occurredAt: payment.paymentDate, title: payment.installment.enrollment.enrollmentNumber, amount: Number(payment.amount), detail: `${payment.installment.enrollment.schemePlan.name} · Installment ${payment.installment.installmentNumber} · ${payment.paymentMethod.replace('_', ' ')}`, href: `/schemes/enrollments/${payment.installment.enrollment.id}` })),
      ...pledgePayments.map((payment) => ({ kind: 'PLEDGE_PAYMENT', occurredAt: payment.paymentDate, title: payment.pledgeLoan.pledgeNumber, amount: Number(payment.principalAmount) + Number(payment.interestAmount), detail: `Pledge repayment · ${payment.paymentMethod.replace('_', ' ')}`, href: `/pledges?q=${encodeURIComponent(payment.pledgeLoan.pledgeNumber)}` }))
    ].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)).slice((pagination.page - 1) * pageSize, pagination.page * pageSize);
    res.render('contacts/customer-activity', { title: `${customer.name} activity`, customer, activity, pagination });
  } catch (error) { next(error); }
});

app.post('/customers/:id/payments', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const amount = roundedMoney(number(req.body.amount));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (amount <= 0) return redirectWith(res, `/customers/${customerId}`, 'error', 'Enter a valid payment amount.');
    await prisma.$transaction(async (tx) => {
      const receipt = req.body.reference?.trim() || generatedReference('RCPT');
      const cashbookEntry = await tx.cashbookEntry.create({ data: {
        entryDate: dateInput(), type: 'IN', paymentMethod, amount,
        description: `Customer payment received — ${receipt}`, reference: receipt, customerId, syncLedger: true,
        notes: req.body.note || null
      } });
      await allocateCustomerPayment(tx, {
        customerId,
        amount,
        paymentMethod,
        reference: receipt,
        note: req.body.note || null,
        cashbookEntryId: cashbookEntry.id,
        entryDate: cashbookEntry.entryDate
      });
    });
    redirectWith(res, `/customers/${customerId}`, 'message', 'Payment received and customer credit updated.');
  } catch (error) { redirectWith(res, `/customers/${req.params.id}`, 'error', error.message || 'Could not record payment.'); }
});

// ── Item Names master list ──────────────────────────────────
app.get('/api/item-names', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const where = q ? { name: { contains: q } } : {};
    const items = await prisma.itemName.findMany({ where, orderBy: { name: 'asc' }, take: 20 });
    res.json(items);
  } catch (error) { next(error); }
});

app.post('/api/item-names', express.json(), async (req, res, next) => {
  try {
    const name = titleCase(req.body.name);
    const category = titleCase(req.body.category);
    if (!name || !category) return res.status(400).json({ error: 'Name and category are required.' });
    const item = await upsertItemName(prisma, name, category, { returnItem: true });
    res.json(item);
  } catch (error) { next(error); }
});

app.get('/item-names', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const where = q ? { OR: [{ name: { contains: q } }, { category: { contains: q } }] } : {};
    const totalItems = await prisma.itemName.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 200);
    const items = await prisma.itemName.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.render('item-names/index', { title: 'Item Names', items, q, pagination });
  } catch (error) { next(error); }
});

app.post('/item-names/add', async (req, res, next) => {
  try {
    const name = titleCase(req.body.name);
    const category = titleCase(req.body.category);
    if (!name || !category) return redirectWith(res, '/item-names', 'error', 'Name and category are required.');
    await upsertItemName(prisma, name, category);
    redirectWith(res, '/item-names', 'message', `"${name}" added.`);
  } catch (error) { next(error); }
});

app.post('/item-names/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = titleCase(req.body.name);
    const category = titleCase(req.body.category);
    if (!name || !category) return redirectWith(res, '/item-names', 'error', 'Name and category are required.');
    await prisma.itemName.update({ where: { id }, data: { name, category } });
    redirectWith(res, '/item-names', 'message', `"${name}" updated.`);
  } catch (error) {
    if (error.code === 'P2002') return redirectWith(res, '/item-names', 'error', 'That item name already exists.');
    next(error);
  }
});

app.post('/item-names/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const item = await prisma.itemName.delete({ where: { id } });
    redirectWith(res, '/item-names', 'message', `"${item.name}" deleted.`);
  } catch (error) { next(error); }
});

app.get('/sales', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const from = req.query.from || '';
    const to = req.query.to || '';
    const where = { cancelledAt: null };
    // Text search: customer name OR customer phone OR invoice number
    if (q) {
      where.OR = [
        { invoiceNumber: { contains: q } },
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: q } } }
      ];
    }
    // Date range filter on saleDate
    if (from || to) {
      where.saleDate = {};
      if (from) where.saleDate.gte = localDateTimeRange(from, from).gte;
      if (to) where.saleDate.lte = localDateTimeRange(to, to).lte;
    }
    const totalItems = await prisma.sale.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const sales = await prisma.sale.findMany({
      where,
      include: { customer: true, urdPurchase: true, _count: { select: { items: true } } },
      orderBy: { saleDate: 'desc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.render('sales/index', { title: 'Sales', sales, filters: { q, from, to }, pagination });
  } catch (error) { next(error); }
});

app.get('/api/rates', async (req, res, next) => {
  try {
    const rateInfo = await getRateForDate(prisma, req.query.date || dateInput());
    res.json({ rate: rateInfo.rate, sourceDate: rateInfo.sourceDate, isFallback: rateInfo.isFallback });
  } catch (error) { next(error); }
});

app.get('/api/products/barcode/:barcode', async (req, res, next) => {
  try {
    const raw = decodeURIComponent(req.params.barcode).trim().toUpperCase();
    // Try the input as-is, dash↔space variants, and the compact scanner form.
    // Some Code128 scanners omit the visible space (for example GA for G A).
    const compact = raw.replace(/[\s-]+/g, '');
    const compactMatch = compact.match(/^([GSJ])([0-9A-Z]{1,6})$/i);
    const canonical = compactMatch ? `${compactMatch[1]} ${compactMatch[2]}` : '';
    const barcodeVariants = [...new Set([
      raw, raw.replace(/-/g, ' '), raw.replace(/\s+/g, '-'), compact, canonical,
      canonical.replace(/\s+/g, '-')
    ].filter(Boolean))];
    let product = null;
    for (const b of barcodeVariants) {
      product = await prisma.product.findUnique({ where: { barcode: b } });
      if (product) break;
    }
    // SKU fallback. Generated labels use the same prefix/suffix with a dash in
    // the SKU, so try every normalized form before returning not-found.
    if (!product) {
      for (const sku of barcodeVariants) {
        product = await prisma.product.findFirst({ where: { sku, status: 'AVAILABLE' } });
        if (product) break;
      }
    }
    if (!product) return res.status(404).json({ error: `"${raw}" not found. Check the barcode and try again.` });
    if (product.quantity <= 0 || product.status !== 'AVAILABLE') return res.status(409).json({ error: `${product.barcode} is not available in stock.` });
    const rateInfo = await getRateForDate(prisma, req.query.date || dateInput());
    const metalRate = metalRateFromDailyRate(product, rateInfo.rate);
    // Always return the product — let the user set the rate manually if needed
    res.json({
      product: {
        id: product.id, barcode: product.barcode, name: product.name, category: product.category,
        metal: product.metal, purity: product.purity, netWeight: Number(product.netWeight), quantity: product.quantity,
        makingChargeType: product.makingChargeType, makingChargeValue: Number(product.makingChargeValue)
      },
      metalRate: metalRate || 0,
      rateWarning: !metalRate ? 'No daily rate set — enter the rate manually or set it from the Daily Rates page.' : null,
      sourceDate: rateInfo.sourceDate, isFallback: rateInfo.isFallback
    });
  } catch (error) { next(error); }
});

app.get('/api/customers/phone/:phone', async (req, res, next) => {
  try {
    const phone = normalizePhone(decodeURIComponent(req.params.phone));
    if (!validCustomerPhone(phone)) return res.status(400).json({ error: 'Enter a valid customer mobile number.' });
    const customer = await prisma.customer.findUnique({
      where: { phone },
      include: { sales: { orderBy: { saleDate: 'desc' }, take: 5, select: { invoiceNumber: true, saleDate: true, total: true, balance: true } } }
    });
    if (!customer) return res.json({ found: false, phone });
    const ledgerTotal = await prisma.customerLedger.aggregate({ where: { customerId: customer.id }, _sum: { amount: true } });
    const outstanding = Number(ledgerTotal._sum.amount || 0);
    res.json({
      found: true,
      customer: { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, address: customer.address, panNumber: customer.panNumber, outstanding, recentSales: customer.sales.map((sale) => ({ ...sale, total: Number(sale.total), balance: Number(sale.balance) })) }
    });
  } catch (error) { next(error); }
});

// Forms that need an existing customer search on demand rather than loading
// the entire customer directory (which becomes slow after several years).
app.get('/api/customers/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const namesOnly = req.query.namesOnly === '1' || req.query.mode === 'name';
    // Name autocomplete should respond from the very first character.  The
    // result is still capped below, so short queries remain bounded while
    // allowing the shared picker to feel immediate in every customer field.
    if (q.length < 1) return res.json({ customers: [] });
    const nameFilter = q.length === 1 ? { name: { startsWith: q } } : { name: { contains: q } };
    const customers = await prisma.customer.findMany({
      where: namesOnly ? nameFilter : { OR: [
        nameFilter,
        { phone: { contains: normalizePhone(q) || q } },
        { email: { contains: q } }
      ] },
      select: { id: true, name: true, phone: true, email: true, address: true, panNumber: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 20
    });
    res.json({ customers });
  } catch (error) { next(error); }
});

// A deliberately small, on-demand workspace search.  It never loads a whole
// register: the desktop command palette asks only after two characters and
// each result group is capped, keeping counter PCs responsive on large shops.
app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });

    const [customers, sales, products, purchases, enrollments] = await Promise.all([
      prisma.customer.findMany({
        where: { OR: [{ name: { contains: q } }, { phone: { contains: normalizePhone(q) || q } }, { email: { contains: q } }] },
        select: { id: true, name: true, phone: true }, orderBy: { name: 'asc' }, take: 5
      }),
      prisma.sale.findMany({
        where: { cancelledAt: null, OR: [{ invoiceNumber: { contains: q } }, { customer: { name: { contains: q } } }, { customer: { phone: { contains: q } } }] },
        select: { id: true, invoiceNumber: true, customer: { select: { name: true, phone: true } } }, orderBy: { saleDate: 'desc' }, take: 5
      }),
      prisma.product.findMany({
        where: { status: 'AVAILABLE', quantity: { gt: 0 }, OR: [{ barcode: { contains: q } }, { name: { contains: q } }, { category: { contains: q } }] },
        select: { id: true, barcode: true, name: true, metal: true, netWeight: true }, orderBy: { updatedAt: 'desc' }, take: 5
      }),
      prisma.urdPurchase.findMany({
        where: { cancelledAt: null, OR: [{ purchaseNumber: { contains: q } }, { customer: { name: { contains: q } } }, { customer: { phone: { contains: q } } }] },
        select: { purchaseNumber: true, metal: true, customer: { select: { name: true } } }, orderBy: { purchaseDate: 'desc' }, take: 5
      }),
      prisma.schemeEnrollment.findMany({
        where: { status: { not: 'CANCELLED' }, OR: [{ enrollmentNumber: { contains: q } }, { customer: { name: { contains: q } } }, { customer: { phone: { contains: q } } }] },
        select: { id: true, enrollmentNumber: true, customer: { select: { name: true, phone: true } }, schemePlan: { select: { name: true } } }, orderBy: { updatedAt: 'desc' }, take: 5
      })
    ]);

    const results = [
      ...customers.map((customer) => ({ type: 'Customer', label: customer.name, detail: customer.phone || 'Customer profile', href: `/customers/${customer.id}` })),
      ...sales.map((sale) => ({ type: 'Sale', label: sale.invoiceNumber, detail: sale.customer?.name || sale.customer?.phone || 'Walk-in customer', href: `/sales/${sale.id}` })),
      ...products.map((product) => ({ type: 'Stock', label: `${product.barcode || 'No barcode'} · ${product.name}`, detail: `${product.metal} · ${Number(product.netWeight).toFixed(3)} g`, href: `/inventory?barcode=${encodeURIComponent(product.barcode || '')}&itemName=${encodeURIComponent(product.name)}` })),
      ...purchases.map((purchase) => ({ type: 'URD', label: purchase.purchaseNumber, detail: `${purchase.customer?.name || 'Customer'} · ${purchase.metal}`, href: `/urd-purchases?q=${encodeURIComponent(purchase.purchaseNumber)}` })),
      ...enrollments.map((enrollment) => ({ type: 'Scheme', label: enrollment.customer?.name || enrollment.enrollmentNumber, detail: `${enrollment.schemePlan?.name || 'Scheme'} · ${enrollment.enrollmentNumber}`, href: `/schemes/enrollments/${enrollment.id}` }))
    ];
    res.json({ results });
  } catch (error) { next(error); }
});

app.get('/sales/new', async (req, res, next) => {
  try {
    const [rateInfo, businessSettings] = await Promise.all([getRateForDate(prisma), getBusinessSettings(prisma)]);
    // Invoice number allocation happens in the save transaction. Merely
    // opening or cancelling a bill cannot consume a number.
    res.render('sales/form', { title: 'New sale', invoiceNumber: '', rateInfo, businessSettings });
  } catch (error) { next(error); }
});

app.post('/sales', async (req, res, next) => {
  try {
    const businessSettings = await getBusinessSettings(prisma);
    const rows = saleRows(req.body);
    if (!rows.length) return redirectWith(res, '/sales/new', 'error', 'Enter at least one scanned barcode.');
    if (new Set(rows.map((row) => row.productId)).size !== rows.length) {
      return redirectWith(res, '/sales/new', 'error', 'The same barcode was entered more than once. Each physical item can be billed only once.');
    }
    const discount = Math.max(0, number(req.body.discount));
    const payment = salePaymentBreakdown(req.body);
    const saleDate = dateTimeFromInput(req.body.saleDate);
    const includeUrdPurchase = req.body.includeUrdPurchase === 'on';
    const sale = await prisma.$transaction(async (tx) => {
      const productIds = [...new Set(rows.map((row) => row.productId))];
      // Lock in a stable order so two PCs cannot sell the same last piece or
      // overwrite one another's quantity update.
      for (const productId of [...productIds].sort((a, b) => a - b)) {
        await tx.$queryRaw`SELECT id FROM \`Product\` WHERE id = ${productId} FOR UPDATE`;
      }
      const [products, rateInfo] = await Promise.all([
        tx.product.findMany({ where: { id: { in: productIds } } }),
        getRateForDate(tx, dateInput(saleDate))
      ]);
      if (products.length !== productIds.length) throw new Error('One or more scanned items no longer exist.');
      for (const product of products) {
        if (product.status !== 'AVAILABLE') throw new Error(`${product.barcode} is not available for sale.`);
        if (Number(product.quantity) !== 1) {
          throw new Error(`${product.barcode} is a legacy combined-stock record. Split it into individual barcode pieces before billing so no unbilled piece is removed.`);
        }
        const submittedRows = rows.filter((row) => row.productId === product.id);
        if (submittedRows.some((row) => row.barcode && ![product.barcode].filter(Boolean).map((value) => String(value).toUpperCase()).includes(row.barcode))) {
          throw new Error('A barcode changed before the bill was saved. Scan the item again to prevent billing the wrong piece.');
        }
        const requested = rows.filter((row) => row.productId === product.id).reduce((total, row) => total + row.quantity, 0);
        if (requested !== 1) throw new Error(`${product.barcode} must be billed as exactly one physical piece.`);
      }
      const pricedRows = rows.map((row) => {
        const product = products.find((item) => item.id === row.productId);
        const weight = row.weight === null ? Number(product.netWeight) : row.weight;
        if (!Number.isFinite(weight) || weight <= 0) {
          throw new Error(`Enter a valid billing weight for ${product.barcode}.`);
        }
        const defaultRate = metalRateFromDailyRate(product, rateInfo.rate);
        const metalRate = row.metalRate > 0 ? row.metalRate : defaultRate;
        if (!metalRate) throw new Error(`Set a daily rate before billing ${product.barcode}.`);
        const makingChargeType = row.makingChargeType || product.makingChargeType;
        const makingChargeValue = row.makingChargeValue === null ? Number(product.makingChargeValue) : row.makingChargeValue;
        const metalAmount = roundedMoney(metalRate * weight * row.quantity);
        const calculatedMaking = roundedMoney(makingAmount(makingChargeType, makingChargeValue, metalAmount, weight, row.quantity));
        const calculatedTaxable = roundedMoney(metalAmount + calculatedMaking);
        return {
          ...row, product, weight, metalRate, metalAmount, makingChargeType, makingChargeValue,
          makingCharge: calculatedMaking,
          taxableAmount: row.taxableAmount === null ? calculatedTaxable : roundedMoney(row.taxableAmount)
        };
      });
      const subtotal = roundedMoney(pricedRows.reduce((sum, row) => sum + row.taxableAmount, 0));
      const appliedDiscount = roundedMoney(Math.min(discount, subtotal));
      const taxable = roundedMoney(Math.max(0, subtotal - appliedDiscount));
      const gstRate = Number(businessSettings.defaultGstRate);
      const gstAmount = roundedMoney(taxable * gstRate / 100);
      // Round only once, after GST. This is the invoice-level amount used for
      // every payment validation, customer balance, cashbook entry and PDF.
      // Example: Rs. 1.80 becomes Rs. 2.00; Rs. 1.10 becomes Rs. 1.00.
      const total = roundToNearestRupee(roundedMoney(taxable + gstAmount));
      const customer = await resolveBillingCustomer(tx, req.body);
      const customerId = customer.id;
      const customerPan = String(req.body.customerPan || req.body.existingCustomerPan || customer.panNumber || '').trim().toUpperCase() || null;
      const urdAmount = includeUrdPurchase ? Math.max(0, roundedMoney(number(req.body.urdTotalAmount))) : 0;
      const settlement = urdSettlement(total, urdAmount);
      let refundMethod = null;
      if (includeUrdPurchase) {
        if (!customerId) throw new Error('Select the customer before settling their URD purchase against this bill.');
        if (number(req.body.urdNetWeight) <= 0 || number(req.body.urdRatePerGram) <= 0 || urdAmount <= 0) {
          throw new Error('Enter valid URD net weight, rate and purchase amount.');
        }
        if (settlement.hasRefund) refundMethod = receiptPaymentMethod(req.body.urdRefundMethod);
      }
      if (settlement.hasRefund && payment.paid > 0) {
        throw new Error('Do not enter a sale payment when URD value is higher than the bill. Select the refund method instead.');
      }
      const netPayable = settlement.netPayable;
      if (payment.paid > netPayable) throw new Error(`Payment is greater than the net payable amount of ${money(netPayable)}.`);
      const acceptedPaid = payment.paid;
      const balance = roundedMoney(Math.max(0, netPayable - acceptedPaid));
      const sale = await tx.sale.create({ data: {
        invoiceNumber: await nextDocumentNumber(tx, 'SB', saleDate, businessSettings), customerId, customerPan, saleDate,
        subtotal, discount: appliedDiscount, gstRate, gstAmount, total, urdOffset: urdAmount, paid: acceptedPaid,
        cashPaid: payment.cashPaid, upiPaid: payment.upiPaid, cardPaid: payment.cardPaid, bankPaid: payment.bankPaid, balance,
        paymentMethod: payment.paymentMethod, notes: req.body.notes ? String(req.body.notes).trim().toUpperCase() : null,
        items: { create: pricedRows.map((row) => ({
          productId: row.productId, productBarcode: row.product.barcode, productSku: row.product.sku,
          productName: row.product.name, productMetal: row.product.metal, productPurity: row.purity ? String(row.purity).trim().toUpperCase() : (row.product.purity ? String(row.product.purity).trim().toUpperCase() : null),
          grossWeight: row.product.grossWeight, quantity: row.quantity, weight: row.weight, unitPrice: row.metalRate,
          metalRate: row.metalRate, metalAmount: row.metalAmount, makingCharge: row.makingCharge,
          makingChargeType: row.makingChargeType, makingChargeValue: row.makingChargeValue,
          taxableAmount: row.taxableAmount, lineTotal: row.taxableAmount,
          hsnCode: row.hsnCode ? String(row.hsnCode).trim().toUpperCase() : null,
          huidCode: row.huidCode ? String(row.huidCode).trim().toUpperCase() : null
        })) }
      } });
      if (balance > 0) await tx.customerLedger.create({
        data: { customerId, saleId: sale.id, type: 'SALE_CREDIT', amount: balance, entryDate: dateInput(saleDate), reference: sale.invoiceNumber, note: `Credit balance from ${sale.invoiceNumber}` }
      });
      if (includeUrdPurchase) {
        const urdMetal = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(String(req.body.urdMetal || '').trim().toUpperCase())
          ? String(req.body.urdMetal).trim().toUpperCase()
          : 'GOLD';
        const urdPurity = req.body.urdPurity ? String(req.body.urdPurity).trim().toUpperCase() : null;
        const urdDescription = req.body.urdDescription ? String(req.body.urdDescription).trim().toUpperCase() : 'URD PURCHASE SETTLED AGAINST SALE';
        const urdPurchase = await tx.urdPurchase.create({ data: {
          purchaseNumber: await nextDocumentNumber(tx, 'UR', saleDate, { financialYearStartMonth: businessSettings.financialYearStartMonth }), customerId, purchaseDate: saleDate,
          metal: urdMetal, purity: urdPurity,
          grossWeight: number(req.body.urdGrossWeight), netWeight: number(req.body.urdNetWeight),
          ratePerGram: number(req.body.urdRatePerGram), totalAmount: urdAmount, saleOffset: settlement.saleAdjustment,
          paid: settlement.netRefundable, paymentMethod: refundMethod || 'MIXED', description: urdDescription,
          notes: `Settled against sale ${sale.invoiceNumber}`, saleId: sale.id,
          // Sales-created URD settlements are single-item legacy-style rows;
          // retain that item explicitly so every URD PDF uses the same detail
          // source as standalone multi-item purchases.
          items: { create: [{
            description: urdDescription.slice(0, 255), metal: urdMetal, purity: urdPurity,
            grossWeight: number(req.body.urdGrossWeight), netWeight: number(req.body.urdNetWeight),
            ratePerGram: number(req.body.urdRatePerGram), totalAmount: urdAmount
          }] }
        } });
        if (settlement.hasRefund) {
          await tx.cashbookEntry.create({ data: {
            entryDate: dateInput(saleDate), type: 'OUT', paymentMethod: refundMethod, amount: settlement.netRefundable,
            description: `URD refund — ${sale.invoiceNumber}`, reference: sale.invoiceNumber, customerId,
            urdPurchaseId: urdPurchase.id, syncLedger: false,
            notes: `URD excess refunded for sale ${sale.invoiceNumber}`
          } });
        }
      }
      if (acceptedPaid > 0) {
        for (const recordedPayment of payment.cashbookPayments) {
          await tx.cashbookEntry.create({ data: {
             entryDate: dateInput(saleDate), type: 'IN', paymentMethod: recordedPayment.method, amount: recordedPayment.amount,
             description: 'Sale payment', reference: sale.invoiceNumber, customerId, syncLedger: Boolean(customerId),
             saleId: sale.id,
             notes: req.body.notes || null
          } });
        }
      }
      for (const product of products) {
        const saleRow = pricedRows.find((row) => row.productId === product.id);
        const quantitySold = saleRow.quantity;
        await tx.stockMovement.create({
          data: stockMovementSnapshot(product, 'SALE', -quantitySold, `Sold via ${sale.invoiceNumber}`, { netWeight: saleRow.weight, saleId: sale.id })
        });
        // One barcode represents one physical jewellery item. Once that barcode
        // appears on a committed bill, remove its inventory row permanently.
        // SaleItem and StockMovement snapshots preserve all historical details.
        await tx.product.delete({ where: { id: product.id } });
      }
      return sale;
    });
    if (businessSettings.whatsappAutoSendInvoices) {
      try {
        const savedSale = await prisma.sale.findUnique({ where: { id: sale.id }, include: { customer: true } });
        if (savedSale?.customer?.whatsappOptIn) await queueSaleInvoiceMessage(prisma, sale.id);
      } catch (whatsappError) {
        // WhatsApp is deliberately best-effort: a billing/API problem must
        // never roll back a completed sale or prevent the PDF from opening.
        console.warn(`WhatsApp invoice queue skipped for sale ${sale.id}:`, whatsappError.message);
      }
    }
    // Mark only a newly created sale so the invoice screen can clear the local
    // in-progress billing draft. Reopening an older invoice must not discard a
    // cashier's unfinished new bill.
    redirectWith(res, `/sales/${sale.id}?newSale=1`, 'message', 'Sale saved, stock removed and customer credit updated.');
  } catch (error) { redirectWith(res, '/sales/new', 'error', error.message || 'Could not save sale.'); }
});

app.get('/sales/:id/edit', async (req, res, next) => {
  try {
    const sale = await prisma.sale.findFirstOrThrow({
      where: { id: Number(req.params.id), cancelledAt: null },
      include: {
        customer: true,
        items: { orderBy: { id: 'asc' } },
        urdPurchase: true,
        ledgerEntries: {
          where: { type: 'PAYMENT_RECEIVED' },
          select: { amount: true, paymentMethod: true }
        }
      }
    });
    const laterComponents = { CASH: 0, UPI: 0, CARD: 0, BANK_TRANSFER: 0 };
    for (const entry of sale.ledgerEntries) {
      if (entry.paymentMethod in laterComponents) {
        laterComponents[entry.paymentMethod] = roundedMoney(laterComponents[entry.paymentMethod] + Math.abs(Number(entry.amount || 0)));
      }
    }
    const initialComponents = {
      CASH: Math.max(0, roundedMoney(Number(sale.cashPaid || 0) - laterComponents.CASH)),
      UPI: Math.max(0, roundedMoney(Number(sale.upiPaid || 0) - laterComponents.UPI)),
      CARD: Math.max(0, roundedMoney(Number(sale.cardPaid || 0) - laterComponents.CARD)),
      BANK_TRANSFER: Math.max(0, roundedMoney(Number(sale.bankPaid || 0) - laterComponents.BANK_TRANSFER))
    };
    const initialPaid = roundedMoney(Object.values(initialComponents).reduce((sum, amount) => sum + amount, 0));
    const rateInfo = await getRateForDate(prisma, dateInput(sale.saleDate));
    const editSale = {
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      saleDate: dateInput(sale.saleDate),
      customer: sale.customer ? {
        name: sale.customer.name || '',
        phone: sale.customer.phone || '',
        email: sale.customer.email || '',
        address: sale.customer.address || '',
        panNumber: sale.customer.panNumber || sale.customerPan || ''
      } : {
        name: '',
        phone: '',
        email: '',
        address: '',
        panNumber: sale.customerPan || ''
      },
      discount: Number(sale.discount || 0),
      gstRate: Number(sale.gstRate || 0),
      notes: sale.notes || '',
      initialPayment: {
        paid: initialPaid,
        cashPaid: initialComponents.CASH,
        upiPaid: initialComponents.UPI,
        cardPaid: initialComponents.CARD,
        bankPaid: initialComponents.BANK_TRANSFER,
        paymentMethod: initialPaid === 0 ? 'CREDIT' : paymentMethodFromComponents(initialComponents, initialPaid)
      },
      items: sale.items.map((item) => {
        const grossWeight = Number(item.grossWeight || 0);
        const weight = Number(item.weight || 0) > 0 ? Number(item.weight) : grossWeight;
        const metalRate = Number(item.metalRate || 0) > 0 ? Number(item.metalRate) : Number(item.unitPrice || 0);
        const taxableAmount = Number(item.taxableAmount || 0) > 0 ? Number(item.taxableAmount) : Number(item.lineTotal || 0);
        return {
          saleItemId: item.id,
          barcode: item.productBarcode || '',
          sku: item.productSku || '',
          name: item.productName || 'Jewellery item',
          category: '',
          metal: item.productMetal || 'OTHER',
          purity: item.productPurity || '',
          grossWeight: Math.max(grossWeight, weight),
          weight,
          metalRate,
          makingChargeType: item.makingChargeType || 'PER_GRAM',
          makingChargeValue: Number(item.makingChargeValue || 0),
          taxableAmount,
          hsnCode: item.hsnCode || '',
          huidCode: item.huidCode || ''
        };
      }),
      urd: sale.urdPurchase ? {
        metal: sale.urdPurchase.metal,
        purity: sale.urdPurchase.purity || '',
        grossWeight: Number(sale.urdPurchase.grossWeight || 0),
        netWeight: Number(sale.urdPurchase.netWeight || 0),
        ratePerGram: Number(sale.urdPurchase.ratePerGram || 0),
        totalAmount: Number(sale.urdPurchase.totalAmount || 0),
        description: sale.urdPurchase.description || '',
        paymentMethod: sale.urdPurchase.paymentMethod || 'CASH'
      } : null
    };
    res.render('sales/form', { title: `Edit ${sale.invoiceNumber}`, invoiceNumber: sale.invoiceNumber, rateInfo, editSale, businessSettings: await getBusinessSettings(prisma) });
  } catch (error) { next(error); }
});

app.post('/sales/:id/edit', async (req, res, next) => {
  const saleId = Number(req.params.id);
  try {
    const businessSettings = await getBusinessSettings(prisma);
    const rows = saleRows(req.body);
    if (!rows.length) throw new Error('Keep at least one item on the invoice. A sold barcode is never restored to inventory.');
    const allBarcodes = rows.map((row) => row.barcode).filter(Boolean);
    if (new Set(allBarcodes).size !== allBarcodes.length) {
      throw new Error('The same barcode was entered more than once on this invoice.');
    }
    const newProductIds = rows.filter((row) => !row.saleItemId).map((row) => row.productId);
    if (newProductIds.some((id) => !Number.isInteger(id) || id <= 0) || new Set(newProductIds).size !== newProductIds.length) {
      throw new Error('Each newly added barcode must be a different available inventory item.');
    }
    const discount = Math.max(0, number(req.body.discount));
    const payment = salePaymentBreakdown(req.body);
    const saleDate = dateTimeFromInput(req.body.saleDate);
    const includeUrdPurchase = req.body.includeUrdPurchase === 'on';

    await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirstOrThrow({
        where: { id: saleId, cancelledAt: null },
        include: { customer: true, items: true, urdPurchase: true }
      });

      const name = titleCase(req.body.customerName);
      const phone = normalizePhone(req.body.customerPhone);
      if (!name) throw new Error('Enter the customer name.');
      if (phone && !validCustomerPhone(phone)) throw new Error('Enter a valid customer mobile number (10 to 15 digits), or leave it blank.');
      const panNumber = String(req.body.customerPan || '').trim().toUpperCase() || null;
      const email = String(req.body.customerEmail || '').trim() || null;
      const address = titleCase(req.body.customerAddress) || null;

      // Resolve customer by phone to avoid P2002 conflict and support reassigning/assigning customer
      let finalCustomerId = sale.customerId;
      const existingCustomerWithPhone = phone ? await tx.customer.findUnique({ where: { phone } }) : null;
      if (existingCustomerWithPhone) {
        finalCustomerId = existingCustomerWithPhone.id;
        await tx.customer.update({
          where: { id: existingCustomerWithPhone.id },
          data: {
            name,
            email: email || existingCustomerWithPhone.email,
            address: address || existingCustomerWithPhone.address,
            panNumber: panNumber || existingCustomerWithPhone.panNumber
          }
        });
      } else if (sale.customerId && sale.customer) {
        await tx.customer.update({
          where: { id: sale.customerId },
          data: { name, phone: phone || null, email, address, panNumber }
        });
      } else {
        const newCustomer = await tx.customer.create({
          data: { name, phone: phone || null, email, address, panNumber }
        });
        finalCustomerId = newCustomer.id;
      }

      if (sale.customerId && finalCustomerId !== sale.customerId) {
        // A later customer receipt is linked to a sale through its ledger row,
        // not through CashbookEntry.saleId. Move that receipt as well. When a
        // single receipt was allocated across several sales, split the entry
        // so the other sales continue to point to the original customer.
        const linkedPaymentRows = await tx.customerLedger.findMany({
          where: { saleId: sale.id, cashbookEntryId: { not: null } },
          select: { id: true, cashbookEntryId: true, amount: true }
        });
        const paymentRowsByCashbook = new Map();
        for (const row of linkedPaymentRows) {
          const entryId = row.cashbookEntryId;
          if (!entryId) continue;
          const rowsForEntry = paymentRowsByCashbook.get(entryId) || [];
          rowsForEntry.push(row);
          paymentRowsByCashbook.set(entryId, rowsForEntry);
        }
        for (const [cashbookEntryId, rowsForEntry] of paymentRowsByCashbook) {
          const entry = await tx.cashbookEntry.findUniqueOrThrow({ where: { id: cashbookEntryId } });
          const movedAmount = roundedMoney(rowsForEntry.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0));
          const allLinkedRows = await tx.customerLedger.findMany({
            where: { cashbookEntryId },
            select: { id: true }
          });
          const movedIds = new Set(rowsForEntry.map((row) => row.id));
          const hasOtherAllocations = allLinkedRows.some((row) => !movedIds.has(row.id));
          if (!hasOtherAllocations) {
            await tx.cashbookEntry.update({ where: { id: cashbookEntryId }, data: { customerId: finalCustomerId } });
            continue;
          }
          if (movedAmount <= 0 || movedAmount >= roundedMoney(entry.amount)) {
            throw new Error('This sale has a shared payment that cannot be reassigned safely. Correct the linked customer payment before editing the customer.');
          }
          const movedEntry = await tx.cashbookEntry.create({
            data: {
              entryDate: entry.entryDate,
              type: entry.type,
              paymentMethod: entry.paymentMethod,
              description: entry.description,
              amount: movedAmount,
              reference: entry.reference,
              notes: entry.notes,
              customerId: finalCustomerId,
              syncLedger: entry.syncLedger
            }
          });
          await tx.cashbookEntry.update({
            where: { id: cashbookEntryId },
            data: { amount: roundedMoney(Number(entry.amount) - movedAmount) }
          });
          await tx.customerLedger.updateMany({
            where: { id: { in: rowsForEntry.map((row) => row.id) } },
            data: { cashbookEntryId: movedEntry.id }
          });
        }
        await tx.customerLedger.updateMany({ where: { saleId: sale.id }, data: { customerId: finalCustomerId } });
        await tx.cashbookEntry.updateMany({ where: { saleId: sale.id }, data: { customerId: finalCustomerId } });
        if (sale.urdPurchase) {
          await tx.urdPurchase.updateMany({ where: { saleId: sale.id }, data: { customerId: finalCustomerId } });
        }
      }

      const existingItems = new Map(sale.items.map((item) => [item.id, item]));
      const submittedExistingIds = new Set();
      for (const row of rows.filter((item) => item.saleItemId)) {
        if (row.productId > 0 || !existingItems.has(row.saleItemId) || submittedExistingIds.has(row.saleItemId)) {
          throw new Error('An invoice item changed unexpectedly. Refresh this invoice before saving changes.');
        }
        const existing = existingItems.get(row.saleItemId);
        const expectedBarcode = String(existing.productBarcode || '').trim().toUpperCase();
        if (row.barcode && row.barcode !== expectedBarcode) {
          throw new Error('A previously billed barcode cannot be replaced. Remove the line and add a new available barcode instead.');
        }
        submittedExistingIds.add(row.saleItemId);
      }

      for (const productId of [...newProductIds].sort((left, right) => left - right)) {
        await tx.$queryRaw`SELECT id FROM \`Product\` WHERE id = ${productId} FOR UPDATE`;
      }
      const [newProducts, rateInfo] = await Promise.all([
        newProductIds.length ? tx.product.findMany({ where: { id: { in: newProductIds } } }) : [],
        getRateForDate(tx, dateInput(saleDate))
      ]);
      if (newProducts.length !== newProductIds.length) throw new Error('One or more newly added barcodes no longer exist. Scan them again.');
      for (const product of newProducts) {
        if (product.status !== 'AVAILABLE' || Number(product.quantity) !== 1) {
          throw new Error(`${product.barcode} is no longer available for billing.`);
        }
      }

      const pricedRows = rows.map((row) => {
        const existing = row.saleItemId ? existingItems.get(row.saleItemId) : null;
        const product = existing ? {
          id: null,
          barcode: existing.productBarcode || '',
          sku: existing.productSku || '',
          name: existing.productName || 'Jewellery item',
          metal: existing.productMetal || 'OTHER',
          purity: existing.productPurity || null,
          grossWeight: existing.grossWeight,
          netWeight: existing.weight,
          makingChargeType: existing.makingChargeType,
          makingChargeValue: existing.makingChargeValue
        } : newProducts.find((item) => item.id === row.productId);
        if (!product) throw new Error('An invoice item could not be found. Refresh this invoice before saving.');
        const weight = row.weight === null ? Number(existing?.weight ?? product.netWeight) : row.weight;
        if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Enter a valid billing weight for ${product.barcode || product.name}.`);
        const savedRate = Number(existing?.metalRate || existing?.unitPrice || 0);
        const metalRate = row.metalRate > 0 ? row.metalRate : (savedRate || metalRateFromDailyRate(product, rateInfo.rate));
        if (!metalRate) throw new Error(`Set a daily rate before billing ${product.barcode || product.name}.`);
        const makingChargeType = row.makingChargeType || existing?.makingChargeType || product.makingChargeType || 'PER_GRAM';
        const makingChargeValue = row.makingChargeValue === null ? Number(existing?.makingChargeValue ?? product.makingChargeValue ?? 0) : row.makingChargeValue;
        const metalAmount = roundedMoney(metalRate * weight);
        const makingCharge = roundedMoney(makingAmount(makingChargeType, makingChargeValue, metalAmount, weight, 1));
        const calculatedTaxable = roundedMoney(metalAmount + makingCharge);
        return {
          ...row,
          existing,
          product,
          weight,
          metalRate,
          metalAmount,
          makingChargeType,
          makingChargeValue,
          makingCharge,
          taxableAmount: row.taxableAmount === null ? calculatedTaxable : roundedMoney(row.taxableAmount),
          purity: row.purity || existing?.productPurity || product.purity || null
        };
      });

      const subtotal = roundedMoney(pricedRows.reduce((sum, row) => sum + row.taxableAmount, 0));
      const appliedDiscount = roundedMoney(Math.min(discount, subtotal));
      const taxable = roundedMoney(Math.max(0, subtotal - appliedDiscount));
      const submittedGstRate = Number(req.body.gstRate);
      const gstRate = Number.isFinite(submittedGstRate) && submittedGstRate >= 0 && submittedGstRate <= 100
        ? submittedGstRate
        : Number(businessSettings.defaultGstRate);
      const gstAmount = roundedMoney(taxable * gstRate / 100);
      const total = roundToNearestRupee(roundedMoney(taxable + gstAmount));
      const urdAmount = includeUrdPurchase ? Math.max(0, roundedMoney(number(req.body.urdTotalAmount))) : 0;
      const settlement = urdSettlement(total, urdAmount);
      let refundMethod = null;
      if (includeUrdPurchase) {
        if (number(req.body.urdNetWeight) <= 0 || number(req.body.urdRatePerGram) <= 0 || urdAmount <= 0) {
          throw new Error('Enter valid URD net weight, rate and purchase amount.');
        }
        if (settlement.hasRefund) refundMethod = receiptPaymentMethod(req.body.urdRefundMethod);
      }
      if (settlement.hasRefund && payment.paid > 0) {
        throw new Error('Do not enter a sale payment when URD value is higher than the bill. Select the refund method instead.');
      }

      const laterPaymentLedger = await tx.customerLedger.findMany({
        where: { saleId: sale.id, type: 'PAYMENT_RECEIVED' },
        select: { amount: true, paymentMethod: true }
      });
      const laterComponents = { CASH: 0, UPI: 0, CARD: 0, BANK_TRANSFER: 0 };
      for (const entry of laterPaymentLedger) {
        if (entry.paymentMethod in laterComponents) {
          laterComponents[entry.paymentMethod] = roundedMoney(laterComponents[entry.paymentMethod] + Math.abs(Number(entry.amount || 0)));
        }
      }
      const laterPaid = roundedMoney(Object.values(laterComponents).reduce((sum, amount) => sum + amount, 0));
      const netPayable = settlement.netPayable;
      if (payment.paid + laterPaid > netPayable) {
        throw new Error('This edit would make recorded payments greater than the revised net payable amount. Cancel or correct the later receipt first.');
      }
      const totalPaid = roundedMoney(payment.paid + laterPaid);
      const balance = roundedMoney(Math.max(0, netPayable - totalPaid));
      const paymentComponents = {
        CASH: roundedMoney(payment.cashPaid + laterComponents.CASH),
        UPI: roundedMoney(payment.upiPaid + laterComponents.UPI),
        CARD: roundedMoney(payment.cardPaid + laterComponents.CARD),
        BANK_TRANSFER: roundedMoney(payment.bankPaid + laterComponents.BANK_TRANSFER)
      };
      const notes = req.body.notes ? String(req.body.notes).trim().toUpperCase() : null;

      if (sale.urdPurchase) {
        const urdEntries = await tx.cashbookEntry.findMany({ where: { urdPurchaseId: sale.urdPurchase.id }, select: { description: true } });
        const expectedRefundDescription = `URD refund — ${sale.invoiceNumber}`;
        if (urdEntries.some((entry) => entry.description !== expectedRefundDescription)) {
          throw new Error('This linked URD purchase has a later payout. Cancel that payout before editing this invoice.');
        }
        await tx.cashbookEntry.deleteMany({ where: { urdPurchaseId: sale.urdPurchase.id } });
      }

      await tx.cashbookEntry.deleteMany({ where: { saleId: sale.id } });
      await tx.customerLedger.deleteMany({ where: { saleId: sale.id, type: 'SALE_CREDIT' } });

      let urdPurchase = sale.urdPurchase;
      if (!includeUrdPurchase && urdPurchase) {
        await tx.urdPurchase.delete({ where: { id: urdPurchase.id } });
        urdPurchase = null;
      } else if (includeUrdPurchase && urdPurchase) {
        const urdMetal = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(String(req.body.urdMetal || '').trim().toUpperCase())
          ? String(req.body.urdMetal).trim().toUpperCase()
          : 'GOLD';
        const urdPurity = req.body.urdPurity ? String(req.body.urdPurity).trim().toUpperCase() : null;
        const urdDescription = req.body.urdDescription ? String(req.body.urdDescription).trim().toUpperCase() : 'URD purchase settled against sale';
        urdPurchase = await tx.urdPurchase.update({
          where: { id: urdPurchase.id },
          data: {
            customerId: finalCustomerId,
            purchaseDate: saleDate,
            metal: urdMetal,
            purity: urdPurity,
            grossWeight: number(req.body.urdGrossWeight),
            netWeight: number(req.body.urdNetWeight),
            ratePerGram: number(req.body.urdRatePerGram),
            totalAmount: urdAmount,
            saleOffset: settlement.saleAdjustment,
            paid: settlement.netRefundable,
            paymentMethod: refundMethod || 'MIXED',
            description: urdDescription,
            notes: `Settled against sale ${sale.invoiceNumber}`,
            items: { deleteMany: {}, create: [{
              description: urdDescription.slice(0, 255), metal: urdMetal, purity: urdPurity,
              grossWeight: number(req.body.urdGrossWeight), netWeight: number(req.body.urdNetWeight),
              ratePerGram: number(req.body.urdRatePerGram), totalAmount: urdAmount
            }] }
          }
        });
      } else if (includeUrdPurchase) {
        const urdMetal = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(String(req.body.urdMetal || '').trim().toUpperCase())
          ? String(req.body.urdMetal).trim().toUpperCase()
          : 'GOLD';
        const urdPurity = req.body.urdPurity ? String(req.body.urdPurity).trim().toUpperCase() : null;
        const urdDescription = req.body.urdDescription ? String(req.body.urdDescription).trim().toUpperCase() : 'URD purchase settled against sale';
        urdPurchase = await tx.urdPurchase.create({
          data: {
            purchaseNumber: await nextDocumentNumber(tx, 'UR', saleDate, { financialYearStartMonth: businessSettings.financialYearStartMonth }),
            customerId: finalCustomerId,
            purchaseDate: saleDate,
            metal: urdMetal,
            purity: urdPurity,
            grossWeight: number(req.body.urdGrossWeight),
            netWeight: number(req.body.urdNetWeight),
            ratePerGram: number(req.body.urdRatePerGram),
            totalAmount: urdAmount,
            saleOffset: settlement.saleAdjustment,
            paid: settlement.netRefundable,
            paymentMethod: refundMethod || 'MIXED',
            description: urdDescription,
            notes: `Settled against sale ${sale.invoiceNumber}`,
            saleId: sale.id,
            items: { create: [{
              description: urdDescription.slice(0, 255), metal: urdMetal, purity: urdPurity,
              grossWeight: number(req.body.urdGrossWeight), netWeight: number(req.body.urdNetWeight),
              ratePerGram: number(req.body.urdRatePerGram), totalAmount: urdAmount
            }] }
          }
        });
      }

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          customerId: finalCustomerId,
          customerPan: panNumber,
          saleDate,
          subtotal,
          discount: appliedDiscount,
          gstRate,
          gstAmount,
          total,
          urdOffset: urdAmount,
          paid: totalPaid,
          cashPaid: paymentComponents.CASH,
          upiPaid: paymentComponents.UPI,
          cardPaid: paymentComponents.CARD,
          bankPaid: paymentComponents.BANK_TRANSFER,
          balance,
          paymentMethod: totalPaid === 0 ? 'CREDIT' : paymentMethodFromComponents(paymentComponents, totalPaid),
          notes
        }
      });

      // Rebuild the sale credit from every payment recorded against this sale.
      // `payment.paid` is only the original invoice payment; later receipts
      // have already been included in `totalPaid` above. Using the original
      // payment alone would recreate an overstated customer balance after an
      // edited invoice.
      if (balance > 0) {
        await tx.customerLedger.create({
          data: {
            customerId: finalCustomerId,
            saleId: sale.id,
            type: 'SALE_CREDIT',
            amount: balance,
            entryDate: dateInput(saleDate),
            reference: sale.invoiceNumber,
            note: `Credit balance from ${sale.invoiceNumber}`
          }
        });
      }
      for (const recordedPayment of payment.cashbookPayments) {
        await tx.cashbookEntry.create({
          data: {
            entryDate: dateInput(saleDate),
            type: 'IN',
            paymentMethod: recordedPayment.method,
            amount: recordedPayment.amount,
            description: 'Sale payment',
            reference: sale.invoiceNumber,
            customerId: finalCustomerId,
            saleId: sale.id,
            syncLedger: true,
            notes
          }
        });
      }
      if (urdPurchase && settlement.hasRefund) {
        await tx.cashbookEntry.create({
          data: {
            entryDate: dateInput(saleDate),
            type: 'OUT',
            paymentMethod: refundMethod,
            amount: settlement.netRefundable,
            description: `URD refund — ${sale.invoiceNumber}`,
            reference: sale.invoiceNumber,
            customerId: finalCustomerId,
            urdPurchaseId: urdPurchase.id,
            syncLedger: false,
            notes: `URD excess refunded for sale ${sale.invoiceNumber}`
          }
        });
      }

      const removedItems = sale.items.filter((item) => !submittedExistingIds.has(item.id));
      if (removedItems.length) {
        await tx.saleItem.deleteMany({ where: { id: { in: removedItems.map((item) => item.id) } } });
        for (const item of removedItems) {
          await tx.stockMovement.updateMany({
            where: { type: 'SALE', note: `Sold via ${sale.invoiceNumber}`, productBarcode: item.productBarcode || null },
            data: { type: 'ADJUSTMENT_OUT', note: `Removed from edited ${sale.invoiceNumber}; barcode remains unavailable`, createdAt: saleDate }
          });
        }
      }
      for (const row of pricedRows.filter((item) => item.existing)) {
        const itemGrossWeight = Math.max(Number(row.product.grossWeight || 0), row.weight);
        await tx.saleItem.update({
          where: { id: row.saleItemId },
          data: {
            productBarcode: row.product.barcode || null,
            productSku: row.product.sku || '',
            productName: row.product.name || 'Jewellery item',
            productMetal: row.product.metal || null,
            productPurity: row.purity ? String(row.purity).trim().toUpperCase() : null,
            grossWeight: itemGrossWeight,
            quantity: 1,
            weight: row.weight,
            unitPrice: row.metalRate,
            metalRate: row.metalRate,
            metalAmount: row.metalAmount,
            makingCharge: row.makingCharge,
            makingChargeType: row.makingChargeType,
            makingChargeValue: row.makingChargeValue,
            taxableAmount: row.taxableAmount,
            lineTotal: row.taxableAmount,
            hsnCode: row.hsnCode ? String(row.hsnCode).trim().toUpperCase() : null,
            huidCode: row.huidCode ? String(row.huidCode).trim().toUpperCase() : null
          }
        });
        await tx.stockMovement.updateMany({
          where: { type: 'SALE', note: `Sold via ${sale.invoiceNumber}`, productBarcode: row.product.barcode || null },
          data: { productName: row.product.name || '', productMetal: row.product.metal || null, productPurity: row.purity ? String(row.purity).trim().toUpperCase() : null, netWeight: row.weight, createdAt: saleDate }
        });
      }
      for (const row of pricedRows.filter((item) => !item.existing)) {
        const itemGrossWeight = Math.max(Number(row.product.grossWeight || 0), row.weight);
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: row.product.id,
            productBarcode: row.product.barcode,
            productSku: row.product.sku,
            productName: row.product.name,
            productMetal: row.product.metal,
            productPurity: row.purity ? String(row.purity).trim().toUpperCase() : null,
            grossWeight: itemGrossWeight,
            quantity: 1,
            weight: row.weight,
            unitPrice: row.metalRate,
            metalRate: row.metalRate,
            metalAmount: row.metalAmount,
            makingCharge: row.makingCharge,
            makingChargeType: row.makingChargeType,
            makingChargeValue: row.makingChargeValue,
            taxableAmount: row.taxableAmount,
            lineTotal: row.taxableAmount,
            hsnCode: row.hsnCode ? String(row.hsnCode).trim().toUpperCase() : null,
            huidCode: row.huidCode ? String(row.huidCode).trim().toUpperCase() : null
          }
        });
        await tx.stockMovement.create({
          data: { ...stockMovementSnapshot(row.product, 'SALE', -1, `Sold via ${sale.invoiceNumber}`, { netWeight: row.weight, saleId: sale.id }), createdAt: saleDate }
        });
        await tx.product.delete({ where: { id: row.product.id } });
      }
    });

    redirectWith(res, `/sales/${saleId}`, 'message', 'Invoice updated. Its PDF, QR code, registers, ledger, cashbook and URD settlement now use the revised details.');
  } catch (error) {
    if (error.code === 'P2002') return redirectWith(res, `/sales/${saleId}/edit`, 'error', 'That mobile number already belongs to another customer.');
    redirectWith(res, `/sales/${saleId}/edit`, 'error', error.message || 'Could not update this invoice.');
  }
});

app.post('/sales/:id/cancel', async (req, res, next) => {
  const saleId = Number(req.params.id);
  try {
    const sale = await prisma.$transaction((tx) => cancelSale(tx, saleId));
    redirectWith(res, '/sales', 'message', `${sale.invoiceNumber} cancelled. Inventory and its barcode remain permanently unavailable.`);
  } catch (error) { redirectWith(res, `/sales/${saleId}`, 'error', error.message || 'Could not cancel this invoice.'); }
});

app.post('/sales/:id/whatsapp', async (req, res) => {
  const saleId = Number(req.params.id);
  try {
    if (!getWhatsAppStatus().configured) throw new Error('WhatsApp Business API is not configured yet. Add its credentials in the ERP environment first.');
    const message = await queueSaleInvoiceMessage(prisma, saleId, { force: req.body.resend === 'on' });
    const statusMessage = ['SENT', 'DELIVERED', 'READ'].includes(message.status)
      ? 'This invoice has already been sent to WhatsApp.'
      : 'Invoice PDF queued for WhatsApp delivery.';
    redirectWith(res, `/sales/${saleId}`, 'message', statusMessage);
  } catch (error) {
    redirectWith(res, `/sales/${saleId}`, 'error', error.message || 'Could not queue the invoice for WhatsApp.');
  }
});

app.get('/sales/:id', async (req, res, next) => {
  try {
    const sale = await prisma.sale.findFirstOrThrow({ where: { id: Number(req.params.id), cancelledAt: null }, include: { customer: true, urdPurchase: true, items: { include: { product: true } }, whatsappMessage: true } });
    res.render('sales/invoice', { title: sale.invoiceNumber, sale, whatsappStatus: getWhatsAppStatus() });
  } catch (error) { next(error); }
});

app.get('/sales/:id/invoice.pdf', async (req, res, next) => {
  try {
    const sale = await prisma.sale.findFirst({ where: { id: Number(req.params.id), cancelledAt: null }, include: { customer: true, urdPurchase: true, items: { include: { product: true } } } });
    if (!sale) return res.status(404).render('not-found', { title: 'Invoice not found' });
    await writeSaleInvoice(res, sale, await getBusinessSettings(prisma));
  } catch (error) { next(error); }
});

/* ── Cashbook ─────────────────────────────────────────────── */
app.get('/cashbook', async (req, res, next) => {
  try {
    const fromDate = req.query.from || `${dateInput().slice(0, 7)}-01`;
    const toDate = req.query.to || dateInput();
    const methodFilter = req.query.method || '';
    const where = {
      entryDate: { gte: fromDate, lte: toDate },
      ...(methodFilter ? { paymentMethod: methodFilter } : {})
    };
    const totalItems = await prisma.cashbookEntry.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 200);
    const [entries, totals] = await Promise.all([
      prisma.cashbookEntry.findMany({ where, include: { customer: true, supplierPurchase: { include: { supplier: true } } }, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize }),
      prisma.cashbookEntry.groupBy({
        by: ['type', 'paymentMethod'],
        where,
        _sum: { amount: true }
      })
    ]);
    const summary = { totalIn: 0, totalOut: 0, cashIn: 0, cashOut: 0, upiIn: 0, upiOut: 0, cardIn: 0, cardOut: 0, bankIn: 0, bankOut: 0 };
    totals.forEach((row) => {
      const amt = Number(row._sum.amount || 0);
      if (row.type === 'IN') summary.totalIn += amt; else summary.totalOut += amt;
      const key = row.paymentMethod.toLowerCase().replace('_transfer', '');
      if (row.type === 'IN') summary[key + 'In'] = (summary[key + 'In'] || 0) + amt;
      else summary[key + 'Out'] = (summary[key + 'Out'] || 0) + amt;
    });
     summary.netBalance = summary.totalIn - summary.totalOut;
     summary.cashNet = (summary.cashIn || 0) - (summary.cashOut || 0);
     summary.upiNet = (summary.upiIn || 0) - (summary.upiOut || 0);
     summary.cardNet = (summary.cardIn || 0) - (summary.cardOut || 0);
     summary.bankNet = (summary.bankIn || 0) - (summary.bankOut || 0);
    res.render('cashbook/index', { title: 'Cashbook', entries, summary, fromDate, toDate, methodFilter, customers: [], pagination });
  } catch (error) { next(error); }
});

app.post('/cashbook', async (req, res, next) => {
  try {
    const amount = roundedMoney(number(req.body.amount));
    if (amount <= 0) return redirectWith(res, '/cashbook', 'error', 'Enter a valid amount greater than zero.');
    const requestedCustomerId = req.body.customerId ? Number(req.body.customerId) : null;
    const customerId = Number.isInteger(requestedCustomerId) && requestedCustomerId > 0 ? requestedCustomerId : null;
    const syncLedger = Boolean(customerId);
    const entryDate = dateInput(dateTimeFromInput(req.body.entryDate));
    const entryType = req.body.type === 'OUT' ? 'OUT' : 'IN';
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    const description = String(req.body.description || '').trim().toUpperCase();
    if (!description) return redirectWith(res, '/cashbook', 'error', 'Enter a description for this entry.');

    await prisma.$transaction(async (tx) => {
      const receipt = req.body.reference?.trim() || generatedReference('CB');
      const cashbookEntry = await tx.cashbookEntry.create({
        data: {
          entryDate, type: entryType, paymentMethod, description, amount,
          reference: receipt, notes: req.body.notes ? String(req.body.notes).trim().toUpperCase() : null,
          customerId, syncLedger: Boolean(syncLedger)
        }
      });
      if (syncLedger && entryType === 'IN') {
        await allocateCustomerPayment(tx, {
          customerId,
          amount,
          paymentMethod,
          reference: receipt,
          note: `Payment via cashbook · ${description}`,
          cashbookEntryId: cashbookEntry.id,
          entryDate: cashbookEntry.entryDate
        });
      } else if (syncLedger) {
        await lockCustomerForLedger(tx, customerId);
      }
      if (syncLedger && entryType === 'OUT') {
        // Money going out to a customer is money they owe back to the shop.
        await tx.customerLedger.create({
          data: {
            customerId, type: 'ADJUSTMENT', amount, entryDate: cashbookEntry.entryDate, cashbookEntryId: cashbookEntry.id,
            paymentMethod, reference: receipt, note: `Cashbook out · ${description}`
          }
        });
      }
    });
    const label = req.body.type === 'OUT' ? 'Cash out' : 'Cash in';
    const syncNote = syncLedger ? ' Customer ledger updated.' : '';
    redirectWith(res, '/cashbook', 'message', `${label} entry saved.${syncNote}`);
  } catch (error) { redirectWith(res, '/cashbook', 'error', error.message || 'Could not save entry.'); }
});

app.post('/cashbook/:id/delete', async (req, res, next) => {
  try {
    const result = await prisma.$transaction((tx) => reverseAndDeleteCashbookEntry(tx, Number(req.params.id)));
    redirectWith(res, '/cashbook', 'message', 'Entry deleted and all linked accounting records reversed.');
  } catch (error) { redirectWith(res, '/cashbook', 'error', error.message || 'Could not safely delete this cashbook entry.'); }
});

/* ── Customer Orders (made-to-order jewellery) ──────────── */
async function resolveOrderCustomer(tx, body) {
  const selectedId = Number(body.customerId);
  if (Number.isInteger(selectedId) && selectedId > 0) {
    return tx.customer.findUniqueOrThrow({ where: { id: selectedId } });
  }
  const phone = normalizePhone(body.customerPhone);
  if (phone && !validCustomerPhone(phone)) throw new Error('Enter a valid customer mobile number, or leave it blank.');
  if (phone) {
    const existing = await tx.customer.findUnique({ where: { phone } });
    if (existing) return existing;
  }
  const name = titleCase(body.customerName);
  if (!name) throw new Error('Select or enter the customer name.');
  return tx.customer.create({ data: {
    name, phone: phone || null, address: titleCase(body.customerAddress) || null,
    panNumber: String(body.customerPan || '').trim().toUpperCase() || null
  } });
}

// Keep the customer's order balance visible in the same ledger used by the
// credit sheet.  A positive adjustment is the amount still due on the order;
// each advance receipt is a linked negative payment entry.
async function syncCustomerOrderDueLedger(tx, order) {
  const due = roundedMoney(Math.max(0, Number(order.quotedAmount || 0) - Number(order.customerAdvance || 0)));
  const existing = await tx.customerLedger.findMany({
    where: { customerId: order.customerId, type: 'ADJUSTMENT', reference: order.orderNumber },
    orderBy: { id: 'asc' },
    select: { id: true }
  });
  if (due > 0) {
    if (existing.length) {
      await tx.customerLedger.update({ where: { id: existing[0].id }, data: {
        amount: due, entryDate: dateInput(order.orderDate), note: `Customer order balance — ${order.orderNumber}`
      } });
      if (existing.length > 1) await tx.customerLedger.deleteMany({ where: { id: { in: existing.slice(1).map((row) => row.id) } } });
    } else {
      await tx.customerLedger.create({ data: {
        customerId: order.customerId, type: 'ADJUSTMENT', amount: due, entryDate: dateInput(order.orderDate),
        reference: order.orderNumber, note: `Customer order balance — ${order.orderNumber}`
      } });
    }
  } else if (existing.length) {
    await tx.customerLedger.deleteMany({ where: { id: { in: existing.map((row) => row.id) } } });
  }
}

/* ── Pledge Loans (customer gold/silver held as security) ── */
function pledgeStatus(value) {
  const normalized = String(value || 'ACTIVE').toUpperCase();
  return ['ACTIVE', 'RELEASED', 'CANCELLED', 'ALL'].includes(normalized) ? normalized : 'ACTIVE';
}

function pledgeOutstanding(loan) {
  return roundedMoney(Math.max(0, Number(loan.principalAmount || 0) - Number(loan.principalRepaid || 0)));
}

app.get('/pledges', async (req, res, next) => {
  try {
    const q = supplierText(req.query.q);
    const status = pledgeStatus(req.query.status);
    const metal = ['GOLD', 'SILVER'].includes(String(req.query.metal || '').toUpperCase())
      ? String(req.query.metal).toUpperCase()
      : '';
    const where = {
      ...(status === 'ALL' ? {} : { status }),
      ...(metal ? { metal } : {})
    };
    if (q) where.OR = [
      { pledgeNumber: { contains: q } }, { itemDescription: { contains: q } }, { purity: { contains: q } },
      { customer: { name: { contains: q } } }, { customer: { phone: { contains: q } } }
    ];
    const totalItems = await prisma.pledgeLoan.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const loans = await prisma.pledgeLoan.findMany({
      where,
      include: { customer: true, _count: { select: { payments: true } } },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { pledgeDate: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    // Summary cards must cover every matching active pledge, not only the
    // current paginated page shown below.
    const activeAggregate = await prisma.pledgeLoan.aggregate({
      where: { ...where, status: 'ACTIVE' },
      _sum: { principalAmount: true, principalRepaid: true }
    });
    const lent = Number(activeAggregate._sum.principalAmount || 0);
    const repaid = Number(activeAggregate._sum.principalRepaid || 0);
    const activeTotals = { lent, repaid, outstanding: roundedMoney(Math.max(0, lent - repaid)) };
    res.render('pledges/index', { title: 'Pledge loans', loans, q, status, metal, pagination, activeTotals, pledgeOutstanding });
  } catch (error) { next(error); }
});

app.get('/pledges/new', (req, res) => {
  res.render('pledges/form', { title: 'New pledge loan' });
});

app.post('/pledges', async (req, res) => {
  try {
    const metal = ['GOLD', 'SILVER'].includes(String(req.body.metal || '').toUpperCase())
      ? String(req.body.metal).toUpperCase()
      : null;
    const itemDescription = titleCase(req.body.itemDescription);
    const quantity = Math.floor(number(req.body.quantity));
    const grossWeight = Math.max(0, number(req.body.grossWeight));
    const stoneWeight = Math.max(0, number(req.body.stoneWeight));
    const netWeight = Math.max(0, number(req.body.netWeight));
    const valuationAmount = roundedMoney(Math.max(0, number(req.body.valuationAmount)));
    const principalAmount = roundedMoney(Math.max(0, number(req.body.principalAmount)));
    const monthlyInterestRate = Math.max(0, Math.min(99.99, number(req.body.monthlyInterestRate)));
    const pledgeDate = dateTimeFromInput(req.body.pledgeDate);
    const dueDate = req.body.dueDate ? dateTimeFromInput(req.body.dueDate) : null;
    if (!metal) throw new Error('Choose Gold or Silver collateral.');
    if (!itemDescription) throw new Error('Enter the jewellery item kept as security.');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Enter the number of pledged pieces.');
    if (netWeight <= 0) throw new Error('Net weight must be greater than zero.');
    if (principalAmount <= 0) throw new Error('Enter the money given to the customer.');
    if (dueDate && dueDate < pledgeDate) throw new Error('Return due date cannot be before the pledge date.');
    const payoutMethod = receiptPaymentMethod(req.body.payoutMethod);
    const businessSettings = await getBusinessSettings(prisma);
    const loan = await prisma.$transaction(async (tx) => {
      const customer = await resolveOrderCustomer(tx, req.body);
      const record = await tx.pledgeLoan.create({ data: {
        pledgeNumber: await nextDocumentNumber(tx, 'PL', pledgeDate, { financialYearStartMonth: businessSettings.financialYearStartMonth }), customerId: customer.id,
        pledgeDate, dueDate, metal, itemDescription,
        purity: supplierText(req.body.purity).toUpperCase() || null,
        quantity, grossWeight: grossWeight || netWeight, stoneWeight, netWeight,
        valuationAmount, principalAmount, monthlyInterestRate,
        notes: supplierText(req.body.notes) || null
      } });
      await tx.cashbookEntry.create({ data: {
        entryDate: dateInput(pledgeDate), type: 'OUT', paymentMethod: payoutMethod, amount: principalAmount,
        description: `Pledge loan payout — ${record.pledgeNumber}`, reference: record.pledgeNumber,
        customerId: customer.id, pledgeLoanId: record.id, syncLedger: false,
        notes: record.notes
      } });
      return record;
    });
    redirectWith(res, `/pledges/${loan.id}`, 'message', `${loan.pledgeNumber} saved. The cash payout is recorded in Cashbook.`);
  } catch (error) {
    redirectWith(res, '/pledges/new', 'error', error.message || 'Could not save the pledge loan.');
  }
});

app.get('/pledges/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Pledge loan not found.');
    const loan = await prisma.pledgeLoan.findUniqueOrThrow({
      where: { id },
      include: {
        customer: true,
        cashbookEntries: { where: { type: 'OUT' }, orderBy: { id: 'asc' }, take: 1 }
      }
    });
    const paymentCount = await prisma.pledgeLoanPayment.count({ where: { pledgeLoanId: id } });
    const pagination = paginationFor(req, paymentCount, req.query.page, 50);
    loan.payments = await prisma.pledgeLoanPayment.findMany({
      where: { pledgeLoanId: id },
      include: { cashbookEntry: true },
      orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.render('pledges/detail', { title: loan.pledgeNumber, loan, outstanding: pledgeOutstanding(loan), pagination });
  } catch (error) { next(error); }
});

app.get('/pledges/:id/invoice.pdf', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Pledge loan not found.');
    const [loan, businessSettings] = await Promise.all([
      prisma.pledgeLoan.findUnique({
        where: { id },
        include: {
          customer: true,
          payments: { orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }] },
          cashbookEntries: { where: { type: 'OUT' }, orderBy: { id: 'asc' }, take: 1 }
        }
      }),
      getBusinessSettings(prisma)
    ]);
    if (!loan) return res.status(404).render('not-found', { title: 'Pledge receipt not found' });
    await writePledgeLoanInvoice(res, loan, businessSettings);
  } catch (error) { next(error); }
});

// A pledge can be corrected without creating a second account. The customer is
// intentionally edited from Customer details, keeping one customer identity
// across sales, schemes, URD and pledges. The original Cashbook payout is
// corrected in the same transaction so cash flow never drifts from the loan.
app.post('/pledges/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const metal = ['GOLD', 'SILVER'].includes(String(req.body.metal || '').toUpperCase())
      ? String(req.body.metal).toUpperCase()
      : null;
    const itemDescription = titleCase(req.body.itemDescription);
    const quantity = Math.floor(number(req.body.quantity));
    const grossWeight = Math.max(0, number(req.body.grossWeight));
    const stoneWeight = Math.max(0, number(req.body.stoneWeight));
    const netWeight = Math.max(0, number(req.body.netWeight));
    const valuationAmount = roundedMoney(Math.max(0, number(req.body.valuationAmount)));
    const principalAmount = roundedMoney(Math.max(0, number(req.body.principalAmount)));
    const monthlyInterestRate = Math.max(0, Math.min(99.99, number(req.body.monthlyInterestRate)));
    const pledgeDate = dateTimeFromInput(req.body.pledgeDate);
    const dueDate = req.body.dueDate ? dateTimeFromInput(req.body.dueDate) : null;
    if (!Number.isInteger(id) || id <= 0 || !metal || !itemDescription || !Number.isInteger(quantity) || quantity <= 0 || netWeight <= 0 || principalAmount <= 0) {
      throw new Error('Complete the collateral and loan details correctly.');
    }
    if (dueDate && dueDate < pledgeDate) throw new Error('Return due date cannot be before the pledge date.');
    const payoutMethod = receiptPaymentMethod(req.body.payoutMethod);
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`PledgeLoan\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Pledge loan not found.');
      const current = await tx.pledgeLoan.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'ACTIVE') throw new Error('Only an active pledge can be edited.');
      if (principalAmount < Number(current.principalRepaid)) throw new Error(`Money lent cannot be less than the already repaid principal of ${money(current.principalRepaid)}.`);
      const notes = supplierText(req.body.notes) || null;
      const payout = await tx.cashbookEntry.findFirst({ where: { pledgeLoanId: id, type: 'OUT' }, orderBy: { id: 'asc' } });
      if (!payout) throw new Error('The original pledge payout is missing from Cashbook. Restore a verified backup before correcting this record.');
      await tx.pledgeLoan.update({ where: { id }, data: {
        pledgeDate, dueDate, metal, itemDescription, purity: supplierText(req.body.purity).toUpperCase() || null,
        quantity, grossWeight: grossWeight || netWeight, stoneWeight, netWeight,
        valuationAmount, principalAmount, monthlyInterestRate, notes
      } });
      await tx.cashbookEntry.update({ where: { id: payout.id }, data: {
        entryDate: dateInput(pledgeDate), paymentMethod: payoutMethod, amount: principalAmount, notes
      } });
    });
    redirectWith(res, `/pledges/${id}`, 'message', 'Pledge details and original Cashbook payout corrected.');
  } catch (error) {
    redirectWith(res, `/pledges/${id}`, 'error', error.message || 'Could not update this pledge.');
  }
});

app.post('/pledges/:id/payments', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const principalAmount = roundedMoney(Math.max(0, number(req.body.principalAmount)));
    const interestAmount = roundedMoney(Math.max(0, number(req.body.interestAmount)));
    const total = roundedMoney(principalAmount + interestAmount);
    const paymentDate = dateInput(dateTimeFromInput(req.body.paymentDate));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (!Number.isInteger(id) || id <= 0 || total <= 0) throw new Error('Enter principal, interest, or both for this repayment.');
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`PledgeLoan\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Pledge loan not found.');
      const loan = await tx.pledgeLoan.findUniqueOrThrow({ where: { id } });
      if (loan.status !== 'ACTIVE') throw new Error('Only an active pledge can receive a repayment.');
      const due = pledgeOutstanding(loan);
      if (principalAmount > due) throw new Error(`Principal repayment is greater than the outstanding amount of ${money(due)}.`);
      const cashbookEntry = await tx.cashbookEntry.create({ data: {
        entryDate: paymentDate, type: 'IN', paymentMethod, amount: total,
        description: `Pledge repayment — ${loan.pledgeNumber}`, reference: loan.pledgeNumber,
        customerId: loan.customerId, pledgeLoanId: loan.id, syncLedger: false,
        notes: supplierText(req.body.notes) || null
      } });
      await tx.pledgeLoanPayment.create({ data: {
        pledgeLoanId: loan.id, cashbookEntryId: cashbookEntry.id, paymentDate,
        principalAmount, interestAmount, paymentMethod, notes: supplierText(req.body.notes) || null
      } });
      await tx.pledgeLoan.update({ where: { id: loan.id }, data: {
        principalRepaid: { increment: principalAmount }, interestReceived: { increment: interestAmount }
      } });
    });
    redirectWith(res, `/pledges/${id}`, 'message', `Repayment of ${money(total)} recorded in Cashbook.`);
  } catch (error) {
    redirectWith(res, `/pledges/${id}`, 'error', error.message || 'Could not record the pledge repayment.');
  }
});

app.post('/pledges/:id/payments/:paymentId', async (req, res) => {
  const id = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  try {
    const principalAmount = roundedMoney(Math.max(0, number(req.body.principalAmount)));
    const interestAmount = roundedMoney(Math.max(0, number(req.body.interestAmount)));
    const total = roundedMoney(principalAmount + interestAmount);
    const paymentDate = dateInput(dateTimeFromInput(req.body.paymentDate));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (!Number.isInteger(id) || !Number.isInteger(paymentId) || id <= 0 || paymentId <= 0 || total <= 0) throw new Error('Enter a valid corrected repayment.');
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`PledgeLoan\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Pledge loan not found.');
      const [loan, payment] = await Promise.all([
        tx.pledgeLoan.findUniqueOrThrow({ where: { id } }),
        tx.pledgeLoanPayment.findFirstOrThrow({ where: { id: paymentId, pledgeLoanId: id } })
      ]);
      if (loan.status !== 'ACTIVE') throw new Error('Only an active pledge repayment can be corrected.');
      const revisedPrincipalTotal = roundedMoney(Number(loan.principalRepaid) - Number(payment.principalAmount) + principalAmount);
      if (revisedPrincipalTotal < 0 || revisedPrincipalTotal > Number(loan.principalAmount)) throw new Error(`Principal total must stay between ₹0.00 and ${money(loan.principalAmount)}.`);
      const revisedInterestTotal = roundedMoney(Number(loan.interestReceived) - Number(payment.interestAmount) + interestAmount);
      const notes = supplierText(req.body.notes) || null;
      await tx.cashbookEntry.update({ where: { id: payment.cashbookEntryId }, data: {
        entryDate: paymentDate, amount: total, paymentMethod, notes
      } });
      await tx.pledgeLoanPayment.update({ where: { id: payment.id }, data: { paymentDate, principalAmount, interestAmount, paymentMethod, notes } });
      await tx.pledgeLoan.update({ where: { id: loan.id }, data: { principalRepaid: revisedPrincipalTotal, interestReceived: revisedInterestTotal } });
    });
    redirectWith(res, `/pledges/${id}`, 'message', 'Pledge repayment corrected in the loan and Cashbook.');
  } catch (error) {
    redirectWith(res, `/pledges/${id}`, 'error', error.message || 'Could not correct the pledge repayment.');
  }
});

app.post('/pledges/:id/payments/:paymentId/delete', async (req, res) => {
  const id = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  try {
    if (!Number.isInteger(id) || !Number.isInteger(paymentId) || id <= 0 || paymentId <= 0) throw new Error('Pledge repayment not found.');
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`PledgeLoan\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Pledge loan not found.');
      const loan = await tx.pledgeLoan.findUniqueOrThrow({ where: { id } });
      if (loan.status !== 'ACTIVE') throw new Error('Only an active pledge repayment can be removed.');
      const payment = await tx.pledgeLoanPayment.findFirst({ where: { id: paymentId, pledgeLoanId: id }, select: { cashbookEntryId: true } });
      if (!payment) throw new Error('Pledge repayment not found.');
      await reverseAndDeleteCashbookEntry(tx, payment.cashbookEntryId);
    });
    redirectWith(res, `/pledges/${id}`, 'message', 'Pledge repayment removed and the loan balance was recalculated.');
  } catch (error) {
    redirectWith(res, `/pledges/${id}`, 'error', error.message || 'Could not remove the pledge repayment.');
  }
});

app.post('/pledges/:id/release', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const loan = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`PledgeLoan\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Pledge loan not found.');
      const current = await tx.pledgeLoan.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'ACTIVE') throw new Error('This pledge is already closed.');
      const outstanding = pledgeOutstanding(current);
      if (outstanding > 0) throw new Error(`Record the remaining principal of ${money(outstanding)} before releasing the jewellery.`);
      return tx.pledgeLoan.update({ where: { id }, data: { status: 'RELEASED', releasedAt: new Date() } });
    });
    redirectWith(res, `/pledges/${loan.id}`, 'message', 'Jewellery released to the customer. The pledge record remains as history.');
  } catch (error) { redirectWith(res, `/pledges/${id}`, 'error', error.message || 'Could not release the pledged jewellery.'); }
});

app.post('/pledges/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const loan = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`PledgeLoan\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Pledge loan not found.');
      const current = await tx.pledgeLoan.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'ACTIVE') throw new Error('This pledge is already closed.');
      const paymentCount = await tx.pledgeLoanPayment.count({ where: { pledgeLoanId: id } });
      if (paymentCount) throw new Error('This pledge has repayments. Correct or remove them first; then release the jewellery when the principal is settled.');
      await tx.cashbookEntry.deleteMany({ where: { pledgeLoanId: id } });
      return tx.pledgeLoan.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    });
    redirectWith(res, '/pledges', 'message', `${loan.pledgeNumber} cancelled. Its original cash payout was removed from Cashbook.`);
  } catch (error) { redirectWith(res, `/pledges/${id}`, 'error', error.message || 'Could not cancel this pledge.'); }
});

app.get('/customer-orders', async (req, res, next) => {
  try {
    const q = supplierText(req.query.q);
    const requestedStatus = String(req.query.status || 'ACTIVE').toUpperCase();
    const status = ['OPEN', 'IN_PROGRESS', 'READY', 'DELIVERED', 'CANCELLED'].includes(requestedStatus) ? requestedStatus : 'ACTIVE';
    const where = status === 'ACTIVE' ? { status: { in: ['OPEN', 'IN_PROGRESS', 'READY'] } } : { status };
    if (q) where.OR = [
      { orderNumber: { contains: q } }, { itemName: { contains: q } }, { category: { contains: q } },
      { customer: { name: { contains: q } } }, { customer: { phone: { contains: q } } },
      { supplier: { name: { contains: q } } }
    ];
    const totalItems = await prisma.customerOrder.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const orders = await prisma.customerOrder.findMany({
      where, include: { customer: true, supplier: true }, orderBy: [{ dueDate: 'asc' }, { orderDate: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize
    });
    res.render('customer-orders/index', { title: 'Customer orders', orders, q, status, pagination });
  } catch (error) { next(error); }
});

app.get('/customer-orders/new', (req, res) => {
  res.render('customer-orders/form', { title: 'New customer order' });
});

app.get('/customer-orders/:id/invoice.pdf', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).render('not-found', { title: 'Customer order not found' });
    const [order, businessSettings] = await Promise.all([
      prisma.customerOrder.findUnique({
        where: { id },
        include: {
          customer: true,
          supplier: true,
          cashbookEntries: { orderBy: [{ entryDate: 'asc' }, { id: 'asc' }] }
        }
      }),
      getBusinessSettings(prisma)
    ]);
    if (!order) return res.status(404).render('not-found', { title: 'Customer order not found' });
    await writeCustomerOrderInvoice(res, order, businessSettings);
  } catch (error) { next(error); }
});

app.post('/customer-orders', async (req, res) => {
  try {
    const metal = ['GOLD', 'SILVER'].includes(String(req.body.metal || '').toUpperCase()) ? String(req.body.metal).toUpperCase() : null;
    const itemName = titleCase(req.body.itemName);
    const quantity = Math.floor(number(req.body.quantity));
    const quotedAmount = roundedMoney(Math.max(0, number(req.body.quotedAmount)));
    const advance = roundedMoney(Math.max(0, number(req.body.customerAdvance)));
    const orderDate = dateTimeFromInput(req.body.orderDate);
    const dueDate = req.body.dueDate ? dateTimeFromInput(req.body.dueDate) : null;
    if (!metal) throw new Error('Choose Gold or Silver.');
    if (!itemName) throw new Error('Enter the ordered item.');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Enter the number of pieces ordered.');
    if (advance > quotedAmount && quotedAmount > 0) throw new Error('Advance cannot be greater than the quoted amount.');
    const method = advance > 0 ? receiptPaymentMethod(req.body.advancePaymentMethod) : null;
    const businessSettings = await getBusinessSettings(prisma);
    const order = await prisma.$transaction(async (tx) => {
      const customer = await resolveOrderCustomer(tx, req.body);
      const selectedSellerId = Number(req.body.sellerId);
      const supplier = Number.isInteger(selectedSellerId) && selectedSellerId > 0
        ? await tx.supplier.findUniqueOrThrow({ where: { id: selectedSellerId } })
        : supplierText(req.body.sellerName)
          ? await resolveSupplier(tx, { supplierName: req.body.sellerName, supplierPhone: req.body.sellerPhone })
          : null;
      const record = await tx.customerOrder.create({ data: {
        orderNumber: await nextDocumentNumber(tx, 'CO', orderDate, { financialYearStartMonth: businessSettings.financialYearStartMonth }), customerId: customer.id, supplierId: supplier?.id || null,
        orderDate, dueDate, itemName, category: titleCase(req.body.category) || null, metal,
        purity: supplierText(req.body.purity).toUpperCase() || null, quantity,
        targetGrossWeight: Math.max(0, number(req.body.targetGrossWeight)), targetNetWeight: Math.max(0, number(req.body.targetNetWeight)),
        quotedAmount, customerAdvance: advance, advancePaymentMethod: method,
        notes: supplierText(req.body.notes) || null
      } });
      if (advance > 0) {
        const cashbookEntry = await tx.cashbookEntry.create({ data: {
          entryDate: dateInput(orderDate), type: 'IN', paymentMethod: method, amount: advance,
          description: `Customer order advance — ${record.orderNumber}`, reference: record.orderNumber,
          customerId: customer.id, customerOrderId: record.id, syncLedger: true, notes: record.notes
        } });
        await tx.customerLedger.create({ data: {
          customerId: customer.id, type: 'PAYMENT_RECEIVED', amount: -advance, entryDate: cashbookEntry.entryDate,
          paymentMethod: method, cashbookEntryId: cashbookEntry.id,
          reference: record.orderNumber, note: `Advance received for customer order ${record.orderNumber}`
        } });
      }
      await syncCustomerOrderDueLedger(tx, record);
      return record;
    });
    redirectWith(res, '/customer-orders', 'message', `Customer order ${order.orderNumber} saved.`);
  } catch (error) { redirectWith(res, '/customer-orders/new', 'error', error.message || 'Could not save customer order.'); }
});

app.get('/customer-orders/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Customer order not found.');
    const order = await prisma.customerOrder.findFirstOrThrow({
      where: { id, status: { not: 'CANCELLED' } }, include: { customer: true, supplier: true }
    });
    res.render('customer-orders/form', { title: `Edit ${order.orderNumber}`, order, editing: true });
  } catch (error) { next(error); }
});

app.post('/customer-orders/:id/edit', async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Customer order not found.');
    const metal = ['GOLD', 'SILVER'].includes(String(req.body.metal || '').toUpperCase()) ? String(req.body.metal).toUpperCase() : null;
    const itemName = titleCase(req.body.itemName);
    const quantity = Math.floor(number(req.body.quantity));
    const quotedAmount = roundedMoney(Math.max(0, number(req.body.quotedAmount)));
    const orderDate = dateTimeFromInput(req.body.orderDate);
    const dueDate = req.body.dueDate ? dateTimeFromInput(req.body.dueDate) : null;
    if (!metal) throw new Error('Choose Gold or Silver.');
    if (!itemName) throw new Error('Enter the ordered item.');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Enter the number of pieces ordered.');
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`CustomerOrder\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Customer order not found.');
      const current = await tx.customerOrder.findUniqueOrThrow({ where: { id } });
      if (current.status === 'CANCELLED') throw new Error('A cancelled customer order cannot be edited.');
      if (quotedAmount > 0 && Number(current.customerAdvance) > quotedAmount) {
        throw new Error(`Quoted amount cannot be less than the recorded advance of ${money(current.customerAdvance)}.`);
      }
      const customer = await resolveOrderCustomer(tx, req.body);
      await tx.customer.update({ where: { id: customer.id }, data: {
        name: titleCase(req.body.customerName),
        phone: normalizePhone(req.body.customerPhone) || null,
        address: titleCase(req.body.customerAddress) || null,
        panNumber: String(req.body.customerPan || '').trim().toUpperCase() || null
      } });
      const selectedSellerId = Number(req.body.sellerId);
      const supplier = Number.isInteger(selectedSellerId) && selectedSellerId > 0
        ? await tx.supplier.findUniqueOrThrow({ where: { id: selectedSellerId } })
        : supplierText(req.body.sellerName)
          ? await resolveSupplier(tx, { supplierName: req.body.sellerName, supplierPhone: req.body.sellerPhone })
          : null;
      const oldCashbookEntries = await tx.cashbookEntry.findMany({ where: { customerOrderId: id }, select: { id: true } });
      await tx.customerOrder.update({ where: { id }, data: {
        customerId: customer.id, supplierId: supplier?.id || null, orderDate, dueDate, itemName,
        category: titleCase(req.body.category) || null, metal,
        purity: supplierText(req.body.purity).toUpperCase() || null, quantity,
        targetGrossWeight: Math.max(0, number(req.body.targetGrossWeight)),
        targetNetWeight: Math.max(0, number(req.body.targetNetWeight)), quotedAmount,
        notes: supplierText(req.body.notes) || null
      } });
      if (oldCashbookEntries.length) {
        const ids = oldCashbookEntries.map((entry) => entry.id);
        await tx.cashbookEntry.updateMany({ where: { id: { in: ids } }, data: { customerId: customer.id } });
        await tx.customerLedger.updateMany({ where: { cashbookEntryId: { in: ids } }, data: { customerId: customer.id } });
      }
      if (current.customerId !== customer.id) {
        await tx.customerLedger.deleteMany({ where: { customerId: current.customerId, type: 'ADJUSTMENT', reference: current.orderNumber } });
      }
      await syncCustomerOrderDueLedger(tx, { ...current, customerId: customer.id, quotedAmount, orderDate });
    });
    redirectWith(res, '/customer-orders', 'message', 'Customer order updated.');
  } catch (error) { redirectWith(res, `/customer-orders/${id}/edit`, 'error', error.message || 'Could not update customer order.'); }
});

app.post('/customer-orders/:id/payments', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const amount = roundedMoney(number(req.body.amount));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    const paymentDate = dateInput(dateTimeFromInput(req.body.paymentDate || dateInput()));
    if (!Number.isInteger(id) || id <= 0 || amount <= 0) throw new Error('Enter a valid advance amount.');
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`CustomerOrder\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Customer order not found.');
      const order = await tx.customerOrder.findUniqueOrThrow({ where: { id } });
      if (order.status === 'CANCELLED') throw new Error('A cancelled customer order cannot receive payment.');
      if (Number(order.quotedAmount) <= 0) throw new Error('Set a quoted amount before recording another advance.');
      const due = roundedMoney(Math.max(0, Number(order.quotedAmount) - Number(order.customerAdvance)));
      if (amount > due) throw new Error(`Advance cannot be greater than the remaining order balance of ${money(due)}.`);
      const cashbookEntry = await tx.cashbookEntry.create({ data: {
        entryDate: paymentDate, type: 'IN', paymentMethod, amount,
        description: `Customer order advance — ${order.orderNumber}`, reference: order.orderNumber,
        customerId: order.customerId, customerOrderId: order.id, syncLedger: true,
        notes: supplierText(req.body.notes) || null
      } });
      await tx.customerLedger.create({ data: {
        customerId: order.customerId, type: 'PAYMENT_RECEIVED', amount: -amount, entryDate: cashbookEntry.entryDate,
        paymentMethod, cashbookEntryId: cashbookEntry.id, reference: order.orderNumber,
        note: `Advance received for customer order ${order.orderNumber}`
      } });
      const nextAdvance = roundedMoney(Number(order.customerAdvance) + amount);
      await tx.customerOrder.update({ where: { id }, data: {
        customerAdvance: nextAdvance,
        advancePaymentMethod: Number(order.customerAdvance) <= 0 || order.advancePaymentMethod === paymentMethod
          ? paymentMethod : 'MIXED'
      } });
      await syncCustomerOrderDueLedger(tx, { ...order, customerAdvance: nextAdvance });
    });
    redirectWith(res, '/customer-orders', 'message', 'Customer order advance recorded.');
  } catch (error) { redirectWith(res, '/customer-orders', 'error', error.message || 'Could not record order advance.'); }
});

app.post('/customer-orders/:id/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || '').toUpperCase();
    if (!Number.isInteger(id) || id <= 0 || !['OPEN', 'IN_PROGRESS', 'READY', 'DELIVERED'].includes(status)) throw new Error('Choose a valid order status.');
    await prisma.customerOrder.update({ where: { id }, data: { status } });
    redirectWith(res, '/customer-orders', 'message', 'Order status updated.');
  } catch (error) { redirectWith(res, '/customer-orders', 'error', error.message || 'Could not update order status.'); }
});

app.post('/customer-orders/:id/cancel', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const order = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`CustomerOrder\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Customer order not found.');
      const current = await tx.customerOrder.findUniqueOrThrow({ where: { id } });
      if (current.status === 'CANCELLED') throw new Error('This customer order is already cancelled.');
      const refundable = roundedMoney(Math.max(0, Number(current.customerAdvance) - Number(current.refundedAmount)));
      // Remove the order's outstanding-balance entry and detach receipt ledger
      // rows while retaining the original Cashbook audit trail. These receipt
      // rows are now historical, independent Cashbook entries; marking them
      // unsynchronised prevents Cashbook from claiming a ledger allocation
      // that cancellation intentionally removed.
      const orderReceipts = await tx.cashbookEntry.findMany({ where: { customerOrderId: id }, select: { id: true } });
      if (orderReceipts.length) {
        const receiptIds = orderReceipts.map((entry) => entry.id);
        await tx.customerLedger.deleteMany({ where: { cashbookEntryId: { in: receiptIds } } });
        await tx.cashbookEntry.updateMany({ where: { id: { in: receiptIds } }, data: { syncLedger: false } });
      }
      await tx.customerLedger.deleteMany({ where: { customerId: current.customerId, type: 'ADJUSTMENT', reference: current.orderNumber } });
      if (refundable > 0) {
        const refundMethod = receiptPaymentMethod(req.body.refundPaymentMethod);
        await tx.cashbookEntry.create({ data: {
          entryDate: dateInput(), type: 'OUT', paymentMethod: refundMethod, amount: refundable,
          description: `Customer order advance refund — ${current.orderNumber}`, reference: current.orderNumber,
          customerId: current.customerId, customerOrderId: current.id, syncLedger: false, notes: 'Order cancelled; advance refunded'
        } });
        await tx.customerOrder.update({ where: { id }, data: { refundedAmount: { increment: refundable }, status: 'CANCELLED' } });
      } else await tx.customerOrder.update({ where: { id }, data: { status: 'CANCELLED' } });
      return current;
    });
    redirectWith(res, '/customer-orders', 'message', `${order.orderNumber} cancelled${Number(order.customerAdvance) > 0 ? ' and advance refund recorded in Cashbook.' : '.'}`);
  } catch (error) { redirectWith(res, '/customer-orders', 'error', error.message || 'Could not cancel customer order.'); }
});

/* ── Supplier Purchases (new gold/silver stock) ─────────── */
function supplierText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function supplierPhoneFromInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const phone = normalizePhone(raw);
  if (!validCustomerPhone(phone)) {
    throw new Error('Enter a valid supplier mobile number (10 to 15 digits), or leave it blank.');
  }
  return phone;
}

function supplierNameKey(value) {
  return supplierText(value).toLocaleUpperCase();
}

function comparableSupplierName(value) {
  return supplierNameKey(value).replace(/[^A-Z0-9]/g, '');
}

function supplierNameDistance(left, right) {
  const source = comparableSupplierName(left);
  const target = comparableSupplierName(right);
  if (!source || !target) return Infinity;
  const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    let diagonal = previous[0];
    previous[0] = sourceIndex;
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const above = previous[targetIndex];
      previous[targetIndex] = Math.min(
        previous[targetIndex] + 1,
        previous[targetIndex - 1] + 1,
        diagonal + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[target.length];
}

function looksLikeSupplierTypo(enteredName, savedName) {
  const entered = comparableSupplierName(enteredName);
  const saved = comparableSupplierName(savedName);
  const longest = Math.max(entered.length, saved.length);
  if (entered === saved || Math.min(entered.length, saved.length) < 4) return false;
  return supplierNameDistance(entered, saved) <= Math.max(1, Math.ceil(longest * 0.22));
}

async function similarSupplier(tx, name) {
  const normalized = supplierText(name);
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 3);
  const saved = await tx.supplier.findMany({
    where: { OR: [{ name: { contains: normalized } }, ...tokens.slice(0, 3).map((token) => ({ name: { contains: token } }))] },
    select: { id: true, name: true }, orderBy: { id: 'asc' }
  });
  return saved
    .filter((supplier) => looksLikeSupplierTypo(name, supplier.name))
    .sort((left, right) => supplierNameDistance(name, left.name) - supplierNameDistance(name, right.name))[0] || null;
}

// A supplier is one business contact, even when an earlier entry was saved
// without its phone number.  The old behaviour created a second profile in
// that case, splitting the same supplier's lots and due balance across two
// accounts.  Keep one canonical profile and move both purchases and customer
// orders to it before removing the duplicate records.
async function mergeSupplierRecords(tx, records) {
  const suppliers = records.filter(Boolean);
  if (!suppliers.length) return null;
  const canonical = [...suppliers].sort((left, right) => {
    const leftScore = (left.phone ? 1000000 : 0) + Number(left._count?.purchases || 0) * 1000 + Number(left._count?.customerOrders || 0);
    const rightScore = (right.phone ? 1000000 : 0) + Number(right._count?.purchases || 0) * 1000 + Number(right._count?.customerOrders || 0);
    return rightScore - leftScore || left.id - right.id;
  })[0];
  const duplicates = suppliers.filter((supplier) => supplier.id !== canonical.id);
  if (!duplicates.length) return canonical;

  const preferred = (field) => canonical[field] || suppliers.find((supplier) => supplier[field])?.[field] || null;
  const preferredPhone = preferred('phone');
  // Phone is unique. Release a duplicate's stored phone before assigning it
  // to the canonical profile, so merging cannot violate that database rule.
  if (preferredPhone && canonical.phone !== preferredPhone) {
    await tx.supplier.updateMany({ where: { id: { in: duplicates.map((supplier) => supplier.id) }, phone: preferredPhone }, data: { phone: null } });
  }
  const duplicateIds = duplicates.map((supplier) => supplier.id);
  await tx.supplierPurchase.updateMany({ where: { supplierId: { in: duplicateIds } }, data: { supplierId: canonical.id } });
  await tx.customerOrder.updateMany({ where: { supplierId: { in: duplicateIds } }, data: { supplierId: canonical.id } });
  await tx.supplier.update({ where: { id: canonical.id }, data: {
    phone: preferredPhone,
    email: preferred('email'),
    address: preferred('address'),
    gstin: preferred('gstin'),
    panNumber: preferred('panNumber')
  } });
  await tx.supplier.deleteMany({ where: { id: { in: duplicateIds } } });
  return tx.supplier.findUniqueOrThrow({ where: { id: canonical.id } });
}

async function sameNamedSuppliers(tx, name) {
  const nameKey = supplierNameKey(name);
  if (!nameKey) return [];
  // MySQL's default collation already treats letter case equally. Filtering in
  // JavaScript also handles old records that had accidental extra whitespace.
  const candidates = await tx.supplier.findMany({
    where: { name: { contains: name } },
    include: { _count: { select: { purchases: true, customerOrders: true } } }
  });
  return candidates.filter((supplier) => supplierNameKey(supplier.name) === nameKey);
}

async function resolveSupplier(tx, body) {
  const name = titleCase(supplierText(body.supplierName));
  const phone = supplierPhoneFromInput(body.supplierPhone);
  if (!name) throw new Error('Enter the supplier name.');
  const named = await sameNamedSuppliers(tx, name);
  // Two legally distinct businesses can share a name. If more than one exact
  // name match already has a phone number, require that identifying number
  // instead of silently merging the accounts.
  if (named.length > 1 && !phone && named.some((supplier) => supplier.phone)) {
    throw new Error('More than one supplier has this name. Enter the supplier mobile number so the correct account is selected.');
  }
  const phoneMatch = phone ? await tx.supplier.findUnique({ where: { phone } }) : null;
  if (phoneMatch && supplierNameKey(phoneMatch.name) !== supplierNameKey(name)) {
    throw new Error(`This mobile number already belongs to supplier ${phoneMatch.name}. Open that supplier account instead of creating a second one.`);
  }
  const candidates = [...new Map(named.map((supplier) => [supplier.id, supplier])).values()];
  if (phoneMatch && !candidates.some((supplier) => supplier.id === phoneMatch.id)) candidates.push({ ...phoneMatch, _count: { purchases: 0, customerOrders: 0 } });
  const existing = await mergeSupplierRecords(tx, candidates);
  if (existing) return tx.supplier.update({ where: { id: existing.id }, data: {
    name,
    phone: phone || existing.phone,
    email: supplierText(body.supplierEmail) || existing.email,
    address: supplierText(body.supplierAddress) || existing.address,
    gstin: supplierText(body.supplierGstin).toUpperCase() || existing.gstin,
    panNumber: supplierText(body.supplierPan).toUpperCase() || existing.panNumber
  } });
  if (String(body.confirmDifferentSupplier || '') !== 'yes') {
    const similar = await similarSupplier(tx, name);
    if (similar) {
      throw new Error(`Possible duplicate supplier: "${similar.name}" already exists. Select it from the suggestions, or tick “This is a different supplier” before saving.`);
    }
  }
  return tx.supplier.create({ data: {
    name, phone, email: supplierText(body.supplierEmail) || null,
    address: supplierText(body.supplierAddress) || null,
    gstin: supplierText(body.supplierGstin).toUpperCase() || null,
    panNumber: supplierText(body.supplierPan).toUpperCase() || null
  } });
}

app.post('/suppliers/merge-duplicates', async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const records = await tx.supplier.findMany({
        include: { _count: { select: { purchases: true, customerOrders: true } } },
        orderBy: { id: 'asc' }
      });
      const groups = new Map();
      records.forEach((supplier) => {
        const key = supplierNameKey(supplier.name);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(supplier);
      });
      let profilesMerged = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        await mergeSupplierRecords(tx, group);
        profilesMerged += group.length - 1;
      }
      return profilesMerged;
    });
    redirectWith(res, '/suppliers', 'message', result ? `${result} duplicate supplier profile${result === 1 ? '' : 's'} combined.` : 'No duplicate supplier names were found.');
  } catch (error) {
    redirectWith(res, '/suppliers', 'error', error.message || 'Could not combine duplicate supplier profiles.');
  }
});

app.get('/api/suppliers/search', async (req, res) => {
  try {
    const q = supplierText(req.query.q);
    // A single character is enough to begin useful supplier suggestions in
    // the register and directory search fields. Keep the result capped so
    // this remains a light-weight lookup while the user is typing.
    if (q.length < 1) return res.json({ suppliers: [] });
    const suppliers = await prisma.supplier.findMany({
      where: { OR: [{ name: { contains: q } }, { phone: { contains: q } }, { gstin: { contains: q } }] },
      orderBy: { name: 'asc' }, take: 12
    });
    res.json({ suppliers });
  } catch (error) { res.status(500).json({ error: 'Could not search suppliers.' }); }
});

// Exact mobile lookup used by purchase and customer-order forms.  Keep this
// separate from the fuzzy name search so a complete mobile number can select
// one canonical supplier profile without loading the whole directory.
app.get('/api/suppliers/phone/:phone', async (req, res, next) => {
  try {
    const raw = String(decodeURIComponent(req.params.phone || '')).trim();
    const phone = normalizePhone(raw);
    if (!validCustomerPhone(phone)) return res.json({ found: false, phone: phone || '' });
    const supplier = await prisma.supplier.findUnique({ where: { phone } });
    if (!supplier) return res.json({ found: false, phone });
    res.json({ found: true, supplier: {
      id: supplier.id, name: supplier.name, phone: supplier.phone,
      email: supplier.email, address: supplier.address,
      gstin: supplier.gstin, panNumber: supplier.panNumber
    } });
  } catch (error) { next(error); }
});

// Suppliers are first-class business contacts.  Purchase records retain the
// original supplier link, while this directory gives the counter a clean
// place to see outstanding purchase dues and correct contact details.
app.get('/suppliers', async (req, res, next) => {
  try {
    const q = supplierText(req.query.q);
    const where = q ? { OR: [
      { name: { contains: q } }, { phone: { contains: q } },
      { gstin: { contains: q } }, { panNumber: { contains: q } }
    ] } : {};
    const [totalItems, duplicateRows] = await Promise.all([
      prisma.supplier.count({ where }),
      prisma.$queryRaw`SELECT UPPER(TRIM(\`name\`)) AS supplierKey, COUNT(*) AS entries FROM \`Supplier\` GROUP BY UPPER(TRIM(\`name\`)) HAVING COUNT(*) > 1`
    ]);
    const duplicateSupplierProfiles = duplicateRows.reduce((count, row) => count + Math.max(0, Number(row.entries) - 1), 0);
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const suppliers = await prisma.supplier.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { purchases: { where: { cancelledAt: null } } } } },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    const totals = suppliers.length ? await prisma.supplierPurchase.groupBy({
      by: ['supplierId'], where: { supplierId: { in: suppliers.map((supplier) => supplier.id) }, cancelledAt: null },
      _sum: { totalAmount: true, paid: true }
    }) : [];
    const totalsBySupplier = new Map(totals.map((row) => [row.supplierId, {
      purchased: Number(row._sum.totalAmount || 0), paid: Number(row._sum.paid || 0)
    }]));
    const rows = suppliers.map((supplier) => {
      const total = totalsBySupplier.get(supplier.id) || { purchased: 0, paid: 0 };
      return { ...supplier, purchased: total.purchased, paid: total.paid, due: roundedMoney(Math.max(0, total.purchased - total.paid)) };
    });
    res.render('contacts/suppliers', { title: 'Suppliers', suppliers: rows, q, pagination, duplicateSupplierProfiles });
  } catch (error) { next(error); }
});

app.get('/suppliers/:id', async (req, res, next) => {
  try {
    const supplierId = Number(req.params.id);
    if (!Number.isInteger(supplierId) || supplierId <= 0) throw new Error('Supplier not found.');
    const purchaseWhere = { supplierId, cancelledAt: null };
    const [supplier, purchaseTotals, purchaseCount, paymentCount] = await Promise.all([
      prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }),
      prisma.supplierPurchase.aggregate({ where: purchaseWhere, _count: { _all: true }, _sum: { quantity: true, netWeight: true, totalAmount: true, paid: true } }),
      prisma.supplierPurchase.count({ where: purchaseWhere }),
      prisma.cashbookEntry.count({ where: { supplierPurchase: purchaseWhere } })
    ]);
    const purchasePagination = paginationFor(req, purchaseCount, req.query.page, 50);
    const paymentPagination = paginationFor(req, paymentCount, req.query.paymentPage, 50, 'paymentPage');
    const [purchases, paymentRows] = await Promise.all([
      prisma.supplierPurchase.findMany({
        where: purchaseWhere,
        orderBy: [{ purchaseDate: 'desc' }, { id: 'desc' }],
        skip: (purchasePagination.page - 1) * purchasePagination.pageSize,
        take: purchasePagination.pageSize,
        include: { product: true, cashbookEntries: { orderBy: [{ entryDate: 'desc' }, { id: 'desc' }] } }
      }),
      prisma.cashbookEntry.findMany({
        where: { supplierPurchase: purchaseWhere },
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        skip: (paymentPagination.page - 1) * paymentPagination.pageSize,
        take: paymentPagination.pageSize,
        include: { supplierPurchase: true }
      })
    ]);
    supplier.purchases = purchases;
    supplier.paymentRows = paymentRows;
    const summary = {
      purchaseCount: Number(purchaseTotals._count._all || 0),
      pieces: Number(purchaseTotals._sum.quantity || 0),
      purchased: Number(purchaseTotals._sum.totalAmount || 0),
      paid: Number(purchaseTotals._sum.paid || 0),
      weight: Number(purchaseTotals._sum.netWeight || 0)
    };
    summary.due = roundedMoney(Math.max(0, summary.purchased - summary.paid));
    res.render('contacts/supplier-detail', { title: supplier.name, supplier, summary, purchasePagination, paymentPagination });
  } catch (error) { next(error); }
});

app.post('/suppliers/:id', async (req, res, next) => {
  const supplierId = Number(req.params.id);
  try {
    if (!Number.isInteger(supplierId) || supplierId <= 0) throw new Error('Supplier not found.');
    const name = titleCase(supplierText(req.body.name));
    const phone = supplierPhoneFromInput(req.body.phone);
    if (!name) throw new Error('Enter the supplier name.');
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.supplier.findUniqueOrThrow({
        where: { id: supplierId },
        include: { _count: { select: { purchases: true, customerOrders: true } } }
      });
      const named = await sameNamedSuppliers(tx, name);
      if (named.some((supplier) => supplier.id !== supplierId && supplier.phone) && !phone) {
        throw new Error('More than one supplier has this name. Enter the supplier mobile number so the correct account is selected.');
      }
      const phoneMatch = phone ? await tx.supplier.findUnique({ where: { phone } }) : null;
      if (phoneMatch && phoneMatch.id !== supplierId && supplierNameKey(phoneMatch.name) !== supplierNameKey(name)) {
        throw new Error(`This mobile number already belongs to supplier ${phoneMatch.name}.`);
      }
      const candidates = [...new Map([...named, current].map((supplier) => [supplier.id, supplier])).values()];
      if (phoneMatch && !candidates.some((supplier) => supplier.id === phoneMatch.id)) candidates.push({ ...phoneMatch, _count: { purchases: 0, customerOrders: 0 } });
      const canonical = await mergeSupplierRecords(tx, candidates);
      return tx.supplier.update({ where: { id: canonical.id }, data: {
        name, phone,
        email: supplierText(req.body.email) || null,
        address: supplierText(req.body.address) || null,
        gstin: supplierText(req.body.gstin).toUpperCase() || null,
        panNumber: supplierText(req.body.panNumber).toUpperCase() || null
      } });
    });
    redirectWith(res, `/suppliers/${updated.id}`, 'message', 'Supplier details updated.');
  } catch (error) {
    if (error.code === 'P2002') return redirectWith(res, `/suppliers/${supplierId}`, 'error', 'That supplier mobile number is already used by another supplier.');
    redirectWith(res, `/suppliers/${supplierId}`, 'error', error.message || 'Could not update supplier details.');
  }
});

app.get('/purchases', async (req, res, next) => {
  try {
    const q = supplierText(req.query.q);
    const state = String(req.query.state || 'ACTIVE').toUpperCase() === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE';
    const metal = ['GOLD', 'SILVER'].includes(String(req.query.metal || '').toUpperCase()) ? String(req.query.metal).toUpperCase() : 'ALL';
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : '';
    const minDueValue = Number(req.query.minDue);
    const maxDueValue = Number(req.query.maxDue);
    const minDue = Number.isFinite(minDueValue) && minDueValue >= 0 ? roundedMoney(minDueValue) : null;
    const maxDue = Number.isFinite(maxDueValue) && maxDueValue >= 0 ? roundedMoney(maxDueValue) : null;
    let paymentStatus = ['PENDING', 'PAID'].includes(String(req.query.paymentStatus || '').toUpperCase())
      ? String(req.query.paymentStatus).toUpperCase()
      : 'ALL';
    if (state !== 'ACTIVE') paymentStatus = 'ALL';
    const where = state === 'CANCELLED' ? { cancelledAt: { not: null } } : { cancelledAt: null };
    if (metal !== 'ALL') where.metal = metal;
    if (from || to) {
      const range = localDateTimeRange(from || to, to || from);
      where.purchaseDate = { ...(from ? { gte: range.gte } : {}), ...(to ? { lte: range.lte } : {}) };
    }
    // Use MySQL field references rather than filtering after pagination. This
    // keeps the pending-payment register correct and fast with years of
    // supplier purchase records.
    if (state === 'ACTIVE' && paymentStatus === 'PENDING') {
      where.paid = { lt: prisma.supplierPurchase.fields.totalAmount };
    } else if (state === 'ACTIVE' && paymentStatus === 'PAID') {
      where.paid = { gte: prisma.supplierPurchase.fields.totalAmount };
    }
    if (q) {
      const metalMatch = ['GOLD', 'SILVER'].includes(q.toUpperCase()) ? [{ metal: q.toUpperCase() }] : [];
      where.OR = [
      { purchaseNumber: { contains: q } }, { itemName: { contains: q } }, { category: { contains: q } },
      { supplier: { name: { contains: q } } }, { supplier: { phone: { contains: q } } }, ...metalMatch
      ];
    }
    if (minDue !== null || maxDue !== null) {
      const lower = minDue === null ? 0 : minDue;
      const upper = maxDue === null ? 999999999999 : maxDue;
      const cancelledPredicate = state === 'CANCELLED' ? Prisma.sql`cancelledAt IS NOT NULL` : Prisma.sql`cancelledAt IS NULL`;
      const dueRows = await prisma.$queryRaw`SELECT id FROM \`SupplierPurchase\` WHERE ${cancelledPredicate} AND (totalAmount - paid) >= ${lower} AND (totalAmount - paid) <= ${upper}`;
      const dueIds = dueRows.map((row) => Number(row.id)).filter((value) => Number.isInteger(value));
      where.id = { in: dueIds };
    }
    const totalItems = await prisma.supplierPurchase.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const purchases = await prisma.supplierPurchase.findMany({
      where, include: { supplier: true, product: true, cashbookEntries: { orderBy: [{ entryDate: 'asc' }, { id: 'asc' }] } }, orderBy: [{ purchaseDate: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize
    });
    res.render('purchases/index', { title: 'Purchase register', purchases, q, state, paymentStatus, metal, from, to, minDue, maxDue, pagination });
  } catch (error) { next(error); }
});

app.get('/purchases/new', async (req, res, next) => {
  try {
    const rateInfo = await getRateForDate(prisma, dateInput());
    res.render('purchases/form', { title: 'New supplier purchase', rateInfo, purchaseNumber: '', purchase: null, isEdit: false });
  } catch (error) { next(error); }
});

app.post('/purchases', async (req, res, next) => {
  try {
    const metal = ['GOLD', 'SILVER'].includes(String(req.body.metal || '').toUpperCase()) ? String(req.body.metal).toUpperCase() : null;
    const netWeight = number(req.body.netWeight);
    const grossWeight = number(req.body.grossWeight);
    const stoneWeight = number(req.body.stoneWeight);
    const quantity = Math.floor(number(req.body.quantity));
    const ratePerGram = roundedMoney(number(req.body.ratePerGram));
    const totalAmount = roundedMoney(number(req.body.totalAmount));
    const paid = roundedMoney(Math.max(0, number(req.body.paid)));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    const itemName = titleCase(req.body.itemName);
    const category = titleCase(req.body.category);
    if (!metal) throw new Error('Choose Gold or Silver.');
    if (!itemName || !category) throw new Error('Enter item name and category.');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Enter the number of pieces received.');
    if (netWeight <= 0) throw new Error('Net weight must be greater than zero.');
    if (ratePerGram <= 0) throw new Error('Enter a valid purchase rate per gram.');
    if (totalAmount <= 0) throw new Error('Enter a valid purchase amount.');
    if (paid > totalAmount) throw new Error('Amount paid cannot exceed the purchase amount.');
    const purchaseDate = dateTimeFromInput(req.body.purchaseDate);
    const businessSettings = await getBusinessSettings(prisma);
    const purchase = await prisma.$transaction(async (tx) => {
      const supplier = await resolveSupplier(tx, req.body);
      const purity = supplierText(req.body.purity).toUpperCase() || null;
      const record = await tx.supplierPurchase.create({ data: {
        purchaseNumber: await nextDocumentNumber(tx, 'PR', purchaseDate, { financialYearStartMonth: businessSettings.financialYearStartMonth }), supplierId: supplier.id, quantity,
        purchaseDate, metal, purity, itemName, category, grossWeight: grossWeight || netWeight, stoneWeight, netWeight,
        ratePerGram, totalAmount, paid, paymentMethod,
        reference: supplierText(req.body.reference).toUpperCase() || null, notes: supplierText(req.body.notes).toUpperCase() || null
      } });
      await upsertItemName(tx, itemName, category, { updateCategory: false });
      if (paid > 0) await tx.cashbookEntry.create({ data: {
        entryDate: dateInput(record.purchaseDate), type: 'OUT', paymentMethod, amount: paid,
        description: `Supplier purchase — ${record.purchaseNumber}`, reference: record.reference || record.purchaseNumber,
        supplierPurchaseId: record.id, syncLedger: false, notes: record.notes
      } });
      return record;
    });
    const nextPath = String(req.body.action || '') === 'save-add' ? '/purchases/new' : '/purchases';
    redirectWith(res, nextPath, 'message', `Purchase ${purchase.purchaseNumber} saved. Add ${quantity} individual pieces with Batch Add Pieces to create their barcodes.`);
  } catch (error) { redirectWith(res, '/purchases/new', 'error', error.message || 'Could not save supplier purchase.'); }
});

app.get('/purchases/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Purchase not found.');
    const purchase = await prisma.supplierPurchase.findFirstOrThrow({
      where: { id, cancelledAt: null }, include: { supplier: true, product: true }
    });
    const rateInfo = await getRateForDate(prisma, dateInput(purchase.purchaseDate));
    res.render('purchases/form', { title: `Edit ${purchase.purchaseNumber}`, rateInfo, purchaseNumber: purchase.purchaseNumber, purchase, isEdit: true });
  } catch (error) { next(error); }
});

app.post('/purchases/:id/edit', async (req, res) => {
  const id = Number(req.params.id);
  try {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Purchase not found.');
    const metal = ['GOLD', 'SILVER'].includes(String(req.body.metal || '').toUpperCase()) ? String(req.body.metal).toUpperCase() : null;
    const netWeight = number(req.body.netWeight);
    const grossWeight = number(req.body.grossWeight);
    const stoneWeight = number(req.body.stoneWeight);
    const quantity = Math.floor(number(req.body.quantity));
    const ratePerGram = roundedMoney(number(req.body.ratePerGram));
    const totalAmount = roundedMoney(number(req.body.totalAmount));
    const itemName = titleCase(req.body.itemName);
    const category = titleCase(req.body.category);
    if (!metal) throw new Error('Choose Gold or Silver.');
    if (!itemName || !category) throw new Error('Enter item name and category.');
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Enter the number of pieces received.');
    if (netWeight <= 0) throw new Error('Net weight must be greater than zero.');
    if (ratePerGram <= 0 || totalAmount <= 0) throw new Error('Enter a valid rate and purchase amount.');
    const purchaseDate = dateTimeFromInput(req.body.purchaseDate);
    const updated = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`SupplierPurchase\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('Purchase not found.');
      const current = await tx.supplierPurchase.findFirstOrThrow({
        where: { id, cancelledAt: null }, include: {
          product: true,
          cashbookEntries: { select: { id: true, amount: true, description: true } }
        }
      });
      const paidFromCashbook = roundedMoney(current.cashbookEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
      const recordedPaid = roundedMoney(Math.max(Number(current.paid || 0), paidFromCashbook));
      if (totalAmount < recordedPaid) throw new Error(`Purchase amount cannot be less than the recorded payments of ${money(recordedPaid)}.`);
      // A legacy purchase may point directly at one inventory row. Do not let
      // editing its lot metadata silently disagree with that stock record.
      if (current.product) {
        const sameLot = current.metal === metal && current.itemName === itemName && current.category === category
          && String(current.purity || '') === String(supplierText(req.body.purity).toUpperCase() || '')
          && Number(current.quantity) === quantity
          && Number(current.grossWeight) === (grossWeight || netWeight)
          && Number(current.stoneWeight) === stoneWeight
          && Number(current.netWeight) === netWeight;
        if (!sameLot) throw new Error('This purchase is linked to inventory. Its item, metal, purity, pieces and weights cannot be changed after stock was linked. Edit only the supplier, date, amount or reference.');
      }
      const supplier = await resolveSupplier(tx, req.body);
      const record = await tx.supplierPurchase.update({ where: { id }, data: {
        supplierId: supplier.id, purchaseDate, metal, purity: supplierText(req.body.purity).toUpperCase() || null,
        itemName, category, quantity, grossWeight: grossWeight || netWeight, stoneWeight, netWeight,
        ratePerGram, totalAmount, paid: recordedPaid,
        reference: supplierText(req.body.reference).toUpperCase() || null,
        notes: supplierText(req.body.notes).toUpperCase() || null
      } });
      // The initial payment created with the purchase represents the purchase
      // itself. Keep its date, reference and note aligned when the purchase is
      // edited, but leave later supplier-payment entries untouched because
      // those have their own payment dates and references.
      const purchaseEntry = current.cashbookEntries.find((entry) => {
        const description = String(entry.description || '');
        return description === `Supplier purchase — ${current.purchaseNumber}`
          || /^Supplier purchase\s*[—-]/i.test(description);
      });
      if (purchaseEntry) {
        await tx.cashbookEntry.update({
          where: { id: purchaseEntry.id },
          data: {
            entryDate: dateInput(record.purchaseDate),
            description: `Supplier purchase — ${record.purchaseNumber}`,
            reference: record.reference || record.purchaseNumber,
            notes: record.notes
          }
        });
      }
      await upsertItemName(tx, itemName, category, { updateCategory: false });
      return record;
    });
    redirectWith(res, '/purchases', 'message', `${updated.purchaseNumber} updated. Supplier balance and linked payments remain synchronized.`);
  } catch (error) { redirectWith(res, `/purchases/${id}/edit`, 'error', error.message || 'Could not update supplier purchase.'); }
});

app.post('/purchases/:id/payments', async (req, res) => {
  try {
    const id = Number(req.params.id); const amount = roundedMoney(number(req.body.amount)); const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (!Number.isInteger(id) || id <= 0 || amount <= 0) throw new Error('Enter a valid payment amount.');
    const record = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`SupplierPurchase\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('This purchase no longer exists.');
      const purchase = await tx.supplierPurchase.findFirstOrThrow({ where: { id, cancelledAt: null } });
      const due = roundedMoney(Number(purchase.totalAmount) - Number(purchase.paid));
      if (amount > due) throw new Error(`Payment is greater than the outstanding amount of ${money(due)}.`);
      const updated = await tx.supplierPurchase.update({ where: { id }, data: { paid: { increment: amount }, paymentMethod: Number(purchase.paid) <= 0 || purchase.paymentMethod === paymentMethod ? paymentMethod : 'MIXED' } });
      await tx.cashbookEntry.create({ data: { entryDate: dateInput(dateTimeFromInput(req.body.entryDate)), type: 'OUT', paymentMethod, amount, description: `Supplier payment — ${purchase.purchaseNumber}`, reference: supplierText(req.body.reference) || purchase.purchaseNumber, supplierPurchaseId: purchase.id, syncLedger: false, notes: supplierText(req.body.notes) || null } });
      return updated;
    });
    redirectWith(res, '/purchases', 'message', `Supplier payment of ${money(amount)} recorded.`);
  } catch (error) { redirectWith(res, '/purchases', 'error', error.message || 'Could not record supplier payment.'); }
});

// Supplier payment corrections are an update, not a second receipt. Rebuild
// the paid total from its Cashbook rows inside the same transaction so the
// due, Cashbook and Supplier account cannot drift apart.
app.post('/purchases/:id/payments/:entryId', async (req, res) => {
  try {
    const purchaseId = Number(req.params.id);
    const entryId = Number(req.params.entryId);
    const amount = roundedMoney(number(req.body.amount));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (!Number.isInteger(purchaseId) || !Number.isInteger(entryId) || purchaseId <= 0 || entryId <= 0 || amount <= 0) throw new Error('Enter a valid payment amount.');
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`SupplierPurchase\` WHERE id = ${purchaseId} FOR UPDATE`;
      if (!locked.length) throw new Error('This purchase no longer exists.');
      const purchase = await tx.supplierPurchase.findFirstOrThrow({ where: { id: purchaseId, cancelledAt: null } });
      const entry = await tx.cashbookEntry.findFirstOrThrow({ where: { id: entryId, supplierPurchaseId: purchaseId } });
      const nextPaid = roundedMoney(Number(purchase.paid) - Number(entry.amount) + amount);
      if (nextPaid < 0 || nextPaid > Number(purchase.totalAmount)) throw new Error(`Payment total must stay between ₹0.00 and ${money(purchase.totalAmount)}.`);
      const submittedEntryDate = String(req.body.entryDate ?? '').trim();
      await tx.cashbookEntry.update({ where: { id: entry.id }, data: {
        entryDate: submittedEntryDate ? dateInput(dateTimeFromInput(submittedEntryDate)) : entry.entryDate, amount, paymentMethod,
        reference: supplierText(req.body.reference) || purchase.purchaseNumber,
        notes: supplierText(req.body.notes) || null
      } });
      const payments = await tx.cashbookEntry.findMany({ where: { supplierPurchaseId: purchaseId }, select: { amount: true, paymentMethod: true } });
      const paid = roundedMoney(payments.reduce((sum, payment) => sum + Number(payment.amount), 0));
      const methods = [...new Set(payments.filter((payment) => Number(payment.amount) > 0).map((payment) => payment.paymentMethod))];
      await tx.supplierPurchase.update({ where: { id: purchaseId }, data: {
        paid, paymentMethod: paid <= 0 ? 'CREDIT' : methods.length === 1 ? methods[0] : 'MIXED'
      } });
    });
    redirectWith(res, '/purchases', 'message', 'Supplier payment updated in Purchase Register and Cashbook.');
  } catch (error) { redirectWith(res, '/purchases', 'error', error.message || 'Could not update supplier payment.'); }
});

app.post('/purchases/:id/payments/:entryId/delete', async (req, res) => {
  try {
    const purchaseId = Number(req.params.id);
    const entryId = Number(req.params.entryId);
    if (!Number.isInteger(purchaseId) || !Number.isInteger(entryId) || purchaseId <= 0 || entryId <= 0) throw new Error('Payment not found.');
    await prisma.$transaction(async (tx) => {
      const entry = await tx.cashbookEntry.findFirst({ where: { id: entryId, supplierPurchaseId: purchaseId }, select: { id: true } });
      if (!entry) throw new Error('Payment not found for this purchase.');
      await reverseAndDeleteCashbookEntry(tx, entry.id);
    });
    redirectWith(res, '/purchases', 'message', 'Supplier payment cancelled. Purchase balance and Cashbook were updated.');
  } catch (error) { redirectWith(res, '/purchases', 'error', error.message || 'Could not cancel supplier payment.'); }
});

app.post('/purchases/:id/delete', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cancelReason = supplierText(req.body.cancelReason);
    if (!cancelReason) throw new Error('Enter a cancellation reason.');
    const record = await prisma.$transaction(async (tx) => {
      const purchase = await tx.supplierPurchase.findFirstOrThrow({ where: { id, cancelledAt: null }, include: { product: true } });
      // Purchases entered before lot receiving created one linked inventory item.
      // Preserve that legacy safety rule. New lot purchases deliberately have no
      // product link: their separately barcode-labelled items remain independent.
       if (purchase.product && Number(purchase.product.quantity || 0) <= 0) throw new Error('The linked legacy inventory item has already been sold or removed. This purchase cannot be cancelled safely.');
      await tx.cashbookEntry.deleteMany({ where: { supplierPurchaseId: purchase.id } });
      if (purchase.product) {
        await tx.stockMovement.create({ data: stockMovementSnapshot(purchase.product, 'ADJUSTMENT_OUT', -purchase.product.quantity, `Supplier purchase cancelled · ${purchase.purchaseNumber}`) });
        // Inventory is represented by positive quantity. Keep the legacy
        // product row for audit relations, but make it unavailable without a
        // second status value that the ERP no longer uses.
        await tx.product.update({ where: { id: purchase.product.id }, data: { quantity: 0, status: 'AVAILABLE' } });
      }
      return tx.supplierPurchase.update({ where: { id }, data: {
        cancelledAt: new Date(),
        notes: [purchase.notes, `Cancelled: ${cancelReason}`].filter(Boolean).join(' · ')
      } });
    });
    redirectWith(res, '/purchases', 'message', `${record.purchaseNumber} cancelled. Linked cashbook payouts were reversed; separately barcode-labelled inventory items were left unchanged.`);
  } catch (error) { redirectWith(res, '/purchases', 'error', error.message || 'Could not cancel supplier purchase.'); }
});

/* ── URD Purchases (old gold/silver from customers) ────── */
app.get('/urd-purchases', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const state = String(req.query.state || 'ACTIVE').toUpperCase() === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE';
    const where = state === 'CANCELLED' ? { cancelledAt: { not: null } } : { cancelledAt: null };
    if (q) {
      const metalMatch = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'].includes(q.toUpperCase())
        ? [{ metal: q.toUpperCase() }]
        : [];
      where.OR = [
        { purchaseNumber: { contains: q } },
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: q } } },
        { description: { contains: q } },
        ...metalMatch
      ];
    }
    const totalItems = await prisma.urdPurchase.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const purchases = await prisma.urdPurchase.findMany({
      where,
      // Keep a compact item list available for the register so a multi-item
      // URD receipt is identifiable without loading any payment history.
      include: { customer: true, items: { orderBy: { id: 'asc' }, select: { id: true, description: true, metal: true, purity: true, netWeight: true } } },
      orderBy: { purchaseDate: 'desc' },
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.render('urd-purchases/index', { title: 'URD Purchases', purchases, q, state, pagination });
  } catch (error) { next(error); }
});

app.get('/urd-purchases/new', async (req, res, next) => {
  try {
    const rateInfo = await getRateForDate(prisma, dateInput());
    // The final number is assigned only when the purchase is committed.
    res.render('urd-purchases/form', { title: 'New URD purchase', customers: [], rateInfo, purchaseNumber: '', purchase: null });
  } catch (error) { next(error); }
});

app.post('/urd-purchases', async (req, res, next) => {
  try {
    let customerId = Number(req.body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      // A URD purchase can create a customer in the same way as billing.  A
      // mobile number is optional; when supplied it is used for an exact
      // lookup first, otherwise the entered name creates a new profile.
      if (req.body.customerPhone || req.body.customerName) {
        const cust = await resolveBillingCustomer(prisma, req.body);
        customerId = cust.id;
      } else {
        return redirectWith(res, '/urd-purchases/new', 'error', 'Enter the customer name, or select an existing customer.');
      }
    }
    const itemRows = urdRows(req.body);
    if (!itemRows.length) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter at least one old-jewellery item.');
    for (const item of itemRows) {
      if (item.netWeight <= 0) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter a net weight greater than zero for every URD item.');
      if (item.ratePerGram <= 0) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter a rate per gram greater than zero for every URD item.');
      if (item.totalAmount <= 0) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter a valuation amount greater than zero for every URD item.');
    }
    const grossWeight = Number(itemRows.reduce((sum, item) => sum + Math.max(0, item.grossWeight), 0).toFixed(3));
    const netWeight = Number(itemRows.reduce((sum, item) => sum + item.netWeight, 0).toFixed(3));
    const totalAmount = roundedMoney(itemRows.reduce((sum, item) => sum + item.totalAmount, 0));
    const ratePerGram = roundedMoney(totalAmount / netWeight);
    const itemMetals = new Set(itemRows.map((item) => item.metal));
    const metal = itemMetals.size === 1 ? itemRows[0].metal : 'OTHER';
    const itemPurities = new Set(itemRows.map((item) => item.purity).filter(Boolean));
    const purity = itemPurities.size === 1 ? [...itemPurities][0] : null;
    const description = itemRows.map((item) => item.description).filter(Boolean).join(' · ') || null;
    const paid = roundedMoney(Math.max(0, number(req.body.paid)));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (netWeight <= 0) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter a net weight greater than zero.');
    if (ratePerGram <= 0) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter a rate per gram greater than zero.');
    if (totalAmount <= 0) return redirectWith(res, '/urd-purchases/new', 'error', 'Enter a valuation amount greater than zero.');
    if (paid > totalAmount) return redirectWith(res, '/urd-purchases/new', 'error', `Payout is greater than the valuation amount of ${money(totalAmount)}.`);
    const purchaseDate = dateTimeFromInput(req.body.purchaseDate);
    const businessSettings = await getBusinessSettings(prisma);
    const purchase = await prisma.$transaction(async (tx) => {
      const record = await tx.urdPurchase.create({
        data: {
          purchaseNumber: await nextDocumentNumber(tx, 'UR', purchaseDate, { financialYearStartMonth: businessSettings.financialYearStartMonth }),
          customerId,
          purchaseDate,
          metal, purity, grossWeight, netWeight, ratePerGram,
          totalAmount, paid, paymentMethod, description,
          notes: req.body.notes ? String(req.body.notes).trim().toUpperCase() : null,
          items: { create: itemRows.map((item) => ({
            description: item.description,
            metal: item.metal,
            purity: item.purity,
            grossWeight: item.grossWeight,
            netWeight: item.netWeight,
            ratePerGram: item.ratePerGram,
            totalAmount: item.totalAmount
          })) }
        }
      });
      if (paid > 0) {
        await tx.cashbookEntry.create({ data: {
          entryDate: dateInput(record.purchaseDate), type: 'OUT', paymentMethod,
          description: `URD purchase — ${record.purchaseNumber}`, amount: paid, reference: record.purchaseNumber,
          customerId: record.customerId, urdPurchaseId: record.id, syncLedger: false, notes: req.body.notes || null
        } });
      }
      return record;
    });
    redirectWith(res, '/urd-purchases', 'message', `URD Purchase ${purchase.purchaseNumber} saved.`);
  } catch (error) { next(error); }
});

app.post('/urd-purchases/:id/payments', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const amount = roundedMoney(number(req.body.amount));
    const paymentMethod = receiptPaymentMethod(req.body.paymentMethod);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid URD purchase.');
    if (amount <= 0) throw new Error('Enter a payout amount greater than zero.');
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT id FROM \`UrdPurchase\` WHERE id = ${id} FOR UPDATE`;
      if (!locked.length) throw new Error('This URD purchase no longer exists.');
      const purchase = await tx.urdPurchase.findFirstOrThrow({ where: { id, cancelledAt: null } });
      const outstanding = roundedMoney(Math.max(0, Number(purchase.totalAmount) - Number(purchase.saleOffset) - Number(purchase.paid)));
      if (outstanding <= 0) throw new Error('This URD purchase is already fully paid or settled.');
      if (amount > outstanding) throw new Error(`Payout is greater than the outstanding amount of ${money(outstanding)}.`);
      const reference = req.body.reference?.trim() || generatedReference(`${purchase.purchaseNumber}-PAY`);
      const nextMethod = Number(purchase.paid) <= 0 || purchase.paymentMethod === paymentMethod
        ? paymentMethod
        : 'MIXED';
      const updated = await tx.urdPurchase.update({
        where: { id },
        data: { paid: { increment: amount }, paymentMethod: nextMethod }
      });
      await tx.cashbookEntry.create({
        data: {
          entryDate: dateInput(dateTimeFromInput(req.body.entryDate)),
          type: 'OUT',
          paymentMethod,
          amount,
          description: `URD payout — ${purchase.purchaseNumber}`,
          reference,
          customerId: purchase.customerId,
          urdPurchaseId: purchase.id,
          syncLedger: false,
          notes: req.body.notes || null
        }
      });
      return updated;
    });
    redirectWith(res, '/urd-purchases', 'message', `URD payout of ${money(amount)} recorded.`);
  } catch (error) {
    redirectWith(res, '/urd-purchases', 'error', error.message || 'Could not record the URD payout.');
  }
});

app.get('/urd-purchases/:id/invoice.pdf', async (req, res, next) => {
  try {
    const [purchase, businessSettings] = await Promise.all([
      prisma.urdPurchase.findUnique({
        where: { id: Number(req.params.id), cancelledAt: null },
        include: { customer: true, sale: true, items: { orderBy: { id: 'asc' } }, cashbookEntries: { orderBy: { id: 'asc' }, take: 1 } }
      }),
      getBusinessSettings(prisma)
    ]);
    if (!purchase) return res.status(404).render('not-found', { title: 'URD invoice not found' });
    await writeUrdPurchaseInvoice(res, purchase, businessSettings);
  } catch (error) { next(error); }
});

app.post('/urd-purchases/:id/delete', async (req, res, next) => {
  try {
    const purchase = await prisma.$transaction((tx) => cancelUrdPurchase(tx, Number(req.params.id)));
    redirectWith(res, '/urd-purchases', 'message', `${purchase.purchaseNumber} cancelled and its linked payouts reversed.`);
  } catch (error) {
    redirectWith(res, '/urd-purchases', 'error', error.message || 'Could not delete this URD purchase.');
  }
});

const REPORT_METALS = ['GOLD', 'SILVER', 'PLATINUM', 'DIAMOND', 'OTHER'];
const REPORT_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'MIXED'];
const REPORT_MOVEMENT_TYPES = ['OPENING', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'];

function reportDates(query) {
  const today = dateInput();
  const fromKey = String(query.from || `${today.slice(0, 7)}-01`);
  const toKey = String(query.to || today);
  const range = localDateTimeRange(fromKey, toKey);
  return { fromKey, toKey, ...range };
}

function reportText(value) {
  return String(value || '').trim();
}

app.get('/reports', (req, res) => {
  res.render('reports/index', { title: 'Reports' });
});

app.get('/reports/stock', async (req, res, next) => {
  try {
    const itemName = reportText(req.query.itemName || req.query.q);
    const weight = reportText(req.query.weight);
    const barcode = reportText(req.query.barcode);
    const metal = REPORT_METALS.includes(String(req.query.metal || '').toUpperCase()) ? String(req.query.metal).toUpperCase() : '';
    const category = reportText(req.query.category);
    const location = reportText(req.query.location);
    const fromKey = req.query.from ? String(req.query.from).trim() : '';
    const toKey = req.query.to ? String(req.query.to).trim() : '';
    let dateRangeFilter = {};
    if (fromKey || toKey) {
      const f = fromKey || '2000-01-01';
      const t = toKey || dateInput();
      dateRangeFilter = { createdAt: localDateTimeRange(f, t) };
    }
    const stockWhere = {
      AND: [
        { quantity: { gt: 0 }, status: 'AVAILABLE' },
        ...(Object.keys(dateRangeFilter).length ? [dateRangeFilter] : []),
        ...(metal ? [{ metal }] : []),
        ...(category ? [{ category: { contains: category } }] : []),
        ...(location ? [{ location: { contains: location } }] : []),
        ...productSearchClauses({ itemName, weight, barcode })
      ]
    };
    const [totalItems, stockTotals] = await Promise.all([
      prisma.product.count({ where: stockWhere }),
      prisma.product.aggregate({ where: stockWhere, _sum: { quantity: true, grossWeight: true, netWeight: true } })
    ]);
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const products = await prisma.product.findMany({
      where: stockWhere,
      select: { id: true, barcode: true, name: true, category: true, metal: true, purity: true, grossWeight: true, netWeight: true, quantity: true, location: true, createdAt: true },
      orderBy: [{ metal: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    const summary = {
      pieces: Number(stockTotals._sum.quantity || 0),
      grossWeight: Number(stockTotals._sum.grossWeight || 0),
      netWeight: Number(stockTotals._sum.netWeight || 0)
    };
    res.render('reports/stock', { title: 'Stock report', products, pagination, summary, filters: { itemName, weight, barcode, metal, category, location, from: fromKey, to: toKey } });
  } catch (error) { next(error); }
});

app.get('/reports/stock-movements', async (req, res, next) => {
  try {
    const { fromKey, toKey, gte: from, lte: to } = reportDates(req.query);
    const q = reportText(req.query.q);
    const metal = REPORT_METALS.includes(String(req.query.metal || '').toUpperCase()) ? String(req.query.metal).toUpperCase() : '';
    const type = REPORT_MOVEMENT_TYPES.includes(String(req.query.type || '').toUpperCase()) ? String(req.query.type).toUpperCase() : '';
    const movementWhere = {
      createdAt: { gte: from, lte: to },
      ...(metal ? { productMetal: metal } : {}),
      ...(type ? { type } : {}),
      ...(q ? { OR: [
        { productBarcode: { contains: q } }, { productName: { contains: q } },
        { productPurity: { contains: q } }, { note: { contains: q } },
        { product: { barcode: { contains: q } } }, { product: { sku: { contains: q } } },
        { product: { name: { contains: q } } }, { product: { purity: { contains: q } } }
      ] } : {})
    };
    // Keep movement totals independent of pagination. The register displays
    // the absolute quantity/weight affected by each movement, so aggregate
    // those same values across every row matching the active filters.
    const movementLike = q ? `%${q}%` : null;
    const movementSummaryRows = await prisma.$queryRaw`
      SELECT
        COALESCE(SUM(ABS(sm.quantity)), 0) AS pieces,
        COALESCE(SUM(ABS(sm.netWeight * sm.quantity)), 0) AS netWeight
      FROM \`StockMovement\` sm
      LEFT JOIN \`Product\` p ON p.id = sm.productId
      WHERE sm.createdAt >= ${from} AND sm.createdAt <= ${to}
        ${metal ? Prisma.sql`AND sm.productMetal = ${metal}` : Prisma.empty}
        ${type ? Prisma.sql`AND sm.type = ${type}` : Prisma.empty}
        ${movementLike ? Prisma.sql`AND (
          sm.productBarcode LIKE ${movementLike}
          OR sm.productName LIKE ${movementLike}
          OR sm.productPurity LIKE ${movementLike}
          OR sm.note LIKE ${movementLike}
          OR p.barcode LIKE ${movementLike}
          OR p.sku LIKE ${movementLike}
          OR p.name LIKE ${movementLike}
          OR p.purity LIKE ${movementLike}
        )` : Prisma.empty}
    `;
    const totalItems = await prisma.stockMovement.count({ where: movementWhere });
    const pagination = paginationFor(req, totalItems, req.query.page, 200);
    const movementRows = await prisma.stockMovement.findMany({
      where: movementWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize,
      include: { product: true }
    });
    const movements = movementRows.map((movement) => {
      const currentProduct = Number(movement.product?.quantity || 0) > 0
        ? movement.product
        : null;
      return {
        ...movement,
        productBarcode: currentProduct?.barcode || movement.productBarcode,
        productSku: currentProduct?.sku || movement.productSku,
        productName: currentProduct?.name || movement.productName,
        productMetal: currentProduct?.metal || movement.productMetal,
        productPurity: currentProduct?.purity || movement.productPurity,
        netWeight: currentProduct?.netWeight ?? movement.netWeight
      };
    });
    const movementTotals = movementSummaryRows?.[0] || {};
    const summary = {
      movementCount: totalItems,
      pieces: Number(movementTotals.pieces || 0),
      netWeight: Number(movementTotals.netWeight || 0)
    };
    res.render('reports/stock-movements', {
      title: 'Stock movement report', movements, pagination, summary,
      filters: { from: fromKey, to: toKey, q, metal, type }
    });
  } catch (error) { next(error); }
});

app.get('/reports/balance-register', async (req, res, next) => {
  try {
    const q = reportText(req.query.q);
    const state = ['ALL', 'DUE', 'SETTLED'].includes(String(req.query.state || 'DUE').toUpperCase())
      ? String(req.query.state || 'DUE').toUpperCase()
      : 'DUE';
    const fromKey = req.query.from ? String(req.query.from).trim() : '';
    const toKey = req.query.to ? String(req.query.to).trim() : '';
    
    let dateJoinClause = Prisma.empty;
    if (fromKey || toKey) {
      const f = fromKey || '2000-01-01';
      const t = toKey || dateInput();
      localDateTimeRange(f, t); // validate the user-entered range; ledger dates are stored as YYYY-MM-DD strings
      dateJoinClause = Prisma.sql`AND l.entryDate >= ${f} AND l.entryDate <= ${t}`;
    }

    const like = `%${q}%`;
    const searchClause = q
      ? Prisma.sql`WHERE (c.name LIKE ${like} OR c.phone LIKE ${like})`
      : Prisma.empty;
    const balanceClause = state === 'DUE'
      ? Prisma.sql`HAVING balance > 0.005`
      : state === 'SETTLED'
        ? Prisma.sql`HAVING balance <= 0.005 AND balance >= -0.005`
        : Prisma.empty;
    const countRows = await prisma.$queryRaw`
      SELECT COUNT(*) AS total FROM (
        SELECT c.id, COALESCE(SUM(l.amount), 0) AS balance
        FROM \`Customer\` c
        LEFT JOIN \`CustomerLedger\` l ON l.customerId = c.id ${dateJoinClause}
        ${searchClause}
        GROUP BY c.id
        ${balanceClause}
      ) AS balance_rows
    `;
    const totalItems = Number(countRows[0]?.total || 0);
    const summaryRows = await prisma.$queryRaw`
      SELECT
        COUNT(*) AS customerCount,
        COALESCE(SUM(balance), 0) AS totalBalance,
        COALESCE(SUM(CASE WHEN balance > 0.005 THEN balance ELSE 0 END), 0) AS totalDue
      FROM (
        SELECT c.id, COALESCE(SUM(l.amount), 0) AS balance
        FROM \`Customer\` c
        LEFT JOIN \`CustomerLedger\` l ON l.customerId = c.id ${dateJoinClause}
        ${searchClause}
        GROUP BY c.id
        ${balanceClause}
      ) AS balance_summary
    `;
    const balanceSummaryRow = summaryRows?.[0] || {};
    const summary = {
      customerCount: Number(balanceSummaryRow.customerCount || 0),
      totalBalance: Number(balanceSummaryRow.totalBalance || 0),
      totalDue: Number(balanceSummaryRow.totalDue || 0)
    };
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const rows = await prisma.$queryRaw`
      SELECT
        c.id,
        c.name,
        c.phone,
        COALESCE(SUM(l.amount), 0) AS balance,
        MAX(l.entryDate) AS lastActivity
      FROM \`Customer\` c
      LEFT JOIN \`CustomerLedger\` l ON l.customerId = c.id ${dateJoinClause}
      ${searchClause}
      GROUP BY c.id, c.name, c.phone
      ${balanceClause}
      ORDER BY balance DESC, lastActivity DESC, c.name ASC
      LIMIT ${pagination.pageSize} OFFSET ${(pagination.page - 1) * pagination.pageSize}
    `;
    const customers = rows.map((row) => ({
      id: Number(row.id), name: row.name, phone: row.phone || '', balance: Number(row.balance || 0), lastActivity: row.lastActivity || null
    }));
    res.render('reports/balance-register', { title: 'Balance register', customers, pagination, summary, filters: { q, state, from: fromKey, to: toKey } });
  } catch (error) { next(error); }
});

app.get('/reports/sales-register', async (req, res, next) => {
  try {
    const { fromKey, toKey, gte: from, lte: to } = reportDates(req.query);
    const item = reportText(req.query.item);
    const customer = reportText(req.query.customer);
    const invoice = reportText(req.query.invoice);
    const paymentMethod = REPORT_PAYMENT_METHODS.includes(String(req.query.paymentMethod || '').toUpperCase())
      ? String(req.query.paymentMethod).toUpperCase() : '';
    const balanceState = ['ALL', 'DUE', 'SETTLED'].includes(String(req.query.balanceState || 'ALL').toUpperCase())
      ? String(req.query.balanceState).toUpperCase() : 'ALL';
    const recordState = String(req.query.recordState || 'ACTIVE').toUpperCase() === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE';
    const saleWhere = {
      ...(recordState === 'CANCELLED' ? { cancelledAt: { not: null } } : { cancelledAt: null }),
      saleDate: { gte: from, lte: to },
      ...(invoice ? { invoiceNumber: { contains: invoice } } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(balanceState === 'DUE' ? { balance: { gt: 0 } } : {}),
      ...(balanceState === 'SETTLED' ? { balance: { equals: 0 } } : {}),
      ...(customer ? { customer: { is: { OR: [{ name: { contains: customer } }, { phone: { contains: customer } }] } } } : {}),
      ...(item ? { items: { some: { OR: [
        { productName: { contains: item } }, { productBarcode: { contains: item } }, { productSku: { contains: item } }, { productPurity: { contains: item } }
      ] } } } : {})
    };
    const totalItems = await prisma.sale.count({ where: saleWhere });
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const [sales, summary] = await Promise.all([
      prisma.sale.findMany({
        where: saleWhere,
        include: {
          customer: true,
          urdPurchase: true,
          _count: { select: { items: true } },
          items: { select: { productName: true, productBarcode: true, productPurity: true }, take: 3 }
        },
        orderBy: [{ saleDate: 'desc' }, { id: 'desc' }],
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize
      }),
      prisma.sale.aggregate({ where: saleWhere, _sum: { total: true, paid: true, balance: true }, _count: true })
    ]);
    res.render('reports/sales-register', {
      title: 'Sales register', sales, summary, pagination,
      filters: { from: fromKey, to: toKey, item, customer, invoice, paymentMethod, balanceState, recordState }
    });
  } catch (error) { next(error); }
});

app.get('/reports/top-selling-items', async (req, res, next) => {
  try {
    const { fromKey, toKey, gte: from, lte: to } = reportDates(req.query);
    const filters = { ...normalizeTopSellingFilters(req.query), from: fromKey, to: toKey };
    const source = { ...filters, from, to };
    const [totalItems, summary] = await Promise.all([
      countTopSellingItems(prisma, source),
      summarizeTopSellingItems(prisma, source)
    ]);
    const pagination = paginationFor(req, totalItems, req.query.page, 100);
    const rows = await listTopSellingItems(prisma, source, {
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.render('reports/top-selling-items', {
      title: 'Top selling items report', rows, pagination,
      summary, filters
    });
  } catch (error) { next(error); }
});

app.get('/reports/top-selling-items/export', async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    const filters = normalizeTopSellingFilters(req.query);
    const businessSettings = await getBusinessSettings(prisma);
    const payload = await getExportPayload(prisma, 'top-selling-items', range, {
      ...filters,
      shopName: businessSettings.shopName,
      metadata: excelBusinessMetadata(businessSettings)
    });
    const workbook = await buildExcelExport(payload);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
    res.send(workbook);
  } catch (error) {
    const query = new URLSearchParams({
      from: String(req.query.from || ''), to: String(req.query.to || ''),
      metal: String(req.query.metal || ''), item: String(req.query.item || ''),
      sortBy: String(req.query.sortBy || ''), sortOrder: String(req.query.sortOrder || ''),
      error: error.message || 'Could not create the Top Selling Items Excel report.'
    });
    res.redirect(`/reports/top-selling-items?${query.toString()}`);
  }
});

app.get('/reports/cashbook-register', async (req, res, next) => {
  try {
    const { fromKey, toKey } = reportDates(req.query);
    const paymentMethod = RECEIPT_PAYMENT_METHODS.has(String(req.query.paymentMethod || '').toUpperCase()) ? String(req.query.paymentMethod).toUpperCase() : '';
    const type = ['IN', 'OUT'].includes(String(req.query.type || '').toUpperCase()) ? String(req.query.type).toUpperCase() : '';
    const q = reportText(req.query.q);
    const where = { entryDate: { gte: fromKey, lte: toKey }, ...(paymentMethod ? { paymentMethod } : {}), ...(type ? { type } : {}), ...(q ? { OR: [{ description: { contains: q } }, { reference: { contains: q } }, { customer: { is: { name: { contains: q } } } }, { supplierPurchase: { is: { supplier: { is: { name: { contains: q } } } } } }] } : {}) };
    const totalItems = await prisma.cashbookEntry.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 200);
    const [entries, totals] = await Promise.all([
      prisma.cashbookEntry.findMany({ where, include: { customer: true, supplierPurchase: { include: { supplier: true } } }, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize }),
      prisma.cashbookEntry.groupBy({ by: ['type'], where, _sum: { amount: true } })
    ]);
    const summary = { in: 0, out: 0 }; totals.forEach((row) => { summary[row.type === 'IN' ? 'in' : 'out'] = Number(row._sum.amount || 0); });
    res.render('reports/cashbook-register', { title: 'Cashbook register', entries, summary, pagination, filters: { from: fromKey, to: toKey, paymentMethod, type, q } });
  } catch (error) { next(error); }
});

// ── Schemes ─────────────────────────────────────────────────
app.get('/schemes', async (req, res, next) => {
  try {
    const [schemePlans, activePlans, totalEnrollments, activeEnrollments, collected] = await Promise.all([
      prisma.schemePlan.findMany({
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { enrollments: { where: { status: { not: 'CANCELLED' } } } } } }
      }),
      prisma.schemePlan.count({ where: { isActive: true } }),
      prisma.schemeEnrollment.count({ where: { status: { not: 'CANCELLED' } } }),
      prisma.schemeEnrollment.count({ where: { status: 'ACTIVE' } }),
      prisma.schemeEnrollment.aggregate({ where: { status: { not: 'CANCELLED' } }, _sum: { totalPaid: true } })
    ]);
    const schemeStats = {
      activePlans,
      totalEnrollments,
      activeEnrollments,
      totalCollected: Number(collected._sum.totalPaid || 0)
    };
    res.render('schemes/index', { title: 'Schemes', schemePlans, schemeStats });
  } catch (error) { next(error); }
});

app.get('/schemes/plans/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const plan = await prisma.schemePlan.findUnique({
      where: { id },
      include: { _count: { select: { enrollments: { where: { status: { not: 'CANCELLED' } } } } } }
    });
    if (!plan) return res.status(404).render('not-found', { title: 'Scheme plan not found' });

    // Cancelled customers remain in the audit trail and Cashbook, but are not
    // shown in operational scheme screens or counts. Apply every list filter
    // here, before count/pagination, rather than filtering only the rows on
    // the current browser page. A customer on page 3 must be findable from
    // page 1 just like Sales, Inventory, Customers, Cashbook and URD lists.
    const q = String(req.query.q || '').trim();
    const requestedMonth = Number(req.query.month);
    const selectedMonth = Number.isInteger(requestedMonth)
      && requestedMonth >= 1
      && requestedMonth <= plan.durationMonths
      ? requestedMonth
      : null;
    const paymentStatus = ['PAID', 'NOT_PAID'].includes(String(req.query.status || '').toUpperCase())
      ? String(req.query.status).toUpperCase()
      : 'ALL';
    const enrollmentWhere = { schemePlanId: id, status: { not: 'CANCELLED' } };
    const enrollmentFilters = [];
    if (q) {
      enrollmentFilters.push({ OR: [
        { enrollmentNumber: { contains: q } },
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: q } } }
      ] });
    }
    if (paymentStatus !== 'ALL') {
      const installmentWhere = {
        ...(selectedMonth ? { installmentNumber: selectedMonth } : {}),
        ...(paymentStatus === 'PAID' ? { status: 'PAID' } : { status: { not: 'PAID' } })
      };
      enrollmentFilters.push({ installments: { some: installmentWhere } });
    }
    if (enrollmentFilters.length) enrollmentWhere.AND = enrollmentFilters;
    const totalItems = await prisma.schemeEnrollment.count({ where: enrollmentWhere });
    const pagination = paginationFor(req, totalItems, req.query.page, 50);
    const [enrollments, enrollmentSummary] = await Promise.all([
      prisma.schemeEnrollment.findMany({
        where: enrollmentWhere,
        include: {
          customer: true,
          installments: {
            orderBy: { installmentNumber: 'asc' },
            select: {
              installmentNumber: true, dueDate: true, paidAmount: true, paymentDate: true, paymentMethod: true, status: true,
              payments: { select: { amount: true, paymentDate: true, paymentMethod: true } }
            }
          }
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize
      }),
      prisma.schemeEnrollment.groupBy({
        by: ['status'],
        where: enrollmentWhere,
        _count: { _all: true },
        _sum: { totalPaid: true }
      })
    ]);
    const summaryByStatus = new Map(enrollmentSummary.map((row) => [row.status, row]));
    const activeEnrollments = Number(summaryByStatus.get('ACTIVE')?._count._all || 0);
    const completedEnrollments = Number(summaryByStatus.get('COMPLETED')?._count._all || 0);
    const totalCollected = enrollmentSummary.reduce((sum, row) => sum + Number(row._sum.totalPaid || 0), 0);

    const stats = {
      totalEnrollments: totalItems,
      activeEnrollments,
      completedEnrollments,
      cancelledEnrollments: 0,
      totalCollected
    };

    res.render('schemes/plan-detail', {
      title: `${plan.name} · Scheme`,
      plan,
      enrollments,
      stats,
      pagination,
      hasEnrollments: (plan._count?.enrollments || 0) > 0,
      filters: { q, month: selectedMonth ? String(selectedMonth) : 'ALL', status: paymentStatus }
    });
  } catch (error) { next(error); }
});

app.get('/schemes/plans/:id/export', async (req, res) => {
  const planId = Number(req.params.id);
  try {
    const businessSettings = await getBusinessSettings(prisma);
    const payload = await getSchemePlanExportPayload(prisma, planId, {
      month: req.query.month,
      shopName: businessSettings.shopName,
      metadata: excelBusinessMetadata(businessSettings)
    });
    const workbook = await buildExcelExport(payload);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`);
    res.send(workbook);
  } catch (error) {
    redirectWith(res, `/schemes/plans/${planId}`, 'error', error.message || 'Could not create the scheme Excel report.');
  }
});

app.get('/schemes/plans/:id/edit', (req, res) => {
  res.redirect(`/schemes/plans/${req.params.id}?edit=1`);
});

app.post('/schemes/plans/new', async (req, res, next) => {
  try {
    const name = titleCase(req.body.name);
    const durationMonths = Number(req.body.durationMonths);
    const monthlyAmount = roundedMoney(number(req.body.monthlyAmount));
    const maturityAmount = roundedMoney(number(req.body.maturityAmount));
    if (!name) return redirectWith(res, '/schemes', 'error', 'Enter a scheme name.');
    if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 60) return redirectWith(res, '/schemes', 'error', 'Duration must be between 1 and 60 months.');
    if (monthlyAmount <= 0) return redirectWith(res, '/schemes', 'error', 'Enter a valid monthly installment amount.');
    if (maturityAmount <= 0) return redirectWith(res, '/schemes', 'error', 'Enter a valid maturity amount.');
    await prisma.schemePlan.create({
      data: {
        name,
        durationMonths,
        monthlyAmount,
        maturityAmount,
        description: req.body.description ? titleCase(req.body.description) : null,
        isActive: true
      }
    });
    redirectWith(res, '/schemes', 'message', `Scheme plan "${name}" created.`);
  } catch (error) { redirectWith(res, '/schemes', 'error', error.message || 'Could not create scheme plan.'); }
});

app.post('/schemes/plans/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = titleCase(req.body.name);
    const durationMonths = Number(req.body.durationMonths);
    const monthlyAmount = roundedMoney(number(req.body.monthlyAmount));
    const maturityAmount = roundedMoney(number(req.body.maturityAmount));
    if (!name) return redirectWith(res, '/schemes', 'error', 'Enter a scheme name.');
    if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 60) return redirectWith(res, '/schemes', 'error', 'Duration must be between 1 and 60 months.');
    if (monthlyAmount <= 0) return redirectWith(res, '/schemes', 'error', 'Enter a valid monthly installment amount.');
    if (maturityAmount <= 0) return redirectWith(res, '/schemes', 'error', 'Enter a valid maturity amount.');
    // Cancelled enrollments remain historical records, but they should not
    // keep a plan's financial terms locked after cancellation. Match the
    // plan page and edit modal, which count only non-cancelled enrollments.
    const plan = await prisma.schemePlan.findUnique({
      where: { id },
      include: { _count: { select: { enrollments: { where: { status: { not: 'CANCELLED' } } } } } }
    });
    if (!plan) return redirectWith(res, '/schemes', 'error', 'Scheme plan not found.');
    if (plan.deletionRequestedAt) return redirectWith(res, '/schemes', 'error', 'This scheme plan is being deleted and cannot be edited.');
    const hasEnrollments = plan._count.enrollments > 0;
    const financialTermsChanged = plan.durationMonths !== durationMonths
      || roundedMoney(plan.monthlyAmount) !== monthlyAmount
      || roundedMoney(plan.maturityAmount) !== maturityAmount;
    if (hasEnrollments && financialTermsChanged) {
      return redirectWith(res, '/schemes', 'error', 'This plan already has enrolled customers, so its duration and amounts are locked. Create a new plan for different terms.');
    }
    await prisma.schemePlan.update({
      where: { id },
      data: {
        name,
        durationMonths,
        monthlyAmount,
        maturityAmount,
        description: req.body.description ? titleCase(req.body.description) : null,
        isActive: req.body.isActive === 'on'
      }
    });
    const returnTo = req.body.returnTo === 'plan' || req.headers.referer?.includes(`/schemes/plans/${id}`)
      ? `/schemes/plans/${id}`
      : '/schemes';
    redirectWith(res, returnTo, 'message', `Scheme plan "${name}" updated.`);
  } catch (error) { redirectWith(res, '/schemes', 'error', error.message || 'Could not update scheme plan.'); }
});

app.post('/schemes/plans/:id/delete', async (req, res, next) => {
  let completedEnrollments = 0;
  let completedPayments = 0;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Scheme plan not found.');
    // Mark first in a short transaction. If a later chunk fails, the plan is
    // left inactive and this same endpoint can safely resume the cleanup.
    const plan = await prisma.$transaction(async (tx) => {
      const lockedPlans = await tx.$queryRaw`SELECT id FROM \`SchemePlan\` WHERE id = ${id} FOR UPDATE`;
      if (!lockedPlans.length) throw new Error('Scheme plan not found.');
      const current = await tx.schemePlan.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, deletionRequestedAt: true } });
      await tx.schemePlan.update({ where: { id }, data: { isActive: false, deletionRequestedAt: current.deletionRequestedAt || new Date() } });
      return current;
    }, { maxWait: 10000, timeout: 30000 });

    const chunkSize = 10;
    while (true) {
      const chunkResult = await prisma.$transaction(async (tx) => {
        const idRows = await tx.$queryRaw`SELECT id FROM \`SchemeEnrollment\` WHERE schemePlanId = ${id} ORDER BY id ASC LIMIT ${chunkSize} FOR UPDATE`;
        const enrollmentIds = idRows.map((row) => Number(row.id)).filter((value) => Number.isInteger(value));
        if (!enrollmentIds.length) return { done: true, enrollments: 0, payments: 0 };
        const enrollments = await tx.schemeEnrollment.findMany({
          where: { id: { in: enrollmentIds }, schemePlanId: id },
          select: { id: true, installments: { select: { cashbookEntryId: true, payments: { select: { cashbookEntryId: true } } } } }
        });
        const cashbookEntryIds = [...new Set(enrollments.flatMap((enrollment) => enrollment.installments.flatMap((installment) => [
          installment.cashbookEntryId, ...installment.payments.map((payment) => payment.cashbookEntryId)
        ])).filter(Boolean))];
        for (const cashbookEntryId of cashbookEntryIds) await reverseAndDeleteCashbookEntry(tx, cashbookEntryId);
        await tx.schemeEnrollment.deleteMany({ where: { id: { in: enrollmentIds }, schemePlanId: id } });
        return { done: false, enrollments: enrollments.length, payments: cashbookEntryIds.length };
      }, { maxWait: 10000, timeout: 30000 });
      completedEnrollments += chunkResult.enrollments;
      completedPayments += chunkResult.payments;
      if (chunkResult.done) break;
    }
    await prisma.$transaction(async (tx) => {
      const lockedPlans = await tx.$queryRaw`SELECT id FROM \`SchemePlan\` WHERE id = ${id} FOR UPDATE`;
      if (!lockedPlans.length) return;
      const remaining = await tx.schemeEnrollment.count({ where: { schemePlanId: id } });
      if (remaining) throw new Error('Some scheme enrollments could not be removed. Retry deleting this plan to resume safely.');
      await tx.schemePlan.delete({ where: { id } });
    }, { maxWait: 10000, timeout: 30000 });
    const result = { plan, enrollmentCount: completedEnrollments, paymentCount: completedPayments };
    const details = result.enrollmentCount
      ? ` ${result.enrollmentCount} enrollment${result.enrollmentCount === 1 ? '' : 's'} and ${result.paymentCount} Cashbook payment${result.paymentCount === 1 ? '' : 's'} were reversed.`
      : '';
    redirectWith(res, '/schemes', 'message', `Scheme plan "${result.plan.name}" deleted.${details}`);
  } catch (error) {
    const progress = completedEnrollments ? ` ${completedEnrollments} enrollment${completedEnrollments === 1 ? '' : 's'} and ${completedPayments} payment${completedPayments === 1 ? '' : 's'} were removed before the interruption; retry delete to resume.` : '';
    redirectWith(res, '/schemes', 'error', `${error.message || 'Could not delete scheme plan.'}${progress}`);
  }
});

app.post('/schemes/:planId/enroll', async (req, res, next) => {
  try {
    const planId = Number(req.params.planId);
    const name = titleCase(req.body.customerName);
    const phone = normalizePhone(req.body.customerPhone);
    const selectedCustomerId = req.body.customerId ? Number(req.body.customerId) : null;
    if (req.body.customerId && (!Number.isInteger(selectedCustomerId) || selectedCustomerId <= 0)) {
      return redirectWith(res, '/schemes', 'error', 'The selected customer is invalid. Search and select the customer again.');
    }
    if (!name) return redirectWith(res, '/schemes', 'error', 'Enter the customer name.');
    if (phone && !validCustomerPhone(phone)) return redirectWith(res, '/schemes', 'error', 'Enter a valid customer mobile number (10 to 15 digits), or leave it blank.');
    const startDateInput = req.body.startDate || dateInput();
    const startDate = dateTimeFromInput(startDateInput);

    const enrolledPlan = await prisma.$transaction(async (tx) => {
      // Lock the plan so a deactivated plan cannot receive a new enrollment
      // from another counter at the same time.
      const lockedPlans = await tx.$queryRaw`SELECT id FROM \`SchemePlan\` WHERE id = ${planId} FOR UPDATE`;
      if (!lockedPlans.length) throw new Error('Scheme plan not found.');
      const plan = await tx.schemePlan.findUniqueOrThrow({ where: { id: planId } });
      if (!plan.isActive || plan.deletionRequestedAt) throw new Error('This scheme plan is not available for enrollment.');

      // Use an explicitly selected profile first. If the operator changed the
      // mobile number after selecting a name, discard the stale selection and
      // resolve the new number instead of attaching the enrollment to the
      // wrong person. Do not silently overwrite established customer details.
      let customer = selectedCustomerId
        ? await tx.customer.findUnique({ where: { id: selectedCustomerId } })
        : null;
      if (selectedCustomerId && !customer) throw new Error('The selected customer no longer exists. Search and select the customer again.');
      if (customer?.phone && phone && customer.phone !== phone) customer = null;
      if (!customer && phone) customer = await tx.customer.findUnique({ where: { phone } });
      if (!customer) {
        customer = await tx.customer.create({ data: { name, phone: phone || null } });
      }

      // Reserve a compact, atomic scheme number. The counter is scoped to
      // this plan, so every plan starts at SCH-1 while two PCs cannot receive
      // the same number inside the same plan.
      const enrollmentNumber = await nextDocumentNumber(tx, 'SCH', startDate, { schemePlanId: planId });
      const schedule = createInstallmentSchedule(startDate, plan.durationMonths);

      const enrollment = await tx.schemeEnrollment.create({
        data: {
          enrollmentNumber,
          schemePlanId: planId,
          customerId: customer.id,
          startDate,
          endDate: schemeEndDate(startDate, plan.durationMonths),
          status: 'ACTIVE',
          totalPaid: 0,
          installmentsPaid: 0,
          notes: req.body.notes ? titleCase(req.body.notes) : null
        }
      });

      await tx.schemeInstallment.createMany({
        data: schedule.map(({ installmentNumber, dueDate }) => ({
          enrollmentId: enrollment.id,
          installmentNumber,
          dueDate,
          paidAmount: 0,
          status: 'PENDING'
        }))
      });
      return plan;
    });

    redirectWith(res, `/schemes/plans/${planId}`, 'message', `Customer "${name}" enrolled in ${enrolledPlan.name} successfully.`);
  } catch (error) {
    const errTarget = req.headers.referer?.includes('/plans/') ? req.headers.referer : `/schemes/plans/${req.params.planId || ''}`;
    redirectWith(res, errTarget, 'error', error.message || 'Could not enroll customer.');
  }
});

// Fast scheme enrollment for the counter: one request can create several
// customers and their installment schedules while keeping the same plan lock
// and customer de-duplication rules as the single-customer workflow.
app.post('/api/schemes/:planId/enroll-batch', express.json(), async (req, res) => {
  let completedCount = 0;
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId < 1) return res.status(400).json({ error: 'Choose a valid scheme plan.' });
    const inputRows = Array.isArray(req.body?.customers) ? req.body.customers : [];
    if (!inputRows.length) return res.status(400).json({ error: 'Add at least one customer to enroll.' });
    if (inputRows.length > 100) return res.status(400).json({ error: 'Enroll up to 100 customers at a time.' });
    const sharedStartDateInput = String(req.body?.startDate || '').trim();
    const sharedStartDate = dateTimeFromInput(sharedStartDateInput || dateInput());

    const rows = inputRows.map((row, index) => {
      const source = row && typeof row === 'object' ? row : {};
      const phone = normalizePhone(source.customerPhone ?? source.phone);
      const name = titleCase(source.customerName ?? source.name);
      const customerId = source.customerId ? Number(source.customerId) : null;
      if (source.customerId && (!Number.isInteger(customerId) || customerId <= 0)) {
        throw new Error(`Row ${index + 1}: the selected customer is invalid. Search and select the customer again.`);
      }
      if (phone && !validCustomerPhone(phone)) throw new Error(`Row ${index + 1}: enter a valid customer mobile number, or leave it blank.`);
      return {
        rowNumber: index + 1,
        customerId,
        phone,
        name,
        startDate: sharedStartDate,
        notes: source.notes ? titleCase(source.notes) : null
      };
    }).filter((row) => row.name || row.phone);
    if (!rows.length) return res.status(400).json({ error: 'Add a customer name or mobile number before enrolling.' });

    const created = [];
    let planName = '';
    // Keep each transaction bounded. A 100-row request is still accepted by
    // the UI, but four smaller atomic chunks prevent a long lock from timing
    // out on a shop PC or LAN database.
    for (const chunk of chunkArray(rows, 25)) {
      const result = await prisma.$transaction(async (tx) => {
        const lockedPlans = await tx.$queryRaw`SELECT id FROM \`SchemePlan\` WHERE id = ${planId} FOR UPDATE`;
        if (!lockedPlans.length) throw new Error('Scheme plan not found.');
        const plan = await tx.schemePlan.findUniqueOrThrow({ where: { id: planId } });
        if (!plan.isActive || plan.deletionRequestedAt) throw new Error('This scheme plan is not available for enrollment.');
        const chunkCreated = [];
        const installmentRows = [];
        for (const row of chunk) {
          let customer = row.customerId
            ? await tx.customer.findUnique({ where: { id: row.customerId } })
            : null;
          if (row.customerId && !customer) throw new Error(`Row ${row.rowNumber}: the selected customer no longer exists. Search and select the customer again.`);
          if (customer?.phone && row.phone && customer.phone !== row.phone) customer = null;
          if (!customer && row.phone) customer = await tx.customer.findUnique({ where: { phone: row.phone } });
          if (!customer) {
            if (!row.name) throw new Error(`Row ${row.rowNumber}: enter a customer name when no saved mobile profile is found.`);
            customer = await tx.customer.create({ data: { name: row.name, phone: row.phone || null } });
          }
          const enrollmentNumber = await nextDocumentNumber(tx, 'SCH', row.startDate, { schemePlanId: planId });
          const schedule = createInstallmentSchedule(row.startDate, plan.durationMonths);
          const enrollment = await tx.schemeEnrollment.create({
            data: {
              enrollmentNumber,
              schemePlanId: planId,
              customerId: customer.id,
              startDate: row.startDate,
              endDate: schemeEndDate(row.startDate, plan.durationMonths),
              status: 'ACTIVE',
              totalPaid: 0,
              installmentsPaid: 0,
              notes: row.notes
            }
          });
          installmentRows.push(...schedule.map(({ installmentNumber, dueDate }) => ({ enrollmentId: enrollment.id, installmentNumber, dueDate, paidAmount: 0, status: 'PENDING' })));
          chunkCreated.push({ enrollmentNumber, customerName: customer.name });
        }
        if (installmentRows.length) await tx.schemeInstallment.createMany({ data: installmentRows });
        return { planName: plan.name, created: chunkCreated };
      }, { maxWait: 10000, timeout: 30000 });
      planName = result.planName;
      created.push(...result.created);
      completedCount += result.created.length;
    }

    res.json({ success: true, count: created.length, planName, enrollments: created });
  } catch (error) {
    console.error('Batch scheme enrollment error:', error);
    res.status(500).json({ error: error.message || 'Could not enroll the selected customers.', completedCount: typeof completedCount === 'number' ? completedCount : 0 });
  }
});

// Batch maintenance uses a lightweight, paginated list. The default response
// omits installments/payment history; payment mode opts into pending installment
// IDs only. Cancellation changes status and leaves existing receipts in the
// financial audit trail.
app.get('/api/schemes/:planId/enrollments', async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId < 1) return res.status(400).json({ error: 'Choose a valid scheme plan.' });
    const q = String(req.query.q || '').trim();
    const includePendingInstallments = String(req.query.payments || '') === '1';
    const where = {
      schemePlanId: planId,
      status: 'ACTIVE',
      ...(q ? { OR: [
        { enrollmentNumber: { contains: q } },
        { customer: { name: { contains: q } } },
        { customer: { phone: { contains: normalizePhone(q) || q } } }
      ] } : {})
    };
    const totalItems = await prisma.schemeEnrollment.count({ where });
    const pagination = paginationFor(req, totalItems, req.query.page, 30);
    const enrollments = await prisma.schemeEnrollment.findMany({
      where,
      select: {
        id: true,
        enrollmentNumber: true,
        startDate: true,
        customer: { select: { name: true, phone: true } },
        ...(includePendingInstallments ? {
          installments: {
            where: { status: 'PENDING' },
            select: { id: true, installmentNumber: true, dueDate: true },
            orderBy: { installmentNumber: 'asc' }
          }
        } : {})
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (pagination.page - 1) * pagination.pageSize,
      take: pagination.pageSize
    });
    res.json({
      items: enrollments.map((enrollment) => ({
        id: enrollment.id,
        enrollmentNumber: enrollment.enrollmentNumber,
        startDate: dateInput(enrollment.startDate),
        customerName: enrollment.customer?.name || 'Unknown customer',
        customerPhone: enrollment.customer?.phone || '',
        pendingInstallments: includePendingInstallments
          ? (enrollment.installments || []).map((installment) => ({
            id: installment.id,
            installmentNumber: installment.installmentNumber,
            dueDate: dateInput(installment.dueDate)
          }))
          : undefined
      })),
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalItems: pagination.totalItems,
      totalPages: pagination.totalPages,
      hasNext: Boolean(pagination.nextUrl),
      hasPrevious: Boolean(pagination.previousUrl),
      q
    });
  } catch (error) {
    console.error('Scheme enrollment list error:', error);
    res.status(500).json({ error: error.message || 'Could not load scheme customers.' });
  }
});

// Record several scheme installment receipts in one transaction. The modal
// submits split payment columns, so every Cashbook part and its scheme link
// are committed together; blank rows are intentionally ignored by the client.
app.post('/api/schemes/:planId/payments-batch', express.json(), async (req, res) => {
  let completedCount = 0;
  try {
    const planId = Number(req.params.planId);
    if (!Number.isInteger(planId) || planId < 1) return res.status(400).json({ error: 'Choose a valid scheme plan.' });
    const inputRows = Array.isArray(req.body?.payments) ? req.body.payments : [];
    if (!inputRows.length) return res.status(400).json({ error: 'Enter at least one scheme payment.' });
    if (inputRows.length > 100) return res.status(400).json({ error: 'Record up to 100 scheme payments at a time.' });
    const sharedPaymentDateInput = String(req.body?.paymentDate || '').trim();
    const sharedPaymentDate = dateInput(dateTimeFromInput(sharedPaymentDateInput || dateInput()));

    const rows = inputRows.map((row, index) => {
      const source = row && typeof row === 'object' ? row : {};
      const enrollmentId = Number(source.enrollmentId);
      const installmentId = Number(source.installmentId);
      if (!Number.isInteger(enrollmentId) || enrollmentId < 1 || !Number.isInteger(installmentId) || installmentId < 1) {
        throw new Error(`Row ${index + 1}: choose a valid scheme customer and installment.`);
      }
      const payment = schemePaymentBreakdown({ ...source, paymentMethod: 'MIXED' });
      if (payment.paid <= 0) throw new Error(`Row ${index + 1}: enter a payment amount.`);
      return {
        rowNumber: index + 1,
        enrollmentId,
        installmentId,
        payment,
        paymentDate: dateInput(dateTimeFromInput(source.paymentDate || sharedPaymentDate)),
        narration: optionalText(source.narration, 1000)
      };
    });
    const duplicateInstallment = rows.find((row, index) => rows.some((other, otherIndex) => otherIndex < index && other.installmentId === row.installmentId));
    if (duplicateInstallment) throw new Error(`Row ${duplicateInstallment.rowNumber}: the same installment is entered more than once.`);

    let processed = 0;
    for (const chunk of chunkArray(rows, 25)) {
      const result = await prisma.$transaction(async (tx) => {
        const lockedPlans = await tx.$queryRaw`SELECT id FROM \`SchemePlan\` WHERE id = ${planId} FOR UPDATE`;
        if (!lockedPlans.length) throw new Error('Scheme plan not found.');
        const plan = await tx.schemePlan.findUniqueOrThrow({ where: { id: planId } });
        if (plan.deletionRequestedAt) throw new Error('This scheme plan is being deleted and cannot receive payments.');
        const enrollmentIds = [...new Set(chunk.map((row) => row.enrollmentId))];
        const installmentIds = chunk.map((row) => row.installmentId);
        await tx.$queryRaw`SELECT id FROM \`SchemeEnrollment\` WHERE id IN (${Prisma.join(enrollmentIds)}) AND schemePlanId = ${planId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM \`SchemeInstallment\` WHERE id IN (${Prisma.join(installmentIds)}) FOR UPDATE`;
        const enrollments = await tx.schemeEnrollment.findMany({ where: { id: { in: enrollmentIds }, schemePlanId: planId }, include: { schemePlan: true } });
        const installments = await tx.schemeInstallment.findMany({ where: { id: { in: installmentIds } } });
        const enrollmentById = new Map(enrollments.map((enrollment) => [enrollment.id, enrollment]));
        const installmentById = new Map(installments.map((installment) => [installment.id, installment]));
        for (const row of chunk) {
          const enrollment = enrollmentById.get(row.enrollmentId);
          const installment = installmentById.get(row.installmentId);
          if (!enrollment || enrollment.status !== 'ACTIVE') throw new Error(`Row ${row.rowNumber}: scheme customer is not active.`);
          if (!installment || installment.enrollmentId !== enrollment.id || installment.status !== 'PENDING') throw new Error(`Row ${row.rowNumber}: installment is no longer pending. Refresh the list and try again.`);
          if (!isFullInstallmentPayment(row.payment.paid, plan.monthlyAmount)) throw new Error(`Row ${row.rowNumber}: enter the exact monthly installment amount of ${money(plan.monthlyAmount)}.`);
        }
        const touchedEnrollments = new Set();
        for (const row of chunk) {
          const enrollment = enrollmentById.get(row.enrollmentId);
          const installment = installmentById.get(row.installmentId);
          const cashbookEntries = [];
          for (const component of row.payment.cashbookPayments) {
            const cashbookEntry = await tx.cashbookEntry.create({ data: {
              entryDate: row.paymentDate, type: 'IN', paymentMethod: component.method, amount: component.amount,
              description: `Scheme payment — ${enrollment.enrollmentNumber} — Installment ${installment.installmentNumber}`,
              reference: generatedReference('SCH-PAY'), customerId: enrollment.customerId,
              notes: [`${plan.name} · Installment ${installment.installmentNumber} of ${plan.durationMonths}`, row.narration].filter(Boolean).join(' · ')
            } });
            cashbookEntries.push({ ...component, id: cashbookEntry.id });
          }
          await tx.schemeInstallmentPayment.createMany({ data: cashbookEntries.map((entry) => ({ installmentId: installment.id, cashbookEntryId: entry.id, amount: entry.amount, paymentDate: row.paymentDate, paymentMethod: entry.method })) });
          await tx.schemeInstallment.update({ where: { id: installment.id }, data: {
            paidAmount: row.payment.paid, paymentDate: row.paymentDate, paymentMethod: row.payment.paymentMethod,
            cashbookEntryId: cashbookEntries.length === 1 ? cashbookEntries[0].id : null, notes: row.narration, status: 'PAID'
          } });
          touchedEnrollments.add(enrollment.id);
        }
        for (const enrollmentId of touchedEnrollments) {
          const enrollment = enrollmentById.get(enrollmentId);
          const [paidAggregate, installmentsPaid] = await Promise.all([
            tx.schemeInstallment.aggregate({ where: { enrollmentId, status: 'PAID' }, _sum: { paidAmount: true } }),
            tx.schemeInstallment.count({ where: { enrollmentId, status: 'PAID' } })
          ]);
          await tx.schemeEnrollment.update({ where: { id: enrollmentId }, data: {
            totalPaid: roundedMoney(paidAggregate._sum.paidAmount || 0), installmentsPaid,
            status: installmentsPaid >= enrollment.schemePlan.durationMonths ? 'COMPLETED' : 'ACTIVE'
          } });
        }
        return { count: chunk.length };
      }, { maxWait: 10000, timeout: 30000 });
      processed += result.count;
      completedCount += result.count;
    }
    res.json({ success: true, count: processed, paymentDate: sharedPaymentDate });
  } catch (error) {
    console.error('Batch scheme payment error:', error);
    res.status(500).json({ error: error.message || 'Could not record the selected scheme payments.', completedCount });
  }
});

app.post('/api/schemes/:planId/enrollments/batch-cancel', express.json(), async (req, res) => {
  try {
    const planId = Number(req.params.planId);
    const ids = [...new Set(asArray(req.body?.enrollmentIds)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0))];
    if (!Number.isInteger(planId) || planId < 1) return res.status(400).json({ error: 'Choose a valid scheme plan.' });
    if (!ids.length) return res.status(400).json({ error: 'Select at least one active customer to cancel.' });
    if (ids.length > 500) return res.status(400).json({ error: 'Cancel up to 500 customers at a time.' });

    const cancelled = await prisma.$transaction(async (tx) => {
      const lockedPlans = await tx.$queryRaw`SELECT id FROM \`SchemePlan\` WHERE id = ${planId} FOR UPDATE`;
      if (!lockedPlans.length) throw new Error('Scheme plan not found.');
      const active = await tx.schemeEnrollment.findMany({
        where: { id: { in: ids }, schemePlanId: planId, status: 'ACTIVE' },
        select: { id: true }
      });
      if (active.length !== ids.length) throw new Error('One or more selected customers are no longer active. Refresh the list and try again.');
      await tx.schemeEnrollment.updateMany({
        where: { id: { in: ids }, schemePlanId: planId, status: 'ACTIVE' },
        data: { status: 'CANCELLED' }
      });
      return active.length;
    });
    res.json({ success: true, count: cancelled });
  } catch (error) {
    console.error('Batch scheme cancellation error:', error);
    res.status(500).json({ error: error.message || 'Could not cancel the selected customers.' });
  }
});

app.get('/schemes/enrollments/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const enrollment = await prisma.schemeEnrollment.findUnique({
      where: { id },
      include: {
        schemePlan: true,
        customer: true,
        installments: {
          orderBy: { installmentNumber: 'asc' },
          include: { payments: { orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }] } }
        }
      }
    });
    // Cancelled enrollments remain only in the financial audit trail; they
    // must not be reachable as normal scheme customer screens.
    if (!enrollment || enrollment.status === 'CANCELLED') return res.status(404).render('not-found', { title: 'Enrollment not found' });
    res.render('schemes/enrollment-detail', {
      title: `${enrollment.enrollmentNumber}`,
      enrollment,
      returnTo: schemePlanReturnPath(req.query.returnTo, enrollment.schemePlanId)
    });
  } catch (error) { next(error); }
});

app.get('/schemes/enrollments/:id/receipt.pdf', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).send('Enrollment not found.');
    const enrollment = await prisma.schemeEnrollment.findUnique({
      where: { id },
      include: {
        schemePlan: true,
        customer: true,
        installments: {
          orderBy: { installmentNumber: 'asc' },
          include: { payments: { orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }] } }
        }
      }
    });
    if (!enrollment || enrollment.status === 'CANCELLED') return res.status(404).send('Enrollment not found.');
    const narration = optionalText(req.query.narration, 1000);
    await writeSchemeConsolidatedReceipt(res, enrollment, await getBusinessSettings(prisma), { narration });
  } catch (error) { next(error); }
});

app.get('/schemes/enrollments/:id/installments/:installmentId/receipt.pdf', async (req, res, next) => {
  try {
    const enrollmentId = Number(req.params.id);
    const installmentId = Number(req.params.installmentId);
    if (!Number.isInteger(enrollmentId) || !Number.isInteger(installmentId) || enrollmentId <= 0 || installmentId <= 0) {
      return res.status(404).send('Installment not found.');
    }
    const installment = await prisma.schemeInstallment.findFirst({
      where: {
        id: installmentId,
        enrollmentId,
        status: 'PAID',
        enrollment: { status: { not: 'CANCELLED' } }
      },
      include: {
        payments: { orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }] },
        enrollment: { include: { schemePlan: true, customer: true } }
      }
    });
    if (!installment || !paymentParts(installment).length) return res.status(404).send('Payment receipt not found.');
    await writeSchemeInstallmentReceipt(res, installment.enrollment, installment, await getBusinessSettings(prisma));
  } catch (error) { next(error); }
});

app.post('/schemes/enrollments/:id/pay', async (req, res, next) => {
  const enrollmentId = Number(req.params.id);
  try {
    const installmentId = Number(req.body.installmentId);
    const payment = schemePaymentBreakdown(req.body);
    const amount = payment.paid;
    const paymentDate = dateInput(dateTimeFromInput(req.body.paymentDate || dateInput()));
    const narration = optionalText(req.body.narration, 1000);
    if (amount <= 0) return redirectWith(res, `/schemes/enrollments/${enrollmentId}`, 'error', 'Enter a valid payment amount.');

    await prisma.$transaction(async (tx) => {
      const lockedEnrollments = await tx.$queryRaw`SELECT id FROM \`SchemeEnrollment\` WHERE id = ${enrollmentId} FOR UPDATE`;
      if (!lockedEnrollments.length) throw new Error('Scheme enrollment not found.');
      const enrollment = await tx.schemeEnrollment.findUnique({
        where: { id: enrollmentId },
        include: { schemePlan: true }
      });
      if (!enrollment || enrollment.status !== 'ACTIVE') throw new Error('This enrollment is not active.');
      if (enrollment.schemePlan.deletionRequestedAt) throw new Error('This scheme plan is being deleted and cannot receive payments.');

      const lockedInstallments = await tx.$queryRaw`SELECT id FROM \`SchemeInstallment\` WHERE id = ${installmentId} FOR UPDATE`;
      if (!lockedInstallments.length) throw new Error('Installment not found.');
      const installment = await tx.schemeInstallment.findUnique({ where: { id: installmentId } });
      if (!installment || installment.enrollmentId !== enrollmentId) throw new Error('Installment not found.');
      if (installment.status === 'PAID') throw new Error('This installment has already been paid.');
      if (!isFullInstallmentPayment(amount, enrollment.schemePlan.monthlyAmount)) {
        throw new Error(`Enter the exact monthly installment amount of ${money(enrollment.schemePlan.monthlyAmount)}.`);
      }

      // A scheme payment is a cashbook receipt, but it is not a loan/credit
      // collection and must not change the customer's sales ledger. Each
      // non-zero split becomes its own receipt and payment record.
      const cashbookEntries = [];
      for (const component of payment.cashbookPayments) {
        const cashbookEntry = await tx.cashbookEntry.create({
          data: {
            entryDate: paymentDate,
            type: 'IN',
            paymentMethod: component.method,
            amount: component.amount,
            description: `Scheme payment — ${enrollment.enrollmentNumber} — Installment ${installment.installmentNumber}`,
            reference: generatedReference('SCH-PAY'),
            customerId: enrollment.customerId,
            notes: [`${enrollment.schemePlan.name} · Installment ${installment.installmentNumber} of ${enrollment.schemePlan.durationMonths}`, narration].filter(Boolean).join(' · ')
          }
        });
        cashbookEntries.push({ ...component, id: cashbookEntry.id });
      }

      await tx.schemeInstallmentPayment.createMany({
        data: cashbookEntries.map((entry) => ({
          installmentId,
          cashbookEntryId: entry.id,
          amount: entry.amount,
          paymentDate,
          paymentMethod: entry.method
        }))
      });

      // Mark installment as paid
      await tx.schemeInstallment.update({
        where: { id: installmentId },
        data: {
          paidAmount: amount,
          paymentDate,
          paymentMethod: payment.paymentMethod,
          cashbookEntryId: cashbookEntries.length === 1 ? cashbookEntries[0].id : null,
          notes: narration,
          status: 'PAID'
        }
      });

      // Derive totals from saved rows rather than incrementing counters. This
      // remains correct if a cashier deletes a linked cashbook entry later.
      const [paidAggregate, newInstallmentsPaid] = await Promise.all([
        tx.schemeInstallment.aggregate({ where: { enrollmentId, status: 'PAID' }, _sum: { paidAmount: true } }),
        tx.schemeInstallment.count({ where: { enrollmentId, status: 'PAID' } })
      ]);
      const newTotalPaid = roundedMoney(paidAggregate._sum.paidAmount || 0);
      const isCompleted = newInstallmentsPaid >= enrollment.schemePlan.durationMonths;

      await tx.schemeEnrollment.update({
        where: { id: enrollmentId },
        data: {
          totalPaid: newTotalPaid,
          installmentsPaid: newInstallmentsPaid,
          status: isCompleted ? 'COMPLETED' : 'ACTIVE'
        }
      });
    });

    redirectWith(res, `/schemes/enrollments/${enrollmentId}`, 'message', 'Installment payment recorded and synced to cashbook.');
  } catch (error) { redirectWith(res, `/schemes/enrollments/${enrollmentId}`, 'error', error.message || 'Could not record payment.'); }
});

// Correct an already-recorded scheme installment without creating duplicate
// Cashbook receipts. Every existing payment part is replaced atomically by
// the edited split, so Cashbook and the scheme passbook always agree.
app.post('/schemes/enrollments/:id/installments/:installmentId/edit-payment', async (req, res) => {
  const enrollmentId = Number(req.params.id);
  const installmentId = Number(req.params.installmentId);
  try {
    const payment = schemePaymentBreakdown(req.body);
    const amount = payment.paid;
    const paymentDate = dateInput(dateTimeFromInput(req.body.paymentDate || dateInput()));
    const narration = optionalText(req.body.narration, 1000);
    if (amount <= 0) throw new Error('Enter a valid payment amount.');

    await prisma.$transaction(async (tx) => {
      const lockedEnrollments = await tx.$queryRaw`SELECT id FROM \`SchemeEnrollment\` WHERE id = ${enrollmentId} FOR UPDATE`;
      if (!lockedEnrollments.length) throw new Error('Scheme enrollment not found.');
      const enrollment = await tx.schemeEnrollment.findUnique({
        where: { id: enrollmentId },
        include: { schemePlan: true }
      });
      if (!enrollment || enrollment.status === 'CANCELLED') throw new Error('A cancelled scheme enrollment cannot be edited.');
      if (enrollment.schemePlan.deletionRequestedAt) throw new Error('This scheme plan is being deleted and cannot be edited.');

      const lockedInstallments = await tx.$queryRaw`SELECT id FROM \`SchemeInstallment\` WHERE id = ${installmentId} FOR UPDATE`;
      if (!lockedInstallments.length) throw new Error('Installment not found.');
      const installment = await tx.schemeInstallment.findUnique({
        where: { id: installmentId },
        include: { payments: { select: { cashbookEntryId: true } } }
      });
      if (!installment || installment.enrollmentId !== enrollmentId || installment.status !== 'PAID') {
        throw new Error('Only a recorded installment payment can be edited.');
      }
      if (!isFullInstallmentPayment(amount, enrollment.schemePlan.monthlyAmount)) {
        throw new Error(`Enter the exact monthly installment amount of ${money(enrollment.schemePlan.monthlyAmount)}.`);
      }

      const oldCashbookEntryIds = [...new Set([
        installment.cashbookEntryId,
        ...installment.payments.map((record) => record.cashbookEntryId)
      ].filter(Boolean))];
      await tx.schemeInstallmentPayment.deleteMany({ where: { installmentId } });
      if (oldCashbookEntryIds.length) {
        await tx.cashbookEntry.deleteMany({ where: { id: { in: oldCashbookEntryIds } } });
      }

      const cashbookEntries = [];
      for (const component of payment.cashbookPayments) {
        const cashbookEntry = await tx.cashbookEntry.create({
          data: {
            entryDate: paymentDate,
            type: 'IN',
            paymentMethod: component.method,
            amount: component.amount,
            description: `Scheme payment — ${enrollment.enrollmentNumber} — Installment ${installment.installmentNumber}`,
            reference: generatedReference('SCH-PAY'),
            customerId: enrollment.customerId,
            notes: [`${enrollment.schemePlan.name} · Installment ${installment.installmentNumber} of ${enrollment.schemePlan.durationMonths}`, narration].filter(Boolean).join(' · ')
          }
        });
        cashbookEntries.push({ ...component, id: cashbookEntry.id });
      }
      await tx.schemeInstallmentPayment.createMany({
        data: cashbookEntries.map((entry) => ({
          installmentId,
          cashbookEntryId: entry.id,
          amount: entry.amount,
          paymentDate,
          paymentMethod: entry.method
        }))
      });
      await tx.schemeInstallment.update({
        where: { id: installmentId },
        data: {
          paidAmount: amount,
          paymentDate,
          paymentMethod: payment.paymentMethod,
          cashbookEntryId: cashbookEntries.length === 1 ? cashbookEntries[0].id : null,
          notes: narration,
          status: 'PAID'
        }
      });
    });
    redirectWith(res, `/schemes/enrollments/${enrollmentId}`, 'message', 'Scheme installment payment updated and synced to cashbook.');
  } catch (error) {
    redirectWith(res, `/schemes/enrollments/${enrollmentId}`, 'error', error.message || 'Could not update the scheme payment.');
  }
});

app.post('/schemes/enrollments/:id/cancel', async (req, res, next) => {
  const enrollmentId = Number(req.params.id);
  try {
    const enrollment = await prisma.schemeEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) return redirectWith(res, '/schemes', 'error', 'Enrollment not found.');
    if (enrollment.status !== 'ACTIVE') return redirectWith(res, `/schemes/enrollments/${enrollmentId}`, 'error', 'Only active enrollments can be cancelled.');
    await prisma.schemeEnrollment.update({
      where: { id: enrollmentId },
      data: { status: 'CANCELLED' }
    });
    redirectWith(res, `/schemes/plans/${enrollment.schemePlanId}`, 'message', 'Enrollment cancelled. Payments already recorded remain in the cashbook.');
  } catch (error) { redirectWith(res, `/schemes`, 'error', error.message || 'Could not cancel enrollment.'); }
});

// Keep fall-through and error handlers last. Reports registered after either
// handler would otherwise always resolve to the 404 page before reaching their
// route.
app.use((req, res) => res.status(404).render('not-found', { title: 'Page not found' }));

app.use((error, req, res, next) => {
  console.error(error);
  // A file download or a client that closes a connection may already have
  // committed response headers. Never turn that into an uncaught exception
  // that closes the whole desktop ERP.
  if (res.headersSent) return next(error);
  if (expectsJson(req)) {
    return res.status(error.statusCode || error.status || 500).json({
      error: error.message || 'The request could not be completed.'
    });
  }
  res.status(500).render('error', { title: 'Something went wrong', detail: process.env.NODE_ENV === 'development' ? error.message : null });
});

async function startApplicationServer() {
  if (!shopSetupRequired()) {
    const connection = parseDatabaseConnection(process.env.DATABASE_URL);
    const mode = String(process.env.KUSUM_DEPLOYMENT_MODE || 'SERVER').toUpperCase();
    if (mode !== 'CLIENT' && isLocalHost(connection.host)) {
      await runBundledMigrations(appRoot, process.env.DATABASE_URL);
    } else {
      // Client PCs never migrate the shared schema. They fail clearly until
      // the updated ERP has first been opened on the Main database PC.
      await verifyClientConnection(process.env.DATABASE_URL, appRoot);
    }
  }
  const mode = String(process.env.KUSUM_DEPLOYMENT_MODE || 'SERVER').toUpperCase();
  const bindHost = process.env.KUSUM_BIND_HOST || (mode === 'CLIENT' ? '127.0.0.1' : '0.0.0.0');
  const server = app.listen(port, bindHost, () => console.log(`Kusum ERP running at http://localhost:${port}`));
  startWhatsAppWorker(prisma);
  return server;
}

startApplicationServer().catch((error) => {
  console.error(error);
  setImmediate(() => { throw error; });
});

process.on('SIGINT', async () => { await prisma.$disconnect(); process.exit(0); });
