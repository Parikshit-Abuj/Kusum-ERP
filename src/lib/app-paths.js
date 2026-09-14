const os = require('os');
const path = require('path');

/**
 * Return the per-user directory used for the ERP's local configuration and
 * logs. Keep the Windows location stable so existing installations continue
 * to find their .env file, while using the conventional locations on Linux
 * and macOS for new installations.
 */
function defaultShopDataDirectory() {
  if (process.env.KUSUM_APP_DATA) return process.env.KUSUM_APP_DATA;
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Kusum Jewelers ERP'
    );
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kusum Jewelers ERP');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'Kusum Jewelers ERP');
}

module.exports = { defaultShopDataDirectory };
