/**
 * Kryptografie-Utilities fuer sichere Credential-Speicherung und TOTP
 *
 * Sicherheitsmodell:
 * - AES-256-GCM fuer Verschluesselung (authentifiziert, manipulationssicher)
 * - PBKDF2 mit 100.000 Iterationen fuer Schluesselableitung
 * - Zufaelliger Salt + IV pro Verschluesselung (kein Replay moeglich)
 * - Master-Key kommt NUR aus Umgebungsvariable CREDENTIAL_KEY
 * - Kein externer Dependency (nur Node.js crypto)
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

// ─── Verschluesselung ────────────────────────────────────────────────────────

function deriveKey(masterKey, salt) {
  return crypto.pbkdf2Sync(masterKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Verschluesselt einen String mit AES-256-GCM.
 * Gibt Base64-kodierten Ciphertext zurueck (salt + iv + tag + encrypted).
 */
function encrypt(plaintext, masterKey) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(masterKey, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/**
 * Entschluesselt einen Base64-kodierten AES-256-GCM Ciphertext.
 * Wirft Error bei falschem Key oder manipulierten Daten.
 */
function decrypt(encryptedBase64, masterKey) {
  const data = Buffer.from(encryptedBase64, 'base64');

  if (data.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Ungueltige verschluesselte Daten (zu kurz)');
  }

  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(masterKey, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
  } catch (e) {
    throw new Error('Entschluesselung fehlgeschlagen - falscher CREDENTIAL_KEY oder beschaedigte Daten');
  }
}

// ─── TOTP (RFC 6238) ────────────────────────────────────────────────────────

/**
 * Dekodiert einen Base32-String (wie aus Google Authenticator QR-Codes).
 */
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.replace(/[\s=-]/g, '').toUpperCase();

  let bits = '';
  for (const char of str) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error('Ungueltiges Base32-Zeichen: ' + char);
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generiert einen 6-stelligen TOTP-Code aus einem Base32-Secret.
 * Kompatibel mit Google Authenticator, Authy, etc.
 *
 * @param {string} secret - Base32-kodiertes TOTP-Secret
 * @param {number} [period=30] - Zeitfenster in Sekunden
 * @param {number} [digits=6] - Anzahl Stellen
 * @returns {string} 6-stelliger Code (mit fuehrenden Nullen)
 */
function generateTOTP(secret, period = 30, digits = 6) {
  const key = base32Decode(secret);

  // Aktueller Zeitslot
  const counter = Math.floor(Date.now() / 1000 / period);

  // Counter als 8-Byte Big-Endian Buffer
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', key);
  hmac.update(buffer);
  const hash = hmac.digest();

  // Dynamic Truncation (RFC 4226)
  const offset = hash[hash.length - 1] & 0xf;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

// ─── Credential Management ──────────────────────────────────────────────────

/**
 * Speichert Credentials verschluesselt in eine Datei.
 *
 * @param {string} filePath - Pfad zur .enc Datei
 * @param {object} credentials - { email, password, totpSecret }
 * @param {string} masterKey - Verschluesselungs-Key (aus CREDENTIAL_KEY env)
 */
function saveCredentials(filePath, credentials, masterKey) {
  const fs = require('fs');
  const json = JSON.stringify(credentials);
  const encrypted = encrypt(json, masterKey);
  fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
}

/**
 * Laedt und entschluesselt Credentials aus einer Datei.
 *
 * @param {string} filePath - Pfad zur .enc Datei
 * @param {string} masterKey - Entschluesselungs-Key (aus CREDENTIAL_KEY env)
 * @returns {{ email: string, password: string, totpSecret?: string }}
 */
function loadCredentials(filePath, masterKey) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    throw new Error('Credentials-Datei nicht gefunden: ' + filePath);
  }
  const encrypted = fs.readFileSync(filePath, 'utf8').trim();
  const json = decrypt(encrypted, masterKey);
  return JSON.parse(json);
}

module.exports = {
  encrypt,
  decrypt,
  generateTOTP,
  base32Decode,
  saveCredentials,
  loadCredentials,
};
