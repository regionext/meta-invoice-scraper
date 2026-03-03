#!/usr/bin/env node
/**
 * Credential Setup Script
 *
 * Speichert Meta-Login-Daten (E-Mail, Passwort, TOTP-Secret) verschluesselt.
 * Die Datei credentials.enc kann nur mit dem CREDENTIAL_KEY entschluesselt werden.
 *
 * Aufruf:
 *   CREDENTIAL_KEY=mein-geheimer-schluessel node setup-credentials.js
 *
 * Sicherheit:
 * - Passwort wird NICHT in Logs oder auf dem Bildschirm angezeigt
 * - Datei wird mit Berechtigung 600 geschrieben (nur Owner lesen/schreiben)
 * - CREDENTIAL_KEY darf NUR als Umgebungsvariable existieren, NIE in Dateien
 */

const readline = require('readline');
const path = require('path');
const { saveCredentials, loadCredentials, generateTOTP } = require('./crypto-utils');

const CREDENTIALS_FILE = process.env.CREDENTIALS_FILE || path.join(__dirname, 'credentials.enc');
const CREDENTIAL_KEY = process.env.CREDENTIAL_KEY;

function ask(rl, question, hidden = false) {
  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
      // Passwort-Eingabe: Zeichen nicht anzeigen
      process.stdout.write(question);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      let input = '';
      const onData = (char) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit(0);
        } else if (char === '\u007f' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, resolve);
    }
  });
}

async function main() {
  console.log('');
  console.log('Meta Ads Scraper - Credential Setup');
  console.log('=' .repeat(50));
  console.log('');

  if (!CREDENTIAL_KEY) {
    console.error('FEHLER: Umgebungsvariable CREDENTIAL_KEY ist nicht gesetzt!');
    console.error('');
    console.error('Aufruf:');
    console.error('  CREDENTIAL_KEY=dein-geheimer-schluessel node setup-credentials.js');
    console.error('');
    console.error('Der CREDENTIAL_KEY wird zum Ver- und Entschluesseln verwendet.');
    console.error('Er muss sicher aufbewahrt werden (z.B. in Docker env oder .env Datei).');
    process.exit(1);
  }

  if (CREDENTIAL_KEY.length < 16) {
    console.error('FEHLER: CREDENTIAL_KEY muss mindestens 16 Zeichen lang sein!');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('Die folgenden Daten werden AES-256-GCM verschluesselt gespeichert.');
  console.log('Nur mit dem CREDENTIAL_KEY koennen sie wieder entschluesselt werden.');
  console.log('');

  const email = await ask(rl, 'Meta-Login E-Mail: ');
  const password = await ask(rl, 'Meta-Login Passwort: ', true);

  console.log('');
  console.log('TOTP 2FA Secret (optional):');
  console.log('  Dies ist der Base32-Code aus deiner Authenticator-App.');
  console.log('  Du findest ihn beim Einrichten der 2FA (der Code hinter dem QR).');
  console.log('  Beispiel: JBSWY3DPEHPK3PXP');
  console.log('  Leer lassen, wenn du keine automatische 2FA nutzen willst.');
  console.log('');
  const totpSecret = await ask(rl, 'TOTP Secret (oder leer): ');

  rl.close();

  if (!email || !password) {
    console.error('');
    console.error('FEHLER: E-Mail und Passwort sind Pflichtfelder!');
    process.exit(1);
  }

  // TOTP-Test falls angegeben
  if (totpSecret) {
    try {
      const testCode = generateTOTP(totpSecret);
      console.log('');
      console.log('TOTP-Test erfolgreich. Aktueller Code: ' + testCode);
      console.log('(Vergleiche mit deiner Authenticator-App)');
    } catch (e) {
      console.error('');
      console.error('WARNUNG: TOTP-Secret scheint ungueltig: ' + e.message);
      console.error('Bitte pruefen und ggf. erneut ausfuehren.');
    }
  }

  // Credentials speichern
  const credentials = {
    email,
    password,
    totpSecret: totpSecret || '',
    createdAt: new Date().toISOString(),
  };

  saveCredentials(CREDENTIALS_FILE, credentials, CREDENTIAL_KEY);

  console.log('');
  console.log('Credentials erfolgreich verschluesselt gespeichert!');
  console.log('  Datei: ' + CREDENTIALS_FILE);
  console.log('');

  // Verifikation: Lesen und entschluesseln
  try {
    const loaded = loadCredentials(CREDENTIALS_FILE, CREDENTIAL_KEY);
    if (loaded.email === email) {
      console.log('Verifikation: Entschluesselung erfolgreich.');
    }
  } catch (e) {
    console.error('WARNUNG: Verifikation fehlgeschlagen: ' + e.message);
  }

  console.log('');
  console.log('Naechste Schritte:');
  console.log('  1. CREDENTIAL_KEY sicher aufbewahren (z.B. Docker env, Passwort-Manager)');
  console.log('  2. Der Scraper nutzt die Credentials automatisch wenn die Session ablaeuft');
  console.log('  3. Bei Passwort-Aenderung: dieses Script erneut ausfuehren');
  console.log('');
}

main().catch(e => {
  console.error('Fehler: ' + e.message);
  process.exit(1);
});
