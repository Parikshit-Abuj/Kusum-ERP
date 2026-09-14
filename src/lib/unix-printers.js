const { execFile } = require('child_process');

let cachedPrinters = null;
let cacheExpiresAt = 0;

function normalise(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function listUnixPrinters(force = false) {
  if (!force && cachedPrinters && Date.now() < cacheExpiresAt) return Promise.resolve(cachedPrinters);
  return new Promise((resolve) => {
    execFile('lpstat', ['-a'], {
      timeout: 3500,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        const message = /ENOENT/i.test(error.code || '')
          ? 'CUPS is not installed. Install and start the CUPS printing service, then try again.'
          : String(stderr || error.message || error).trim();
        return resolve({ printers: [], error: message || 'Could not read installed CUPS printers.' });
      }
      const printers = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean)
        .filter((name, index, all) => all.findIndex((entry) => normalise(entry) === normalise(name)) === index)
        .map((name) => ({
          name,
          isValid: true,
          canConfirmPhysicalStatus: false,
          workOffline: false
        }));
      const result = { printers, error: null };
      cachedPrinters = result;
      cacheExpiresAt = Date.now() + 15000;
      resolve(result);
    });
  });
}

function statusFromPrinterList(preferredName, listed, checked = true) {
  const configuredName = String(preferredName || '').trim();
  if (listed.error) {
    return {
      available: false,
      name: configuredName,
      message: `CUPS could not check printers: ${listed.error}`,
      printers: [],
      checked
    };
  }
  if (!configuredName) {
    return {
      available: false,
      name: '',
      message: 'Select a CUPS printer queue before sending labels.',
      printers: listed.printers,
      checked
    };
  }
  const printer = listed.printers.find((entry) => normalise(entry.name) === normalise(configuredName));
  if (!printer) {
    return {
      available: false,
      name: configuredName,
      message: `${configuredName} is not installed as a CUPS printer queue. Add it in your Linux printer settings, then click Recheck printer.`,
      printers: listed.printers,
      checked
    };
  }
  return {
    available: true,
    name: printer.name,
    message: `${printer.name} is available through CUPS. Use Test TSC to verify that the label printer accepts native TSPL data.`,
    printers: listed.printers,
    checked
  };
}

function cachedTscPrinterStatus(preferredName) {
  const configuredName = String(preferredName || '').trim();
  return {
    available: null,
    name: configuredName,
    message: 'Printer is configured. Use Test TSC to verify the CUPS queue and physical label output.',
    printers: cachedPrinters?.printers || [],
    checked: false
  };
}

async function resolveTscPrinter(preferredName, force = false) {
  return statusFromPrinterList(preferredName, await listUnixPrinters(force), true);
}

module.exports = { listUnixPrinters, resolveTscPrinter, cachedTscPrinterStatus };
