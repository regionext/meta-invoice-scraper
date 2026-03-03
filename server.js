#!/usr/bin/env node
/**
 * Meta Invoice Scraper - HTTP API Server
 *
 * Stellt den Scraper als HTTP-Service bereit fuer n8n-Integration.
 * Laeuft als Docker-Container auf Coolify (internes Netzwerk, nicht oeffentlich).
 *
 * Endpoints:
 *   GET  /api/health                         - Health Check
 *   POST /api/scrape                         - Scraping-Job starten
 *   GET  /api/download/:customerId/:filename - PDF herunterladen
 *   POST /api/customer/setup                 - Neuen Kunden einrichten
 *   GET  /api/customers                      - Alle Kunden auflisten
 *
 * Sicherheit:
 *   ALLE Endpoints erfordern Authorization: Bearer <SCRAPER_API_KEY>
 *   Unautorisierte Requests erhalten generischen 404 (Server verraet nicht seine Existenz)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runScraper } = require('./scraper');
const {
  getCustomerPaths,
  setupCustomer,
  customerExists,
  listCustomers,
  cleanDownloads,
} = require('./customer-manager');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.SCRAPER_API_KEY || '';

// ─── Job Queue (sequentiell, ein Chromium zur Zeit) ─────────────────────────

let currentJob = null;
const jobQueue = [];

function processQueue() {
  if (currentJob || jobQueue.length === 0) return;
  const next = jobQueue.shift();
  currentJob = next;
  next.run().finally(() => {
    currentJob = null;
    processQueue();
  });
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Ungueltiges JSON im Request-Body'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!API_KEY) return true; // Kein Key konfiguriert = kein Auth (dev mode)
  const authHeader = req.headers['authorization'] || '';
  return authHeader === `Bearer ${API_KEY}`;
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });
  sendJson(res, 200, {
    status: 'ok',
    version: '1.0.0',
    currentJob: currentJob ? currentJob.id : null,
    queueLength: jobQueue.length,
    customers: listCustomers().length,
    timestamp: new Date().toISOString(),
  });
}

async function handleScrape(req, res) {
  if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const { customerId, accounts, dateFrom, dateTo, credentialKey, businessId } = body;

  if (!customerId) return sendJson(res, 400, { error: 'customerId ist erforderlich' });
  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return sendJson(res, 400, { error: 'accounts (Array) ist erforderlich' });
  }
  if (!credentialKey) return sendJson(res, 400, { error: 'credentialKey ist erforderlich' });

  if (!customerExists(customerId)) {
    return sendJson(res, 404, { error: `Kunde '${customerId}' nicht gefunden. Bitte zuerst /api/customer/setup aufrufen.` });
  }

  const jobId = `${customerId}_${Date.now()}`;

  // Pruefe Queue-Laenge
  if (jobQueue.length >= 5) {
    return sendJson(res, 429, { error: 'Zu viele wartende Jobs. Bitte spaeter erneut versuchen.' });
  }

  // Job in Queue einreihen
  const jobPromise = new Promise((resolve) => {
    jobQueue.push({
      id: jobId,
      run: async () => {
        const paths = getCustomerPaths(customerId);
        try {
          const result = await runScraper({
            accounts,
            dateFrom,
            dateTo,
            businessId,
            authFile: paths.auth,
            credentialsFile: paths.credentials,
            credentialKey,
            downloadDir: paths.downloads,
            debugDir: paths.debug,
            debug: process.env.DEBUG === 'true',
          });
          resolve(result);
        } catch (e) {
          resolve({ success: false, error: 'SCRAPER_ERROR', message: e.message });
        }
      },
    });
    processQueue();
  });

  // Warte auf Job-Ergebnis (synchron fuer n8n)
  const result = await jobPromise;

  // Dateigroessen zum Ergebnis hinzufuegen
  if (result.files) {
    result.files = result.files.map(f => ({
      ...f,
      filename: path.basename(f.file || f.filename),
      size: fs.existsSync(f.file) ? fs.statSync(f.file).size : 0,
      downloadUrl: `/api/download/${customerId}/${path.basename(f.file || f.filename)}`,
    }));
  }

  result.jobId = jobId;
  result.customerId = customerId;

  sendJson(res, result.success ? 200 : 500, result);
}

async function handleDownload(req, res, customerId, filename) {
  if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

  // Pfad-Traversal verhindern
  const safeName = path.basename(filename);
  if (safeName !== filename || filename.includes('..')) {
    return sendJson(res, 400, { error: 'Ungueltiger Dateiname' });
  }

  try {
    const paths = getCustomerPaths(customerId);
    const filePath = path.join(paths.downloads, safeName);

    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, { error: `Datei nicht gefunden: ${safeName}` });
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${safeName}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function handleCustomerSetup(req, res) {
  if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const { customerId, email, password, totpSecret, credentialKey } = body;

  if (!customerId) return sendJson(res, 400, { error: 'customerId ist erforderlich' });
  if (!email) return sendJson(res, 400, { error: 'email ist erforderlich' });
  if (!password) return sendJson(res, 400, { error: 'password ist erforderlich' });
  if (!credentialKey) return sendJson(res, 400, { error: 'credentialKey ist erforderlich (min. 16 Zeichen)' });

  try {
    const result = setupCustomer(customerId, { email, password, totpSecret }, credentialKey);
    sendJson(res, 201, {
      success: true,
      customerId,
      message: `Kunde '${customerId}' erfolgreich eingerichtet.`,
    });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function handleCustomerList(req, res) {
  if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });
  sendJson(res, 200, { customers: listCustomers() });
}

async function handleCleanup(req, res) {
  if (!checkAuth(req)) return sendJson(res, 404, { error: 'Not Found' });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const { customerId } = body;
  if (!customerId) return sendJson(res, 400, { error: 'customerId ist erforderlich' });

  try {
    const deleted = cleanDownloads(customerId);
    sendJson(res, 200, { success: true, filesDeleted: deleted });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // GET /api/health
    if (method === 'GET' && pathname === '/api/health') {
      return handleHealth(req, res);
    }

    // POST /api/scrape
    if (method === 'POST' && pathname === '/api/scrape') {
      return handleScrape(req, res);
    }

    // GET /api/download/:customerId/:filename
    const downloadMatch = pathname.match(/^\/api\/download\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && downloadMatch) {
      return handleDownload(req, res, downloadMatch[1], downloadMatch[2]);
    }

    // POST /api/customer/setup
    if (method === 'POST' && pathname === '/api/customer/setup') {
      return handleCustomerSetup(req, res);
    }

    // GET /api/customers
    if (method === 'GET' && pathname === '/api/customers') {
      return handleCustomerList(req, res);
    }

    // POST /api/cleanup
    if (method === 'POST' && pathname === '/api/cleanup') {
      return handleCleanup(req, res);
    }

    // 404
    sendJson(res, 404, { error: 'Not Found' });
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Server-Fehler:`, e.message);
    sendJson(res, 500, { error: 'Interner Server-Fehler' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Meta Invoice Scraper API`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Auth: ${API_KEY ? 'API-Key konfiguriert' : 'WARNUNG: Kein API-Key (SCRAPER_API_KEY nicht gesetzt)'}`);
  console.log(`  Kunden: ${listCustomers().length} konfiguriert`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /api/health`);
  console.log(`    POST /api/scrape`);
  console.log(`    GET  /api/download/:customerId/:filename`);
  console.log(`    POST /api/customer/setup`);
  console.log(`    GET  /api/customers`);
  console.log(`    POST /api/cleanup`);
});
