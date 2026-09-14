const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const templateDir = path.join(__dirname, '..', 'tspl-templates');
const templateFiles = {
  GOLD: path.join(templateDir, 'GOLD.PRN'),
  SILVER: path.join(templateDir, 'SILVER.PRN')
};
// Keep printer templates out of module initialisation. A missing optional
// label asset must not prevent the ERP server, login, or non-printer workflows
// from starting. Templates are loaded only when a label job is requested and
// cached for the lifetime of the process.
const templateCache = new Map();

function loadTemplate(kind) {
  if (templateCache.has(kind)) return templateCache.get(kind);
  const templatePath = templateFiles[kind];
  if (!templatePath) throw new Error(`No TSPL template is configured for ${kind || 'this metal'}.`);
  try {
    const template = fs.readFileSync(templatePath, 'utf8');
    if (!template.trim()) {
      throw Object.assign(new Error('Template file is empty.'), { code: 'EMPTY_TEMPLATE' });
    }
    templateCache.set(kind, template);
    return template;
  } catch (error) {
    const reason = error.code === 'ENOENT'
      ? 'the file is missing'
      : error.code === 'EMPTY_TEMPLATE'
        ? 'the file is empty'
        : `the file could not be read (${error.message || error.code || 'unknown error'})`;
    throw new Error(`Cannot print ${String(kind).toLowerCase()} labels because the TSPL template ${reason}. Restore ${path.basename(templatePath)} in the ERP release, then try again.`);
  }
}

function cleanTsplValue(value, fieldName = 'label text', maximumLength = null) {
  const source = String(value ?? '');
  // The supplied GOLD.PRN and SILVER.PRN layouts explicitly use CODEPAGE
  // 1252. Replacing unsupported Indian-script characters with '?' silently
  // produces an incorrect physical label, so stop before sending the job.
  if (/[^\x20-\xFF\r\n]/.test(source)) {
    throw new Error(`${fieldName} contains characters not supported by the supplied TSC CODEPAGE 1252 template. Use an English/Latin item name for this barcode label.`);
  }
  const cleaned = source
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/[^\x20-\xFF]/g, '?')
    .trim();
  // Keep the supplied PRN geometry unchanged. Long descriptions otherwise
  // overflow the fixed 12 mm label and can overlap the weight/barcode fields.
  // ASCII "..." is used instead of a Unicode ellipsis because the template
  // is explicitly CODEPAGE 1252.
  if (maximumLength && cleaned.length > maximumLength) {
    return `${cleaned.slice(0, Math.max(1, maximumLength - 3)).trimEnd()}...`;
  }
  return cleaned;
}

function labelKind(product) {
  if (product.metal === 'GOLD') return 'GOLD';
  if (product.metal === 'SILVER') return 'SILVER';
  throw new Error(`${product.barcode || 'Item'} is ${product.metal}; native labels are configured only for gold and silver.`);
}

function weight(value) {
  return Number(value || 0).toFixed(3);
}

function replaceAll(template, replacements) {
  return Object.entries(replacements).reduce(
    (result, [placeholder, value]) => result.split(placeholder).join(value),
    template
  );
}

function applyLabelSettings(template, settings = {}) {
  const width = Number(settings.labelWidthMm || 81);
  const height = Number(settings.labelHeightMm || 12);
  const gap = Number(settings.labelGapMm ?? 3);
  const speed = Number(settings.labelSpeed || 2);
  const density = Number(settings.labelDensity ?? 10);
  const shopName = cleanTsplValue(settings.labelShopName || 'KUSUM JEWELLERS', 'Label shop name', 36);
  const tsplNumber = (value) => Number.isInteger(value) ? String(value) : String(value);
  return template
    .replace(/^SIZE .*$/m, `SIZE ${width.toFixed(1)} mm, ${tsplNumber(height)} mm`)
    .replace(/^GAP .*$/m, `GAP ${gap} mm, 0 mm`)
    .replace(/^SPEED .*$/m, `SPEED ${speed}`)
    .replace(/^DENSITY .*$/m, `DENSITY ${density}`)
    .replaceAll('KUSUM JEWELLERS', shopName);
}

function buildTsplLabel(product, settings = {}) {
  if (!product.barcode) throw new Error(`${product.name} has no barcode.`);
  const kind = labelKind(product);
  const barcode = cleanTsplValue(product.barcode, 'Barcode');
  const replacements = kind === 'GOLD'
    ? {
        '<Item_name>': cleanTsplValue(product.name, 'Item name', 40),
        '<Barcode>': barcode,
        '<Gross_wt>': weight(product.grossWeight),
        '<TOT_STN_WT3>': weight(product.stoneWeight),
        '<net_wt>': weight(product.netWeight)
      }
    : {
        '<ITEM_NAME>': cleanTsplValue(product.name, 'Item name', 40),
        '<Barcode>': barcode,
        '<Gross_wt>': weight(product.grossWeight),
        '<stn_wt3>': weight(product.stoneWeight),
        '<net_wt>': weight(product.netWeight)
      };
  return replaceAll(applyLabelSettings(loadTemplate(kind), settings), replacements).replace(/\r?\n/g, '\r\n').trimEnd() + '\r\n';
}

function buildTsplJob(labels, settings = {}) {
  return labels.map(({ product }) => buildTsplLabel(product, settings)).join('\r\n');
}

function nativePrintScript() {
  return path.join(__dirname, '..', '..', 'scripts', 'print-tspl.ps1');
}

function sendTsplToWindowsPrinter(printerName, tspl) {
  return new Promise((resolve, reject) => {
    const shell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativePrintScript(), '-PrinterName', printerName], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Timed out while sending native TSPL to ${printerName}. Check that the TSC printer is powered on, online and not paused in Windows.`));
    }, 15000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) return finish(null, stdout.trim());
      const rawMsg = stderr.trim() || stdout.trim() || `Windows printer process stopped with code ${code}.`;
      let cleanMsg = rawMsg;
      if (/OpenPrinter for '([^']+)' failed/i.test(rawMsg) || /OpenPrinter|Win32Exception/i.test(rawMsg)) {
        const matchedName = /OpenPrinter for '([^']+)' failed/i.exec(rawMsg)?.[1] || printerName;
        cleanMsg = `Windows could not open the printer queue "${matchedName}". Check its exact name in Printer setup, then check the TSC driver, cable/network connection and printer power.`;
      }
      finish(new Error(cleanMsg));
    });
    child.stdin.end(Buffer.from(tspl, 'latin1').toString('base64'));
  });
}

function sendTsplToCupsPrinter(printerName, tspl) {
  const queue = String(printerName || '').trim();
  if (!queue) throw new Error('Select an installed CUPS printer queue before sending labels.');
  const bytes = Buffer.from(tspl, 'latin1');
  return new Promise((resolve, reject) => {
    const child = spawn('lp', ['-d', queue, '-o', 'raw'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Timed out while sending native TSPL to CUPS queue ${queue}. Check that CUPS is running and the printer is online.`));
    }, 15000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      const message = error.code === 'ENOENT'
        ? 'CUPS is not installed. Install the CUPS client tools before printing labels.'
        : error.message || String(error);
      finish(new Error(message));
    });
    child.on('close', (code) => {
      if (code === 0) return finish(null, stdout.trim() || `Sent ${bytes.length} native TSPL bytes to CUPS queue ${queue}.`);
      finish(new Error(stderr.trim() || stdout.trim() || `CUPS could not print to queue ${queue} (exit code ${code}).`));
    });
    child.stdin.end(bytes);
  });
}

function tcpPort(value) {
  const parsed = Number(value || 9100);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Enter a valid direct TCP printer port (1 to 65535).');
  }
  return parsed;
}

function tcpHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > 253 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    throw new Error('Enter a valid direct TCP printer IP address or host name.');
  }
  return host;
}

function checkTcpPrinter(host, portNumber) {
  const hostName = tcpHost(host);
  const port = tcpPort(portNumber);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostName, port });
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(6000);
    socket.once('connect', () => finish({
      available: true,
      name: `TCP ${hostName}:${port}`,
      message: `Connected to ${hostName}:${port}. Native TSPL will be sent directly over TCP.`,
      checked: true
    }));
    socket.once('timeout', () => finish({
      available: false,
      name: `TCP ${hostName}:${port}`,
      message: `Timed out connecting to ${hostName}:${port}. Check the printer IP, TCP port, cable/router and network power.`,
      checked: true
    }));
    socket.once('error', (error) => finish({
      available: false,
      name: `TCP ${hostName}:${port}`,
      message: `Could not connect to ${hostName}:${port}: ${error.message || error}`,
      checked: true
    }));
  });
}

function sendTsplOverTcp(host, portNumber, tspl) {
  const hostName = tcpHost(host);
  const port = tcpPort(portNumber);
  const bytes = Buffer.from(tspl, 'latin1');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostName, port });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setTimeout(15000);
    socket.once('connect', () => {
      socket.once('finish', () => finish(null, `Sent ${bytes.length} native TSPL bytes to ${hostName}:${port} over direct TCP.`));
      socket.end(bytes);
    });
    socket.once('timeout', () => finish(new Error(`Timed out sending native TSPL to ${hostName}:${port}. Check the printer IP, TCP port, cable/router and network power.`)));
    socket.once('error', (error) => finish(new Error(`Could not send native TSPL to ${hostName}:${port}: ${error.message || error}`)));
  });
}

function sendTsplToPrinter(printer, tspl) {
  const config = typeof printer === 'string' ? { mode: 'WINDOWS', name: printer } : (printer || {});
  const mode = String(config.mode || (process.platform === 'win32' ? 'WINDOWS' : 'CUPS')).toUpperCase();
  if (mode === 'TCP') {
    return sendTsplOverTcp(config.host, config.port, tspl);
  }
  if (mode === 'CUPS') return sendTsplToCupsPrinter(config.name, tspl);
  const printerName = String(config.name || '').trim();
  if (!printerName) throw new Error('Select an installed Windows printer before sending labels.');
  return sendTsplToWindowsPrinter(printerName, tspl);
}

module.exports = {
  buildTsplLabel,
  buildTsplJob,
  checkTcpPrinter,
  sendTsplToPrinter,
  sendTsplToCupsPrinter,
  sendTsplOverTcp
};
