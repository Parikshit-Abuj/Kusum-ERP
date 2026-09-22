const { app, BrowserWindow, dialog, shell, session } = require('electron');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { defaultShopDataDirectory } = require('./src/lib/app-paths');

const shopDataDirectory = defaultShopDataDirectory();

process.env.KUSUM_APP_DATA = shopDataDirectory;
process.env.KUSUM_CONFIG_PATH = process.env.KUSUM_CONFIG_PATH || path.join(shopDataDirectory, '.env');
process.env.NODE_ENV = 'production';

function writeStartupLog(error) {
  try {
    const logsDirectory = path.join(shopDataDirectory, 'logs');
    fs.mkdirSync(logsDirectory, { recursive: true });
    const detail = error instanceof Error ? (error.stack || error.message) : String(error);
    fs.appendFileSync(
      path.join(logsDirectory, 'desktop-shell.log'),
      `[${new Date().toISOString()}] ${detail}\n`,
      'utf8'
    );
  } catch (_) {
    // Never let diagnostic logging prevent the ERP from opening.
  }
}

process.on('uncaughtException', (error) => {
  writeStartupLog(error);
  try {
    dialog.showErrorBox('Kusum Jewelers ERP could not start', error.message || String(error));
  } catch (_) {}
  app?.quit?.();
});

app.setPath('userData', path.join(shopDataDirectory, 'desktop-shell'));
app.setAppUserModelId('KusumJewelersERP');

let erpWindow;
let localPort;
// Do not prefix this partition with `persist:`. It exists only for this
// Electron process and is discarded when the cashier closes the ERP.
const cashierSessionPartition = 'kusum-erp-cashier-session';

function applicationIconPath() {
  // Windows expects an ICO for the packaged executable. Linux and macOS use
  // the transparent PNG artwork instead; keeping the selection here avoids
  // shipping a platform-specific path into the renderer or server.
  const filename = process.platform === 'win32' ? 'kusum-app-icon.ico' : 'kusum-app-icon.png';
  return path.join(__dirname, 'public', filename);
}

function isTrustedLocalUrl(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'http:' && target.hostname === '127.0.0.1' && Number(target.port) === localPort;
  } catch (_) {
    return false;
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const listener = net.createServer();
    listener.once('error', () => resolve(false));
    listener.once('listening', () => listener.close(() => resolve(true)));
    listener.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function firstFreeEphemeralPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.once('listening', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : null;
      listener.close(() => port ? resolve(port) : reject(new Error('Could not choose a local ERP port.')));
    });
    listener.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
}

async function startErpServer() {
  const configuredPort = Number(process.env.KUSUM_LOCAL_PORT || 3000);
  localPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 && await portIsFree(configuredPort)
    ? configuredPort
    : await firstFreeEphemeralPort();
  // dotenv in the ERP intentionally does not override this process value. It
  // lets a copied desktop app safely coexist with another local web service.
  process.env.PORT = String(localPort);
  require('./src/server');
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForServer(attempts = 40) {
  return new Promise((resolve, reject) => {
    const tryRequest = (remaining) => {
      const request = http.get(`http://127.0.0.1:${localPort}/setup`, (response) => {
        response.resume();
        resolve();
      });
      request.on('error', () => {
        if (remaining <= 0) return reject(new Error('The local ERP server did not start.'));
        setTimeout(() => tryRequest(remaining - 1), 250);
      });
      request.setTimeout(1000, () => request.destroy());
    };
    tryRequest(attempts);
  });
}

async function openErpWindow() {
  try {
    // Show the branded cinematic intro immediately. The local ERP server can
    // take a moment to connect to MySQL, so the splash screen gives the user
    // a deliberate launch moment instead of exposing a blank browser window.
    erpWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1040,
      minHeight: 720,
      title: 'Kusum ERP',
      backgroundColor: '#050913',
      // Use the platform-native icon asset for the title bar/taskbar and
      // packaged application.
      icon: applicationIconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Chromium's local spelling dictionary works without an ERP internet
        // connection and never changes typed text automatically.
        spellcheck: true,
        partition: cashierSessionPartition
      }
    });

    erpWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!isTrustedLocalUrl(url)) {
        if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('whatsapp://')) shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });
    erpWindow.webContents.on('will-navigate', (event, url) => {
      if (isTrustedLocalUrl(url)) return;
      event.preventDefault();
      if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('whatsapp://')) shell.openExternal(url);
    });

    const splashStartedAt = Date.now();
    await erpWindow.loadFile(path.join(__dirname, 'public', 'splash.html'));

    await startErpServer();
    await waitForServer();
    // An ERP desktop launch is a new cashier session. This partition is
    // in-memory (not `persist:`), so it cannot retain a prior login after the
    // desktop ERP has been closed. Clear it as a defensive no-op as well.
    try {
      await session.fromPartition(cashierSessionPartition).clearStorageData({ storages: ['cookies'] });
    } catch (error) {
      // A login prompt is important, but a damaged Chromium cache must never
      // stop the ERP from opening. The server still enforces authentication.
      writeStartupLog(`Could not clear previous desktop cookies: ${error.message || error}`);
    }
    // Keep the intro on screen long enough to feel intentional, while still
    // loading the login as soon as the server and database are ready.
    const splashDuration = 5000;
    const remainingSplashTime = Math.max(0, splashDuration - (Date.now() - splashStartedAt));
    await wait(remainingSplashTime);
    await erpWindow.loadURL(`http://127.0.0.1:${localPort}`);
  } catch (error) {
    writeStartupLog(error);
    dialog.showErrorBox(
      'Kusum ERP could not start',
      `${error.message}\n\nCheck the MySQL connection and ERP setup, then run the ERP again. Technical details are saved in the desktop-shell log.`
    );
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!erpWindow) return;
    if (erpWindow.isMinimized()) erpWindow.restore();
    erpWindow.focus();
  });
  app.whenReady().then(openErpWindow);
}
app.on('window-all-closed', () => app.quit());
