/**
 * Multi-Tenant Customer Management
 *
 * Verwaltet Kundendaten im Dateisystem:
 *   /data/{customerId}/
 *     ├── credentials.enc   (AES-256-GCM verschluesselt)
 *     ├── auth.json          (Playwright Browser-Session)
 *     └── downloads/         (PDF-Ausgabe)
 */

const fs = require('fs');
const path = require('path');
const { saveCredentials, loadCredentials } = require('./crypto-utils');

const DATA_DIR = process.env.DATA_DIR || '/data';

/**
 * Gibt alle Pfade fuer einen Kunden zurueck.
 */
function getCustomerPaths(customerId) {
  if (!customerId || /[^a-zA-Z0-9_-]/.test(customerId)) {
    throw new Error('Ungueltige customerId: nur a-z, A-Z, 0-9, _, - erlaubt');
  }
  const base = path.join(DATA_DIR, customerId);
  return {
    base,
    credentials: path.join(base, 'credentials.enc'),
    auth: path.join(base, 'auth.json'),
    downloads: path.join(base, 'downloads'),
    debug: path.join(base, 'debug_screenshots'),
  };
}

/**
 * Erstellt Kundenverzeichnis und speichert verschluesselte Credentials.
 *
 * @param {string} customerId - Eindeutige Kunden-ID (z.B. 'tss_eu')
 * @param {{ email: string, password: string, totpSecret?: string }} credentials
 * @param {string} credentialKey - Verschluesselungs-Key (min. 16 Zeichen)
 */
function setupCustomer(customerId, credentials, credentialKey) {
  if (!credentialKey || credentialKey.length < 16) {
    throw new Error('credentialKey muss mindestens 16 Zeichen lang sein');
  }
  if (!credentials.email || !credentials.password) {
    throw new Error('email und password sind Pflichtfelder');
  }

  const paths = getCustomerPaths(customerId);

  // Verzeichnisse anlegen
  fs.mkdirSync(paths.downloads, { recursive: true });
  fs.mkdirSync(paths.debug, { recursive: true });

  // Credentials verschluesselt speichern
  const data = {
    email: credentials.email,
    password: credentials.password,
    totpSecret: credentials.totpSecret || '',
    createdAt: new Date().toISOString(),
  };
  saveCredentials(paths.credentials, data, credentialKey);

  return { customerId, paths, created: true };
}

/**
 * Laedt und entschluesselt Kunden-Credentials.
 */
function getCustomerCredentials(customerId, credentialKey) {
  const paths = getCustomerPaths(customerId);
  if (!fs.existsSync(paths.credentials)) {
    throw new Error(`Keine Credentials fuer Kunde '${customerId}' gefunden`);
  }
  return loadCredentials(paths.credentials, credentialKey);
}

/**
 * Prueft ob ein Kunde konfiguriert ist.
 */
function customerExists(customerId) {
  try {
    const paths = getCustomerPaths(customerId);
    return fs.existsSync(paths.credentials);
  } catch {
    return false;
  }
}

/**
 * Listet alle konfigurierten Kunden.
 */
function listCustomers() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => fs.existsSync(path.join(DATA_DIR, d.name, 'credentials.enc')))
    .map(d => {
      const paths = getCustomerPaths(d.name);
      const hasSession = fs.existsSync(paths.auth);
      return { customerId: d.name, hasSession };
    });
}

/**
 * Loescht alle Downloads eines Kunden (nach erfolgreichem Upload).
 */
function cleanDownloads(customerId) {
  const paths = getCustomerPaths(customerId);
  if (fs.existsSync(paths.downloads)) {
    const files = fs.readdirSync(paths.downloads);
    for (const file of files) {
      fs.unlinkSync(path.join(paths.downloads, file));
    }
    return files.length;
  }
  return 0;
}

module.exports = {
  DATA_DIR,
  getCustomerPaths,
  setupCustomer,
  getCustomerCredentials,
  customerExists,
  listCustomers,
  cleanDownloads,
};
