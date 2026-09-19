const { createHmac, timingSafeEqual } = require('crypto');
const { createSaleInvoicePdf } = require('./sale-invoice-pdf');
const { getBusinessSettings } = require('./business-settings');

const DEFAULT_GRAPH_VERSION = 'v23.0';
const DEFAULT_TEMPLATE_NAME = 'invoice_ready';
const DEFAULT_TEMPLATE_LANGUAGE = 'en';
const MAX_ATTEMPTS = 3;

class WhatsAppApiError extends Error {
  constructor(message, { code = null, billing = false, configuration = false, retryable = true } = {}) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.code = code ? String(code) : null;
    this.billing = billing;
    this.configuration = configuration;
    this.retryable = retryable;
  }
}

function configFromEnv(env = process.env) {
  return {
    enabled: String(env.WHATSAPP_ENABLED || '').toLowerCase() === 'true',
    accessToken: String(env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    templateName: String(env.WHATSAPP_TEMPLATE_NAME || DEFAULT_TEMPLATE_NAME).trim(),
    templateLanguage: String(env.WHATSAPP_TEMPLATE_LANGUAGE || DEFAULT_TEMPLATE_LANGUAGE).trim(),
    graphVersion: String(env.WHATSAPP_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION).trim(),
    webhookVerifyToken: String(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '').trim(),
    appSecret: String(env.WHATSAPP_APP_SECRET || '').trim()
  };
}

function getWhatsAppStatus(env = process.env) {
  const config = configFromEnv(env);
  const missing = [];
  if (!config.enabled) missing.push('WHATSAPP_ENABLED=true');
  if (!config.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!config.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!config.templateName) missing.push('WHATSAPP_TEMPLATE_NAME');
  if (!config.webhookVerifyToken) missing.push('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
  if (!config.appSecret) missing.push('WHATSAPP_APP_SECRET');
  if (!missing.length) return { key: 'connected', label: 'Connected', configured: true, detail: 'Invoice PDFs can be sent automatically.' };
  return {
    key: 'not_configured',
    label: 'Not configured',
    configured: false,
    detail: `Add ${missing.join(', ')} to the ERP environment before sending.`
  };
}

function normalizeWhatsAppPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // The ERP stores Indian customer mobiles without the country code. Keep
  // already-international numbers untouched.
  if (digits.length === 10) digits = `91${digits}`;
  if (!/^\d{11,15}$/.test(digits)) return null;
  return digits;
}

function formatErrorPayload(payload) {
  const error = payload?.error || payload;
  return {
    code: error?.code || error?.error_subcode || null,
    message: error?.message || error?.error_user_msg || 'WhatsApp provider rejected the request.'
  };
}

function isBillingPayload(payload) {
  const { code, message } = formatErrorPayload(payload);
  const text = String(message || '').toLowerCase();
  return String(code) === '131042' || /billing|payment|credit|balance|account.*disabled|payment method/.test(text);
}

async function parseResponse(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch (_) { return { error: { message: text || response.statusText } }; }
}

async function providerRequest(url, options, context) {
  if (typeof fetch !== 'function') {
    throw new WhatsAppApiError('This ERP runtime does not provide network fetch support.', { configuration: true, retryable: false });
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new WhatsAppApiError(`${context} could not reach WhatsApp: ${error.message}`, { retryable: true });
  }
  const payload = await parseResponse(response);
  if (!response.ok) {
    const details = formatErrorPayload(payload);
    throw new WhatsAppApiError(`${context} failed: ${details.message}`, {
      code: details.code,
      billing: isBillingPayload(payload),
      configuration: response.status === 401 || response.status === 403,
      retryable: response.status >= 500 || response.status === 429
    });
  }
  return payload;
}

function graphUrl(config, path) {
  return `https://graph.facebook.com/${encodeURIComponent(config.graphVersion)}${path}`;
}

async function uploadPdf(config, pdf, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), filename);
  const payload = await providerRequest(graphUrl(config, `/${encodeURIComponent(config.phoneNumberId)}/media`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: form
  }, 'Invoice PDF upload');
  if (!payload.id) throw new WhatsAppApiError('WhatsApp did not return a media ID.', { retryable: false });
  return payload.id;
}

async function sendTemplate(config, { to, mediaId, filename, customerName, invoiceNumber, total }) {
  const payload = await providerRequest(graphUrl(config, `/${encodeURIComponent(config.phoneNumberId)}/messages`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: config.templateName,
        language: { code: config.templateLanguage },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'document', document: { id: mediaId, filename } }]
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: customerName || 'Customer' },
              { type: 'text', text: invoiceNumber },
              { type: 'text', text: Number(total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }) }
            ]
          }
        ]
      }
    })
  }, 'WhatsApp invoice message');
  const providerMessageId = payload?.messages?.[0]?.id;
  if (!providerMessageId) throw new WhatsAppApiError('WhatsApp did not return a message ID.', { retryable: false });
  return providerMessageId;
}

async function sendSaleInvoice({ sale, businessSettings }) {
  const config = configFromEnv();
  if (!getWhatsAppStatus().configured) {
    throw new WhatsAppApiError('WhatsApp Business API is not configured.', { configuration: true, retryable: false });
  }
  const to = normalizeWhatsAppPhone(sale.customer?.phone);
  if (!to) throw new WhatsAppApiError('The customer does not have a valid WhatsApp mobile number.', { retryable: false });
  const pdf = await createSaleInvoicePdf(sale, businessSettings);
  const filename = `${String(sale.invoiceNumber || 'invoice').replace(/[^A-Za-z0-9-]/g, '_')}.pdf`;
  const mediaId = await uploadPdf(config, pdf, filename);
  const providerMessageId = await sendTemplate(config, {
    to,
    mediaId,
    filename,
    customerName: sale.customer?.name,
    invoiceNumber: sale.invoiceNumber,
    total: sale.total
  });
  return { providerMessageId, recipientPhone: to };
}

async function queueSaleInvoiceMessage(db, saleId, { force = false } = {}) {
  const id = Number(saleId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invoice not found.');
  const sale = await db.sale.findFirst({ where: { id, cancelledAt: null }, include: { customer: true } });
  if (!sale) throw new Error('Invoice not found or cancelled.');
  if (!sale.customer) throw new Error('Add a customer mobile number before sending the invoice.');
  if (!sale.customer.whatsappOptIn) throw new Error('The customer has not opted in to WhatsApp invoice messages.');
  const recipientPhone = normalizeWhatsAppPhone(sale.customer.phone);
  if (!recipientPhone) throw new Error('The customer mobile number is not a valid WhatsApp number.');
  const templateName = configFromEnv().templateName || DEFAULT_TEMPLATE_NAME;
  const current = await db.whatsAppMessage.findUnique({ where: { saleId: id } });
  if (current && !force && ['SENDING', 'SENT', 'DELIVERED', 'READ'].includes(current.status)) return current;
  const data = {
    customerId: sale.customer.id,
    recipientPhone,
    templateName,
    status: 'QUEUED',
    errorCode: null,
    errorMessage: null,
    nextAttemptAt: new Date()
  };
  if (current) return db.whatsAppMessage.update({ where: { id: current.id }, data });
  return db.whatsAppMessage.create({ data: { saleId: id, ...data } });
}

function isBillingError(error) { return Boolean(error?.billing); }

async function processOne(db, message) {
  const claimed = await db.whatsAppMessage.updateMany({
    where: { id: message.id, status: 'QUEUED' },
    data: { status: 'SENDING', attempts: { increment: 1 }, errorCode: null, errorMessage: null }
  });
  if (!claimed.count) return false;
  try {
    if (!getWhatsAppStatus().configured) {
      throw new WhatsAppApiError('WhatsApp Business API is not configured.', { configuration: true, retryable: false });
    }
    const sale = await db.sale.findFirst({
      where: { id: message.saleId, cancelledAt: null },
      include: { customer: true, urdPurchase: true, items: { include: { product: true } } }
    });
    if (!sale?.customer?.whatsappOptIn) throw new WhatsAppApiError('Customer WhatsApp opt-in is no longer active.', { retryable: false });
    const businessSettings = await getBusinessSettings(db);
    const result = await sendSaleInvoice({ sale, businessSettings });
    await db.whatsAppMessage.update({
      where: { id: message.id },
      data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date(), errorCode: null, errorMessage: null }
    });
    return true;
  } catch (error) {
    const attempts = Number(message.attempts || 0) + 1;
    const status = isBillingError(error) ? 'BLOCKED_BILLING'
      : error?.configuration ? 'BLOCKED_CONFIG'
      : (error?.retryable !== false && attempts < MAX_ATTEMPTS ? 'QUEUED' : 'FAILED');
    const retryDelay = Math.min(30, 5 * attempts);
    await db.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        status,
        errorCode: error.code ? String(error.code) : null,
        errorMessage: String(error.message || 'WhatsApp send failed').slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + (status === 'QUEUED' ? retryDelay * 60 * 1000 : 0))
      }
    });
    return false;
  }
}

async function processWhatsAppOutbox(db) {
  if (!db?.whatsAppMessage) return;
  // Recover a message left in-flight if the desktop process was closed after
  // claiming it but before the provider response arrived.
  await db.whatsAppMessage.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
    data: { status: 'QUEUED', nextAttemptAt: new Date(), errorMessage: 'Recovered after an interrupted send.' }
  });
  const message = await db.whatsAppMessage.findFirst({
    where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }]
  });
  if (message) await processOne(db, message);
}

function startWhatsAppWorker(db, intervalMs = 15000) {
  const timer = setInterval(() => processWhatsAppOutbox(db).catch((error) => console.error('WhatsApp worker error:', error)), intervalMs);
  timer.unref?.();
  return timer;
}

function verifyWebhookSignature(req, rawBody, env = process.env) {
  const secret = String(env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret) return false;
  const supplied = String(req.get('x-hub-signature-256') || '');
  if (!supplied.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function handleWebhook(db, body) {
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const status of change?.value?.statuses || []) statuses.push(status);
    }
  }
  for (const status of statuses) {
    if (!status.id) continue;
    const current = await db.whatsAppMessage.findFirst({ where: { providerMessageId: status.id } });
    if (!current) continue;
    const mapped = status.status === 'read' ? 'READ' : status.status === 'delivered' ? 'DELIVERED' : status.status === 'sent' ? 'SENT' : status.status === 'failed' ? 'FAILED' : null;
    const error = status.errors?.[0];
    await db.whatsAppMessage.update({ where: { id: current.id }, data: {
      ...(mapped ? { status: mapped } : {}),
      ...(mapped === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
      ...(mapped === 'READ' ? { readAt: new Date() } : {}),
      ...(error ? { status: isBillingPayload({ error }) ? 'BLOCKED_BILLING' : 'FAILED', errorCode: String(error.code || ''), errorMessage: String(error.title || error.message || '').slice(0, 2000) } : {})
    } });
  }
}

module.exports = {
  configFromEnv,
  getWhatsAppStatus,
  normalizeWhatsAppPhone,
  queueSaleInvoiceMessage,
  processWhatsAppOutbox,
  startWhatsAppWorker,
  verifyWebhookSignature,
  handleWebhook
};
