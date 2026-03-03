# Meta Ads Invoice Scraper – Setup Guide

## Überblick

Automatisierter Download von Meta Ads Zahlungsnachweisen (Receipts/Invoices) per Playwright, gesteuert durch n8n, mit Upload nach Google Drive.

```
┌──────────┐    ┌──────────────┐    ┌───────────┐    ┌──────────────┐
│  n8n     │───▶│  Playwright  │───▶│  PDFs     │───▶│ Google Drive │
│  Cron    │    │  Scraper     │    │  lokal    │    │ pro Kunde    │
└──────────┘    └──────────────┘    └───────────┘    └──────────────┘
                       │
                       ▼
               Meta Business Manager
               Billing → Receipts
```

---

## 1. Voraussetzungen

### Auf eurem n8n-Server (VPS/Docker):

```bash
# Node.js 18+ muss installiert sein
node --version

# Playwright System-Dependencies (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install -y libnss3 libnspr4 libdbus-1-3 libatk1.0-0 \
  libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2
```

### Im Meta Business Manager:

- Euer Account braucht **Admin** oder **Finance Editor** Rolle
- Alle Kundenwerbekonten müssen im selben Business Manager liegen
- Zahlungen müssen abgeschlossen sein (Pending = kein Receipt)

---

## 2. Installation

```bash
# Auf eurem Server
cd /opt
git clone <euer-repo> meta-invoice-scraper
# ODER: Dateien manuell hochladen
mkdir -p /opt/meta-invoice-scraper
cd /opt/meta-invoice-scraper

# Dependencies installieren
npm install

# Playwright Chromium Browser installieren
npx playwright install chromium
```

---

## 3. Erstmalige Anmeldung (Session erstellen)

**Das muss einmalig interaktiv geschehen** (wegen 2FA):

### Option A: Direkt auf dem Server (mit Display/VNC)

```bash
cd /opt/meta-invoice-scraper
node login.js
```

Ein Browser-Fenster öffnet sich → einloggen → 2FA bestätigen → Session wird gespeichert.

### Option B: Lokal erstellen und Session hochladen

```bash
# Lokal auf deinem Rechner
npm install
npx playwright install chromium
node login.js

# Danach auth.json auf den Server kopieren
scp auth.json user@server:/opt/meta-invoice-scraper/auth.json
```

### Option C: VNC auf dem Server (falls kein Display)

```bash
# noVNC installieren (z.B. in Docker)
# Dann über Browser auf den Server zugreifen und login.js dort ausführen
```

**Die Session (auth.json) hält in der Regel 30-90 Tage.** Der Scraper aktualisiert sie bei jedem erfolgreichen Run automatisch. Falls sie abläuft, bekommt ihr eine Fehlermeldung im n8n-Workflow.

---

## 4. Konfiguration

### Werbekonten eintragen

Im n8n-Workflow (Node "⚙️ Konfiguration") tragt ihr eure Werbekonten ein:

```javascript
const AD_ACCOUNTS = [
  'act_111111111111',   // Kunde A
  'act_222222222222',   // Kunde B
  'act_333333333333',   // Kunde C
];

const ACCOUNT_NAMES = {
  'act_111111111111': 'Kunde_A_GmbH',
  'act_222222222222': 'Kunde_B_AG',
  'act_333333333333': 'Kunde_C_UG',
};
```

Die Account-IDs findet ihr in eurem Business Manager unter Einstellungen → Werbekonten.

### Google Drive Ordner

Im Node "📁 Drive-Ordner bestimmen" die Folder-ID eintragen:

```javascript
const BASE_FOLDER_ID = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ'; // Aus der Google Drive URL
```

Die Ordnerstruktur wird so angelegt:
```
/Meta Rechnungen/
  /Kunde_A_GmbH/
    /2025-01/
      receipt_act_111_1.pdf
      receipt_act_111_2.pdf
    /2025-02/
  /Kunde_B_AG/
    /2025-01/
```

---

## 5. n8n Workflow importieren

1. In n8n: **Settings → Import Workflow**
2. `n8n-workflow.json` hochladen
3. Google Drive Credentials in n8n konfigurieren (falls nicht vorhanden)
4. Pfad zum Scraper im "Execute Command" Node anpassen falls nötig
5. Manuell testen über den "▶️ Manuell starten" Trigger

---

## 6. Testen

```bash
# Einzeltest auf der Kommandozeile
cd /opt/meta-invoice-scraper

node scraper.js '{"accounts":["act_EURE_ERSTE_ID"],"dateFrom":"2025-01-01","dateTo":"2025-01-31"}'
```

Erwartete Ausgabe:
```
[2025-03-02T10:00:00Z] Starte Meta Invoice Scraper
[2025-03-02T10:00:00Z] Konten: 1 | Zeitraum: 2025-01-01 → 2025-01-31
[2025-03-02T10:00:03Z] Prüfe Session...
[2025-03-02T10:00:06Z] ✅ Session gültig
[2025-03-02T10:00:06Z] Verarbeite: act_EURE_ERSTE_ID
[2025-03-02T10:00:12Z]   Gefunden: 3 Download-Elemente
[2025-03-02T10:00:15Z]   ✅ Heruntergeladen: receipt_001.pdf
...
```

---

## 7. Bekannte Einschränkungen & Workarounds

### ⚠️ Selektoren können brechen
Meta ändert regelmäßig die UI. Wenn der Scraper keine Receipts mehr findet:
1. Script mit `HEADLESS=false` laufen lassen
2. Debug-Screenshots prüfen (werden automatisch erstellt)
3. Selektoren in `scraper.js` → `downloadReceipts()` anpassen

### ⚠️ Session läuft ab
- Normalerweise alle 30-90 Tage
- n8n Workflow gibt Fehlermeldung "SESSION_EXPIRED"
- Lösung: `node login.js` erneut ausführen

### ⚠️ Rate Limiting / Captchas
- `SLOW_MO` in der Config erhöhen (z.B. auf 1000-2000ms)
- Bei häufigen Captchas: Login-Frequenz reduzieren

### ⚠️ Docker-Umgebung
Falls n8n in Docker läuft, muss Playwright im selben Container installiert sein.

```dockerfile
# Beispiel: Playwright zum n8n-Docker hinzufügen
FROM n8nio/n8n:latest

USER root
RUN npm install -g playwright
RUN npx playwright install chromium --with-deps
USER node

COPY meta-invoice-scraper /opt/meta-invoice-scraper
```

---

## 8. Alternativer Ansatz: Session via Browser DevTools

Falls `login.js` nicht funktioniert, könnt ihr die Session auch manuell exportieren:

1. In Chrome: Meta Business Manager öffnen und einloggen
2. DevTools → Application → Cookies → alle facebook.com Cookies kopieren
3. In eine `auth.json` konvertieren (Format: Playwright storageState)

---

## 9. Wartung & Monitoring

- **Monatlich**: Prüfen ob Rechnungen korrekt abgeholt werden
- **Bei Meta UI-Updates**: Selektoren im Scraper anpassen
- **Session-Refresh**: Bei SESSION_EXPIRED Fehler → login.js
- **Empfehlung**: Slack/E-Mail Notification im n8n Workflow bei Fehlern ergänzen
