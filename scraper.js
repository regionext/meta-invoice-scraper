#!/usr/bin/env node
/**
 * Meta Ads Invoice/Receipt Scraper
 *
 * Navigiert per Playwright durch den Meta Business Manager Billing-Bereich,
 * wechselt pro Werbekonto und laedt alle Zahlungsnachweise als PDF herunter.
 *
 * Nutzung:
 *   CLI:    node scraper.js '{"accounts":["act_123"],"dateFrom":"2025-01-01","dateTo":"2025-01-31"}'
 *   Modul:  const { runScraper } = require('./scraper');
 *           const result = await runScraper({ accounts, dateFrom, dateTo, ... });
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadCredentials, generateTOTP } = require('./crypto-utils');

// ─── Konfiguration (Modul-Level Defaults, ueberschreibbar via runScraper) ───

const DEFAULT_CONFIG = {
  AUTH_FILE: process.env.AUTH_FILE || path.join(__dirname, 'auth.json'),
  DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads'),
  BILLING_URL: 'https://business.facebook.com/billing_hub/payment_activity',
  HEADLESS: process.env.HEADLESS !== 'false',
  TIMEOUT: 30000,
  SLOW_MO: 500,
  DEBUG: process.argv.includes('--debug') || process.env.DEBUG === 'true',
  DEBUG_DIR: process.env.DEBUG_DIR || path.join(__dirname, 'debug_screenshots'),
  BUSINESS_ID: process.env.BUSINESS_ID || '',
  CREDENTIALS_FILE: process.env.CREDENTIALS_FILE || path.join(__dirname, 'credentials.enc'),
  CREDENTIAL_KEY: process.env.CREDENTIAL_KEY || '',
};

// Aktive Konfiguration (wird pro runScraper-Aufruf gesetzt)
let CONFIG = { ...DEFAULT_CONFIG };

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Macht einen Debug-Screenshot wenn DEBUG-Modus aktiv ist
 */
async function takeDebugScreenshot(page, stepName) {
  if (!CONFIG.DEBUG) return;
  ensureDir(CONFIG.DEBUG_DIR);
  const timestamp = Date.now();
  const safeName = stepName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(CONFIG.DEBUG_DIR, `${timestamp}_${safeName}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    log(`  [DEBUG] Screenshot: ${filePath}`);
  } catch (e) {
    log(`  [DEBUG] Screenshot fehlgeschlagen: ${e.message}`);
  }
}

/**
 * Resilientes Element-Finden mit mehreren Selektor-Strategien.
 * Probiert jede Strategie der Reihe nach durch, gibt den ersten sichtbaren Treffer zurueck.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{type: string, value: string, description?: string}>} strategies
 *   type: 'css' | 'text' | 'textRegex' | 'role' | 'testid' | 'label' | 'xpath'
 * @param {string} elementDescription - Was wir suchen (fuer Logs)
 * @param {object} [options]
 * @param {number} [options.timeout=5000] - Timeout pro Strategie in ms
 * @returns {Promise<import('playwright').Locator|null>}
 */
async function findElement(page, strategies, elementDescription, options = {}) {
  const { timeout = 5000 } = options;

  log(`  Suche: ${elementDescription} (${strategies.length} Strategien)`);

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const desc = strategy.description || `${strategy.type}:${strategy.value}`;

    try {
      let locator;
      switch (strategy.type) {
        case 'css':
          locator = page.locator(strategy.value).first();
          break;
        case 'text':
          locator = page.locator(`text=${strategy.value}`).first();
          break;
        case 'textRegex':
          locator = page.locator(`text=/${strategy.value}/i`).first();
          break;
        case 'role': {
          const [role, name] = strategy.value.split(':');
          locator = page.getByRole(role, { name: new RegExp(name, 'i') }).first();
          break;
        }
        case 'testid':
          locator = page.locator(`[data-testid="${strategy.value}"]`).first();
          break;
        case 'label':
          locator = page.locator(`[aria-label*="${strategy.value}"]`).first();
          break;
        case 'xpath':
          locator = page.locator(`xpath=${strategy.value}`).first();
          break;
        default:
          log(`    [${i + 1}] Unbekannter Typ: ${strategy.type}`);
          continue;
      }

      await locator.waitFor({ state: 'visible', timeout });
      const isVisible = await locator.isVisible();
      if (isVisible) {
        log(`    [${i + 1}] TREFFER via ${desc}`);
        return locator;
      }
    } catch (e) {
      log(`    [${i + 1}] ${desc} -> nicht gefunden`);
    }
  }

  log(`  WARNUNG: ${elementDescription} nicht gefunden (alle ${strategies.length} Strategien fehlgeschlagen)`);
  await takeDebugScreenshot(page, `not_found_${elementDescription.replace(/\s/g, '_')}`);
  return null;
}

/**
 * Wie findElement, aber gibt ALLE passenden Elemente der ersten erfolgreichen Strategie zurueck.
 *
 * @returns {Promise<{locator: import('playwright').Locator, count: number, strategy: string}|null>}
 */
async function findAllElements(page, strategies, elementDescription, options = {}) {
  const { timeout = 5000 } = options;

  log(`  Suche alle: ${elementDescription}`);

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const desc = strategy.description || `${strategy.type}:${strategy.value}`;

    try {
      let locator;
      switch (strategy.type) {
        case 'css':
          locator = page.locator(strategy.value);
          break;
        case 'text':
          locator = page.locator(`text=${strategy.value}`);
          break;
        case 'textRegex':
          locator = page.locator(`text=/${strategy.value}/i`);
          break;
        case 'role': {
          const [role, name] = strategy.value.split(':');
          locator = page.getByRole(role, { name: new RegExp(name, 'i') });
          break;
        }
        case 'testid':
          locator = page.locator(`[data-testid="${strategy.value}"]`);
          break;
        case 'label':
          locator = page.locator(`[aria-label*="${strategy.value}"]`);
          break;
        default:
          continue;
      }

      await page.waitForTimeout(Math.min(timeout, 2000));
      const count = await locator.count();

      if (count > 0) {
        log(`    [${i + 1}] TREFFER: ${count} Elemente via ${desc}`);
        return { locator, count, strategy: desc };
      }
    } catch (e) {
      log(`    [${i + 1}] ${desc} -> nicht gefunden`);
    }
  }

  log(`  WARNUNG: ${elementDescription} nicht gefunden`);
  await takeDebugScreenshot(page, `not_found_all_${elementDescription.replace(/\s/g, '_')}`);
  return null;
}

/**
 * Wartet auf die Billing-Seite und prüft ob die Session gültig ist
 */
async function checkSession(page) {
  await page.goto(CONFIG.BILLING_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await delay(3000);

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    return false;
  }
  return true;
}

/**
 * Automatischer Login mit gespeicherten Credentials + TOTP 2FA.
 * Wird nur aufgerufen wenn die Session (auth.json) abgelaufen ist.
 *
 * Sicherheit:
 * - Credentials werden aus verschluesselter Datei geladen (AES-256-GCM)
 * - TOTP-Codes werden on-the-fly generiert, nie gespeichert
 * - Passwort wird nie in Logs ausgegeben
 * - Nach erfolgreichem Login wird die neue Session in auth.json gespeichert
 *
 * @returns {Promise<boolean>} true wenn Login erfolgreich
 */
async function autoLogin(page) {
  if (!CONFIG.CREDENTIAL_KEY || !fs.existsSync(CONFIG.CREDENTIALS_FILE)) {
    log('Auto-Login nicht moeglich: Credentials nicht konfiguriert.');
    log('  Bitte setup-credentials.js ausfuehren oder login.js fuer manuellen Login nutzen.');
    return false;
  }

  log('Session abgelaufen - starte automatischen Login...');

  let credentials;
  try {
    credentials = loadCredentials(CONFIG.CREDENTIALS_FILE, CONFIG.CREDENTIAL_KEY);
    log('  Credentials entschluesselt (E-Mail: ' + credentials.email.replace(/(.{3}).*(@.*)/, '$1***$2') + ')');
  } catch (e) {
    log('  FEHLER beim Laden der Credentials: ' + e.message);
    return false;
  }

  try {
    // 1. Zur Login-Seite navigieren
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000);
    await takeDebugScreenshot(page, 'autologin_01_login_page');

    // 2. E-Mail eingeben
    const emailInput = await findElement(page, [
      { type: 'css', value: '#email', description: 'email input by id' },
      { type: 'css', value: 'input[name="email"]', description: 'email input by name' },
      { type: 'css', value: 'input[type="email"]', description: 'email input by type' },
    ], 'E-Mail Eingabefeld');

    if (!emailInput) {
      log('  FEHLER: E-Mail-Feld nicht gefunden');
      return false;
    }

    await emailInput.fill(credentials.email);
    await delay(500);

    // 3. Passwort eingeben
    const passwordInput = await findElement(page, [
      { type: 'css', value: '#pass', description: 'password input by id' },
      { type: 'css', value: 'input[name="pass"]', description: 'password input by name' },
      { type: 'css', value: 'input[type="password"]', description: 'password input by type' },
    ], 'Passwort Eingabefeld');

    if (!passwordInput) {
      log('  FEHLER: Passwort-Feld nicht gefunden');
      return false;
    }

    await passwordInput.fill(credentials.password);
    await delay(500);

    // 4. Login-Button klicken
    const loginButton = await findElement(page, [
      { type: 'css', value: 'button[name="login"]', description: 'login button by name' },
      { type: 'css', value: '#loginbutton', description: 'login button by id' },
      { type: 'css', value: 'button[type="submit"]', description: 'submit button' },
      { type: 'role', value: 'button:Log In', description: 'login button by role' },
      { type: 'role', value: 'button:Anmelden', description: 'anmelden button by role' },
    ], 'Login Button');

    if (!loginButton) {
      log('  FEHLER: Login-Button nicht gefunden');
      return false;
    }

    await loginButton.click();
    log('  Login-Formular abgeschickt, warte auf Antwort...');
    await delay(5000);
    await takeDebugScreenshot(page, 'autologin_02_after_submit');

    // 5. Pruefen: 2FA-Abfrage oder direkt eingeloggt?
    const currentUrl = page.url();

    // 2FA / Checkpoint erkennen
    if (currentUrl.includes('checkpoint') || currentUrl.includes('two_step_verification') || currentUrl.includes('auth')) {
      log('  2FA-Abfrage erkannt');

      if (!credentials.totpSecret) {
        log('  FEHLER: 2FA erforderlich, aber kein TOTP-Secret hinterlegt!');
        log('  Bitte setup-credentials.js erneut ausfuehren und TOTP-Secret angeben.');
        await takeDebugScreenshot(page, 'autologin_03_2fa_no_secret');
        return false;
      }

      // TOTP-Code generieren
      const totpCode = generateTOTP(credentials.totpSecret);
      log('  TOTP-Code generiert (6 Stellen)');

      await delay(2000);

      // 2FA-Code Eingabefeld finden
      const codeInput = await findElement(page, [
        { type: 'css', value: '#approvals_code', description: '2fa code input by id' },
        { type: 'css', value: 'input[name="approvals_code"]', description: '2fa code input by name' },
        { type: 'css', value: 'input[autocomplete="one-time-code"]', description: '2fa input by autocomplete' },
        { type: 'css', value: 'input[type="tel"]', description: '2fa input type tel' },
        { type: 'css', value: 'input[type="text"][inputmode="numeric"]', description: '2fa input numeric' },
        { type: 'css', value: 'input[type="number"]', description: '2fa input number' },
      ], '2FA Code Eingabefeld');

      if (!codeInput) {
        log('  FEHLER: 2FA-Eingabefeld nicht gefunden');
        await takeDebugScreenshot(page, 'autologin_03_2fa_no_input');
        return false;
      }

      await codeInput.fill(totpCode);
      await delay(500);

      // Bestaetigen-Button klicken
      const confirmButton = await findElement(page, [
        { type: 'css', value: '#checkpointSubmitButton', description: 'checkpoint submit' },
        { type: 'css', value: 'button[type="submit"]', description: 'submit button' },
        { type: 'role', value: 'button:Continue', description: 'continue button' },
        { type: 'role', value: 'button:Weiter', description: 'weiter button' },
        { type: 'role', value: 'button:Submit', description: 'submit button role' },
        { type: 'role', value: 'button:Absenden', description: 'absenden button' },
      ], '2FA Bestaetigungs-Button');

      if (confirmButton) {
        await confirmButton.click();
        log('  2FA-Code abgeschickt, warte auf Verifizierung...');
      } else {
        // Evtl. reicht Enter
        await codeInput.press('Enter');
        log('  2FA-Code per Enter abgeschickt...');
      }

      await delay(8000);
      await takeDebugScreenshot(page, 'autologin_04_after_2fa');

      // Moeglicherweise: "Geraet merken" Dialog
      const trustButton = await findElement(page, [
        { type: 'role', value: 'button:Continue', description: 'trust device continue' },
        { type: 'role', value: 'button:Weiter', description: 'trust device weiter' },
        { type: 'css', value: 'button[type="submit"]', description: 'trust submit' },
      ], 'Geraet-merken Dialog', { timeout: 3000 });

      if (trustButton) {
        await trustButton.click();
        log('  "Geraet merken" bestaetigt');
        await delay(5000);
      }
    }

    // 6. Login-Erfolg pruefen
    await page.goto(CONFIG.BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(5000);
    await takeDebugScreenshot(page, 'autologin_05_billing_check');

    const finalUrl = page.url();
    if (finalUrl.includes('login') || finalUrl.includes('checkpoint')) {
      log('  FEHLER: Login offenbar fehlgeschlagen (immer noch auf Login-Seite)');
      return false;
    }

    // 7. Neue Session speichern
    await page.context().storageState({ path: CONFIG.AUTH_FILE });
    log('  Auto-Login erfolgreich! Neue Session gespeichert.');
    return true;

  } catch (e) {
    log('  Auto-Login Fehler: ' + e.message);
    await takeDebugScreenshot(page, 'autologin_error');
    return false;
  }
}

/**
 * Wechselt das aktive Werbekonto im Billing-Bereich.
 * Meta nutzt asset_id und payment_account_id als URL-Parameter (nicht act=).
 * @returns {Promise<boolean>} true wenn Wechsel erfolgreich
 */
async function switchAdAccount(page, accountId, businessId) {
  log(`Wechsle zu Werbekonto: ${accountId}`);

  const numericId = accountId.replace('act_', '');

  // Strategie 1: URL mit asset_id + payment_account_id (Meta-internes Format)
  const urlParams = new URLSearchParams({
    asset_id: numericId,
    placement: 'standalone',
    payment_account_id: numericId,
  });
  if (businessId) urlParams.set('business_id', businessId);
  const billingUrl = `${CONFIG.BILLING_URL}?${urlParams.toString()}`;

  log(`  Navigiere zu: ${billingUrl}`);
  await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(5000);
  await takeDebugScreenshot(page, `switch_account_${numericId}_url`);

  // Pruefen ob das richtige Konto geladen wurde (im Combobox oben rechts)
  const combobox = page.locator('[role=combobox][aria-haspopup=listbox]').first();
  const comboText = await combobox.textContent().catch(() => '');
  if (comboText.includes(numericId)) {
    log(`  URL-Methode erfolgreich: ${comboText.trim()}`);
    return true;
  }

  // Strategie 2: Dropdown oeffnen und Account suchen
  log(`  URL-Methode hat anderes Konto geladen (${comboText.trim()}), versuche Dropdown...`);

  await combobox.click();
  await delay(2000);
  await takeDebugScreenshot(page, `switch_account_${numericId}_dropdown_open`);

  // In der Dropdown-Liste nach Account-ID suchen (role=menu)
  const accountOption = await findElement(page, [
    { type: 'css', value: `[role=menu] :text("${numericId}")`, description: 'menu item with account ID' },
    { type: 'textRegex', value: numericId, description: 'text containing account ID' },
  ], `Account Option ${accountId}`, { timeout: 3000 });

  if (accountOption) {
    await accountOption.click();
    await delay(5000);
    await takeDebugScreenshot(page, `switch_account_${numericId}_selected`);
    log(`  Dropdown-Methode erfolgreich`);
    return true;
  }

  // "Weitere Werbekonten ansehen" klicken falls Account nicht direkt sichtbar
  const moreAccounts = await findElement(page, [
    { type: 'textRegex', value: 'Weitere Werbekonten|More ad accounts', description: 'More accounts link' },
  ], 'Weitere Werbekonten Link', { timeout: 3000 });

  if (moreAccounts) {
    await moreAccounts.click();
    await delay(3000);
    await takeDebugScreenshot(page, `switch_account_${numericId}_more_accounts`);

    const accountOption2 = await findElement(page, [
      { type: 'textRegex', value: numericId, description: 'text containing account ID after expand' },
    ], `Account Option ${accountId} (expanded)`, { timeout: 5000 });

    if (accountOption2) {
      await accountOption2.click();
      await delay(5000);
      log(`  Account gefunden nach 'Weitere Werbekonten'`);
      return true;
    }
  }

  // Dropdown schliessen
  await page.keyboard.press('Escape');
  log(`  WARNUNG: Account-Wechsel konnte nicht verifiziert werden`);
  await takeDebugScreenshot(page, `switch_account_${numericId}_failed`);
  return false;
}

/**
 * Setzt den Datumsfilter auf der Billing-Seite.
 * Meta nutzt Unix-Timestamps im URL-Parameter date=FROM_TO.
 * Dates kommen als YYYY-MM-DD Strings rein.
 */
async function setDateRange(page, dateFrom, dateTo) {
  log(`Setze Zeitraum: ${dateFrom} bis ${dateTo}`);

  // Meta nutzt Unix-Timestamps (Sekunden) im date= URL-Parameter
  const fromTs = Math.floor(new Date(dateFrom + 'T00:00:00').getTime() / 1000);
  const toTs = Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000);

  const url = new URL(page.url());
  url.searchParams.set('date', `${fromTs}_${toTs}`);

  log(`  Navigiere mit date=${fromTs}_${toTs}`);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(5000);
  await takeDebugScreenshot(page, 'date_range_set');

  // Verifizieren: Date-Button sollte den neuen Zeitraum anzeigen
  const dateButton = page.locator('[role=button]').filter({ hasText: /\d{2}\.\d{2}\.\d{4}/ }).first();
  const dateText = await dateButton.textContent().catch(() => '');
  if (dateText) {
    log(`  Datumsbereich angezeigt: ${dateText.trim()}`);
  }
}

/**
 * Findet alle "PDF herunterladen" Links in der Transaktionsliste und laedt die PDFs.
 * Meta-Billing zeigt pro Transaktion einen Link mit href /ads/manage/billing_transaction/?...&pdf=true
 */
async function downloadReceipts(page, accountId, outputDir) {
  log(`Suche Receipts fuer ${accountId}...`);
  ensureDir(outputDir);

  const downloaded = [];

  // Warte bis die Transaktionsliste geladen ist
  await delay(5000);
  await takeDebugScreenshot(page, `receipts_${accountId}_page_loaded`);

  // Pruefen ob "Keine Transaktionen" angezeigt wird
  const noTx = await page.locator('text=/Keine Transaktionen/').count();
  if (noTx > 0) {
    log(`  Keine Transaktionen fuer diesen Zeitraum.`);
    return downloaded;
  }

  // Strategie 1: "PDF herunterladen" Links (Meta-spezifisch)
  // Diese Links haben role="link" und href mit /ads/manage/billing_transaction/...&pdf=true
  const pdfLinks = await findAllElements(page, [
    { type: 'css', value: 'a[href*="billing_transaction"][href*="pdf=true"]', description: 'billing_transaction PDF links' },
    { type: 'role', value: 'link:PDF herunterladen', description: 'link role PDF herunterladen' },
    { type: 'role', value: 'link:PDF download', description: 'link role PDF download' },
    { type: 'textRegex', value: 'PDF herunterladen|PDF download', description: 'text PDF herunterladen' },
    { type: 'label', value: 'Download', description: 'aria-label Download' },
    { type: 'label', value: 'Herunterladen', description: 'aria-label Herunterladen' },
    { type: 'css', value: 'a[href$=".pdf"]', description: 'PDF links' },
  ], 'PDF Download Links', { timeout: 8000 });

  if (pdfLinks) {
    const { locator, count, strategy } = pdfLinks;
    log(`  Gefunden: ${count} PDF-Links via ${strategy}`);

    for (let i = 0; i < count; i++) {
      try {
        const element = locator.nth(i);

        if (!(await element.isVisible())) {
          log(`    Link ${i + 1}/${count}: nicht sichtbar, ueberspringe`);
          continue;
        }

        // Href extrahieren fuer den Dateinamen
        const href = await element.getAttribute('href').catch(() => '');
        const txIdMatch = href.match(/txid=([^&]+)/);
        const txId = txIdMatch ? txIdMatch[1] : `${i + 1}`;
        const filename = `receipt_${accountId}_${txId}.pdf`;

        await takeDebugScreenshot(page, `receipts_${accountId}_before_click_${i + 1}`);

        // Versuche Download-Event abzufangen (manche Links triggern einen Download)
        try {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 10000 }),
            element.click(),
          ]);

          const suggestedName = download.suggestedFilename() || filename;
          const savePath = path.join(outputDir, suggestedName);
          await download.saveAs(savePath);

          downloaded.push({
            file: savePath,
            filename: suggestedName,
            account: accountId,
          });
          log(`    Heruntergeladen: ${suggestedName}`);
        } catch (downloadErr) {
          // Kein Download-Event - Link oeffnet moeglicherweise neuen Tab mit PDF
          const pages = page.context().pages();
          if (pages.length > 1) {
            const newPage = pages[pages.length - 1];
            log(`    Neuer Tab erkannt, speichere PDF...`);
            try {
              await newPage.waitForLoadState('load', { timeout: 15000 });
              const pdfPath = path.join(outputDir, filename);
              const pdfBuffer = await newPage.pdf({ format: 'A4' });
              fs.writeFileSync(pdfPath, pdfBuffer);
              downloaded.push({
                file: pdfPath,
                filename,
                account: accountId,
              });
              log(`    PDF aus Tab gespeichert: ${filename}`);
              await newPage.close();
            } catch (tabErr) {
              log(`    Tab-PDF fehlgeschlagen: ${tabErr.message}`);
              try { await newPage.close(); } catch (_) {}
            }
          } else {
            // Link hat weder Download noch Tab geoeffnet - versuche direkt per HTTP
            if (href && href.startsWith('/')) {
              log(`    Versuche direkten HTTP-Download: ${href}`);
              try {
                const fullUrl = `https://business.facebook.com${href}`;
                const response = await page.context().request.get(fullUrl);
                if (response.ok()) {
                  const pdfPath = path.join(outputDir, filename);
                  fs.writeFileSync(pdfPath, await response.body());
                  downloaded.push({
                    file: pdfPath,
                    filename,
                    account: accountId,
                  });
                  log(`    HTTP-Download erfolgreich: ${filename}`);
                }
              } catch (httpErr) {
                log(`    HTTP-Download fehlgeschlagen: ${httpErr.message}`);
              }
            }
          }
        }

        await delay(2000); // Pause zwischen Downloads
      } catch (e) {
        log(`    Link ${i + 1}/${count}: ${e.message}`);
        await takeDebugScreenshot(page, `receipts_${accountId}_error_${i + 1}`);
      }
    }
  }

  // Strategie 2: Diagnose-Screenshot wenn nichts gefunden
  if (downloaded.length === 0 && !pdfLinks) {
    const screenshotPath = path.join(outputDir, `debug_${accountId}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log(`  Keine PDF-Links gefunden. Debug-Screenshot: ${screenshotPath}`);
  }

  return downloaded;
}

// ─── Hauptlogik (importierbar) ───────────────────────────────────────────────

/**
 * Fuehrt den Scraper aus. Kann als Modul importiert oder per CLI aufgerufen werden.
 *
 * @param {object} options
 * @param {string[]} options.accounts - Werbekonto-IDs (z.B. ['act_123'])
 * @param {string} [options.dateFrom] - Startdatum YYYY-MM-DD
 * @param {string} [options.dateTo] - Enddatum YYYY-MM-DD
 * @param {string} [options.businessId] - Meta Business ID
 * @param {string} [options.authFile] - Pfad zur auth.json
 * @param {string} [options.credentialsFile] - Pfad zur credentials.enc
 * @param {string} [options.credentialKey] - Entschluesselungs-Key
 * @param {string} [options.downloadDir] - Ausgabe-Verzeichnis
 * @param {string} [options.debugDir] - Debug-Screenshot-Verzeichnis
 * @param {boolean} [options.debug] - Debug-Modus
 * @returns {Promise<{success: boolean, downloaded: number, files: Array, ...}>}
 */
async function runScraper(options = {}) {
  // Config fuer diesen Lauf zusammensetzen
  CONFIG = {
    ...DEFAULT_CONFIG,
    ...(options.authFile && { AUTH_FILE: options.authFile }),
    ...(options.downloadDir && { DOWNLOAD_DIR: options.downloadDir }),
    ...(options.debugDir && { DEBUG_DIR: options.debugDir }),
    ...(options.credentialsFile && { CREDENTIALS_FILE: options.credentialsFile }),
    ...(options.credentialKey && { CREDENTIAL_KEY: options.credentialKey }),
    ...(options.businessId && { BUSINESS_ID: options.businessId }),
    ...(options.debug !== undefined && { DEBUG: options.debug }),
  };

  const accounts = options.accounts || [];
  const dateFrom = options.dateFrom || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const dateTo = options.dateTo || new Date().toISOString().split('T')[0];
  const business_id = options.businessId || CONFIG.BUSINESS_ID;

  if (accounts.length === 0) {
    return { success: false, error: 'NO_ACCOUNTS', message: 'Keine Werbekonten angegeben.' };
  }

  const hasAuthFile = fs.existsSync(CONFIG.AUTH_FILE);
  const hasCredentials = CONFIG.CREDENTIAL_KEY && fs.existsSync(CONFIG.CREDENTIALS_FILE);

  if (!hasAuthFile && !hasCredentials) {
    return {
      success: false,
      error: 'NO_AUTH',
      message: 'Weder Session (auth.json) noch Credentials (credentials.enc) gefunden.',
    };
  }

  log(`Starte Meta Invoice Scraper`);
  log(`Konten: ${accounts.length} | Zeitraum: ${dateFrom} -> ${dateTo}`);
  log(`Auth: ${hasAuthFile ? 'Session vorhanden' : 'Keine Session'} | ${hasCredentials ? 'Credentials vorhanden' : 'Keine Credentials'}`);
  if (CONFIG.DEBUG) {
    log(`DEBUG-Modus aktiv. Screenshots werden in ${CONFIG.DEBUG_DIR} gespeichert.`);
  }

  const browser = await chromium.launch({
    headless: CONFIG.HEADLESS,
    slowMo: CONFIG.SLOW_MO,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const contextOptions = {
    acceptDownloads: true,
    locale: 'de-DE',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  if (hasAuthFile) {
    contextOptions.storageState = CONFIG.AUTH_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const allDownloaded = [];

  try {
    log('Pruefe Session...');
    let sessionValid = hasAuthFile ? await checkSession(page) : false;

    if (!sessionValid) {
      if (hasCredentials) {
        sessionValid = await autoLogin(page);
        if (!sessionValid) {
          await browser.close();
          return {
            success: false,
            error: 'AUTO_LOGIN_FAILED',
            message: 'Automatischer Login fehlgeschlagen. Bitte Credentials pruefen oder login.js manuell ausfuehren.',
          };
        }
      } else {
        await browser.close();
        return {
          success: false,
          error: 'SESSION_EXPIRED',
          message: 'Session abgelaufen und keine Credentials hinterlegt.',
        };
      }
    } else {
      log('Session gueltig');
    }

    for (let idx = 0; idx < accounts.length; idx++) {
      const accountId = accounts[idx];
      log(`\n${'---'.repeat(20)}`);
      log(`Verarbeite: ${accountId} (${idx + 1}/${accounts.length})`);
      log(`${'---'.repeat(20)}`);

      const accountDir = path.join(CONFIG.DOWNLOAD_DIR, accountId.replace('act_', ''));
      ensureDir(accountDir);

      try {
        const switchSuccess = await switchAdAccount(page, accountId, business_id);
        if (!switchSuccess) {
          log(`  Account-Wechsel fehlgeschlagen fuer ${accountId}, ueberspringe.`);
          continue;
        }
        await setDateRange(page, dateFrom, dateTo);
        const receipts = await downloadReceipts(page, accountId, accountDir);
        allDownloaded.push(...receipts);
        log(`  ${receipts.length} Receipt(s) fuer ${accountId}`);
      } catch (e) {
        log(`  FEHLER bei ${accountId}: ${e.message}`);
        await takeDebugScreenshot(page, `error_${accountId}`);
      }

      if (idx < accounts.length - 1) {
        log(`  Pause 3s vor naechstem Account...`);
        await delay(3000);
      }
    }

    await context.storageState({ path: CONFIG.AUTH_FILE });
    log('Session aktualisiert');

  } catch (e) {
    log(`Kritischer Fehler: ${e.message}`);
  } finally {
    await browser.close();
  }

  return {
    success: true,
    downloaded: allDownloaded.length,
    accounts_processed: accounts.length,
    files: allDownloaded,
    dateRange: { from: dateFrom, to: dateTo },
    debug_mode: CONFIG.DEBUG,
    timestamp: new Date().toISOString(),
  };
}

// ─── CLI-Modus ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const jsonArg = process.argv.slice(2).filter(a => !a.startsWith('--'))[0];
  const input = JSON.parse(jsonArg || process.env.SCRAPER_INPUT || '{}');

  runScraper({
    accounts: input.accounts,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    businessId: input.business_id,
  }).then(result => {
    console.log('\n--- RESULT_JSON ---');
    console.log(JSON.stringify(result, null, 2));
    console.log('--- END_RESULT ---');
    if (!result.success) process.exit(1);
  }).catch(e => {
    console.error(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = { runScraper };
