#!/usr/bin/env node
/**
 * Meta Login Script – Erstellt eine persistente Session
 * 
 * Oeffnet einen sichtbaren Browser, damit du dich manuell einloggen
 * und ggf. 2FA bestaetigen kannst. Danach wird die Session gespeichert.
 * 
 * Aufruf: node login.js
 * 
 * WICHTIG: Muss auf einem Rechner mit Display laufen (kein headless)!
 *          Alternativ: VNC/noVNC auf dem Server einrichten.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_FILE = process.env.AUTH_FILE || path.join(__dirname, 'auth.json');
const BILLING_URL = 'https://business.facebook.com/billing_hub/payment_activity';

async function main() {
  console.log('Meta Login Script');
  console.log('='.repeat(50));
  console.log('');
  console.log('Ein Browser-Fenster wird geoeffnet.');
  console.log('Bitte logge dich manuell in Meta Business Manager ein.');
  console.log('Nach erfolgreichem Login wird die Session automatisch gespeichert.');
  console.log('');

  const browser = await chromium.launch({
    headless: false, // MUSS sichtbar sein fuer manuellen Login!
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    viewport: null, // Fullscreen
    locale: 'de-DE',
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Zur Billing-Seite navigieren (leitet zu Login weiter falls noetig)
  await page.goto(BILLING_URL);

  console.log('Warte auf erfolgreichen Login...');
  console.log('   (Du hast 5 Minuten Zeit fuer Login + 2FA)');
  console.log('');

  // Warte bis die Billing-Seite geladen ist (= Login erfolgreich)
  try {
    await page.waitForURL('**/billing_hub/**', { timeout: 300000 }); // 5 Min Timeout
    
    // Noch etwas warten bis alles geladen ist
    await page.waitForTimeout(5000);

    // Session speichern
    await context.storageState({ path: AUTH_FILE });

    // Pruefen ob die Datei korrekt geschrieben wurde
    if (!fs.existsSync(AUTH_FILE)) {
      console.error('');
      console.error('FEHLER: auth.json konnte nicht geschrieben werden!');
      console.error(`Pfad: ${AUTH_FILE}`);
      process.exit(1);
    }
    const stats = fs.statSync(AUTH_FILE);
    if (stats.size < 100) {
      console.warn('');
      console.warn('WARNUNG: auth.json ist verdaechtig klein. Moeglicherweise leere Session.');
    }

    console.log('');
    console.log('Login erfolgreich! Session gespeichert.');
    console.log(`   Datei: ${AUTH_FILE} (${stats.size} Bytes)`);
    console.log('');
    console.log('Du kannst den Browser jetzt schliessen.');
    console.log('Der Scraper (scraper.js) kann nun mit dieser Session arbeiten.');

  } catch (e) {
    console.error('');
    console.error('Login-Timeout (5 Minuten ueberschritten).');
    console.error('   Bitte erneut versuchen: node login.js');
  }

  // Browser offen lassen damit User pruefen kann
  console.log('');
  console.log('Druecke Ctrl+C um das Script zu beenden.');
  
  // Warte auf manuelles Beenden
  await new Promise(() => {});
}

main().catch(console.error);
