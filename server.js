const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');

const port = process.env.PORT || 80;
const root = __dirname;
const submissionsFile = path.join(root, 'contact-submissions.ndjson');
const workersFile = path.join(root, 'admin-workers.json');
const tasksFile = path.join(root, 'admin-tasks.json');
const invoicesFile = path.join(root, 'admin-invoices.json');

const smtpHost = process.env.SMTP_HOST || process.env.SMTP_SERVER;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
const mailFrom = process.env.MAIL_FROM || process.env.SMTP_FROM || smtpUser;
const mailTo = process.env.MAIL_TO;

const ollamaEnabled = String(process.env.OLLAMA_ENABLED || 'false').toLowerCase() === 'true';
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const agentApiKey = process.env.AGENT_API_KEY || '';
const pythonPath = process.env.PYTHON_PATH || 'python3';
const agentsDir = path.join(__dirname, 'agents');
const agentRunner = path.join(agentsDir, 'agent_runner.py');
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'ABA2026!';

const emailEnabled = Boolean(smtpHost && smtpPort && smtpUser && smtpPass && mailFrom && mailTo);
const VALID_TASK_STATUSES = ['open', 'in_progress', 'done'];
const VALID_INVOICE_TYPES = ['abschlagsrechnung', 'schlussrechnung'];
const DEFAULT_ISSUER_DETAILS = {
  company: 'ABA GmbH',
  manager: 'Geschäftsführer / Inhaber: Ledjan Ahmati',
  registry: 'Amtsgericht Bochum HRB: 21069',
  address: 'Wattenscheider Hellweg 199\n44867 Bochum',
  phone: '0171 / 303 16 16',
  email: 'mailabagmbh@gmail.com',
  bankName: 'Sparkasse Bochum',
  iban: 'DE06 4305 0001 0011 7967 37',
  bic: 'WELADED1BOC',
  vatId: 'DE364303365'
};

const mailTransport = emailEnabled
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    })
  : null;

// Cache-Control TTLs for static assets (in seconds)
const cacheTTL = {
  '.html': 0,
  '.css': 31536000,
  '.js': 31536000,
  '.png': 2592000,
  '.jpg': 2592000,
  '.jpeg': 2592000,
  '.svg': 2592000,
  '.ico': 2592000
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

const mimeTypes = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.txt': 'text/plain; charset=UTF-8',
  '.xml': 'application/xml; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=UTF-8' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const normalized = Number(String(value).replace(',', '.'));
  return Number.isFinite(normalized) ? normalized : 0;
}

async function ensureJsonFile(filePath, fallbackValue) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    await fs.promises.writeFile(filePath, JSON.stringify(fallbackValue, null, 2), 'utf8');
  }
}

async function readJsonFile(filePath, fallbackValue) {
  await ensureJsonFile(filePath, fallbackValue);

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    if (!raw.trim()) {
      return fallbackValue;
    }

    return JSON.parse(raw);
  } catch (error) {
    return fallbackValue;
  }
}

async function writeJsonFile(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  await fs.promises.writeFile(tempPath, serialized, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}

async function readWorkers() {
  const workers = await readJsonFile(workersFile, []);
  return Array.isArray(workers) ? workers : [];
}

async function writeWorkers(workers) {
  await writeJsonFile(workersFile, workers);
}

async function readTasks() {
  const tasks = await readJsonFile(tasksFile, []);
  return Array.isArray(tasks) ? tasks : [];
}

async function writeTasks(tasks) {
  await writeJsonFile(tasksFile, tasks);
}

async function readInvoices() {
  const invoices = await readJsonFile(invoicesFile, []);
  return Array.isArray(invoices) ? invoices : [];
}

async function writeInvoices(invoices) {
  await writeJsonFile(invoicesFile, invoices);
}

function getInvoiceTypeLabel(invoiceType) {
  return invoiceType === 'schlussrechnung' ? 'Schlussrechnung' : 'Abschlagsrechnung';
}

function generateInvoiceNumber(existingInvoices) {
  const year = new Date().getFullYear();
  const prefix = `RE-${year}-`;
  const yearInvoices = existingInvoices.filter((invoice) => String(invoice.invoiceNumber || '').startsWith(prefix));
  const nextNumber = String(yearInvoices.length + 1).padStart(3, '0');
  return `${prefix}${nextNumber}`;
}

function generateWorkerAccessCode() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

function formatGermanDate(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('de-DE');
}

function computeDueDate(issueDate, paymentTermDays) {
  const baseDate = issueDate ? new Date(issueDate) : new Date();
  if (Number.isNaN(baseDate.getTime())) {
    return '';
  }

  baseDate.setDate(baseDate.getDate() + Math.max(0, Math.round(normalizeNumber(paymentTermDays))));
  return baseDate.toISOString().slice(0, 10);
}

function calculateInvoiceTotals(items, vatRate, retentionPercent, alreadyPaid) {
  const netAmount = roundCurrency(items.reduce((sum, item) => {
    return sum + (normalizeNumber(item.quantity) * normalizeNumber(item.unitPrice));
  }, 0));
  const vatAmount = roundCurrency(netAmount * (normalizeNumber(vatRate) / 100));
  const grossAmount = roundCurrency(netAmount + vatAmount);
  const retentionAmount = roundCurrency(grossAmount * (normalizeNumber(retentionPercent) / 100));
  const alreadyPaidAmount = roundCurrency(normalizeNumber(alreadyPaid));
  const payableAmount = roundCurrency(grossAmount - retentionAmount - alreadyPaidAmount);

  return {
    netAmount,
    vatAmount,
    grossAmount,
    retentionAmount,
    alreadyPaidAmount,
    payableAmount
  };
}

function buildInvoiceCompliance(invoiceInput, items) {
  const invoiceTypeLabel = getInvoiceTypeLabel(invoiceInput.invoiceType);
  const hasContractReference = Boolean(String(invoiceInput.contractReference || '').trim());
  const hasServicePeriod = Boolean(String(invoiceInput.servicePeriod || '').trim());
  const hasItemization = Array.isArray(items) && items.length > 0;
  const hasPreviousPayments = normalizeNumber(invoiceInput.alreadyPaid) > 0;
  const hasRetention = normalizeNumber(invoiceInput.retentionPercent) > 0;
  const hasIssuer = Boolean(String(invoiceInput.issuerCompany || '').trim() && String(invoiceInput.issuerAddress || '').trim());
  const hasIssueDate = Boolean(String(invoiceInput.issueDate || '').trim());
  const hasServiceDate = Boolean(String(invoiceInput.serviceDate || '').trim());
  const hasTaxReference = Boolean(String(invoiceInput.taxNumber || '').trim() || String(invoiceInput.vatId || '').trim() || invoiceInput.isReverseCharge);
  const hasDueDate = Boolean(String(invoiceInput.dueDate || '').trim());
  const hasVobReference = Boolean(String(invoiceInput.vobReference || '').trim());
  const paymentNote = invoiceInput.isReverseCharge
    ? 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG) ist vermerkt. In diesem Fall wird keine Umsatzsteuer ausgewiesen.'
    : `Zahlbar innerhalb von ${Math.max(0, Math.round(normalizeNumber(invoiceInput.paymentTermDays || 14)))} Tagen ohne Abzug.`;
  const legalNote = invoiceInput.invoiceType === 'schlussrechnung'
    ? 'Diese Schlussrechnung orientiert sich an den üblichen Pflichtangaben nach deutschem Rechnungsrecht (§ 14 UStG) und verweist auf die vereinbarte Abrechnung nach VOB/B.'
    : 'Diese Abschlagsrechnung dokumentiert den Leistungsstand gemäß VOB/B und enthält die wesentlichen Pflichtangaben für eine nachvollziehbare Zwischenabrechnung.';

  return {
    hasContractReference,
    hasServicePeriod,
    hasItemization,
    hasPreviousPayments,
    hasRetention,
    hasIssuer,
    hasIssueDate,
    hasServiceDate,
    hasTaxReference,
    hasDueDate,
    hasVobReference,
    invoiceTypeLabel,
    legalNote,
    paymentNote,
    disclaimer: 'Hinweis: Diese Vorlage unterstützt die interne Faktura-Vorbereitung, ersetzt jedoch keine individuelle Steuer- oder Rechtsberatung.'
  };
}

function buildInvoicePrintHtml(invoice) {
  const itemsHtml = invoice.items.map((item, index) => {
    const lineTotal = roundCurrency(normalizeNumber(item.quantity) * normalizeNumber(item.unitPrice));
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.description)}</td>
        <td>${escapeHtml(item.quantity)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td>${escapeHtml(formatCurrency(item.unitPrice))}</td>
        <td>${escapeHtml(formatCurrency(lineTotal))}</td>
      </tr>
    `;
  }).join('');

  const issueDateLabel = formatGermanDate(invoice.issueDate || invoice.createdAt);
  const dueDateLabel = formatGermanDate(invoice.dueDate);
  const serviceDateLabel = formatGermanDate(invoice.serviceDate || invoice.servicePeriod);
  const issuerCompany = invoice.issuerCompany || DEFAULT_ISSUER_DETAILS.company;
  const issuerManager = invoice.issuerManager || DEFAULT_ISSUER_DETAILS.manager;
  const issuerRegistry = invoice.issuerRegistry || DEFAULT_ISSUER_DETAILS.registry;
  const issuerAddress = invoice.issuerAddress || DEFAULT_ISSUER_DETAILS.address;
  const issuerPhone = invoice.issuerPhone || DEFAULT_ISSUER_DETAILS.phone;
  const issuerEmail = invoice.issuerEmail || DEFAULT_ISSUER_DETAILS.email;
  const bankName = invoice.bankName || DEFAULT_ISSUER_DETAILS.bankName;
  const iban = invoice.iban || DEFAULT_ISSUER_DETAILS.iban;
  const bic = invoice.bic || DEFAULT_ISSUER_DETAILS.bic;
  const taxReference = invoice.isReverseCharge
    ? 'Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)'
    : `Steuernummer: ${invoice.taxNumber || '-'} · USt-IdNr.: ${invoice.vatId || DEFAULT_ISSUER_DETAILS.vatId || '-'}`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(invoice.invoiceTypeLabel)} ${escapeHtml(invoice.invoiceNumber)}</title>
  <style>
    :root {
      --green: #2f7d32;
      --green-strong: #1f5f25;
      --line: #dfe7df;
      --surface: #f7faf7;
      --text: #1b2a1d;
      --muted: #5f6f61;
      --warn: #fff6df;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--text);
      background: white;
    }
    .sheet {
      max-width: 980px;
      margin: 0 auto;
    }
    .header, .totals, .compliance, .notes, .meta, .customer, .issuer, .payment-box {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      margin-bottom: 18px;
      background: var(--surface);
    }
    .brand {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
    }
    h1, h2, h3, p {
      margin-top: 0;
    }
    h1 {
      color: var(--green-strong);
      margin-bottom: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 18px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #edf5ed;
      color: var(--green-strong);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .totals table td:last-child, .totals table th:last-child {
      text-align: right;
    }
    .muted {
      color: var(--muted);
    }
    .callout {
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--warn);
      border: 1px solid #ead9a7;
      margin-top: 12px;
    }
    ul {
      padding-left: 18px;
    }
    @media print {
      body {
        padding: 0;
      }
      .sheet {
        max-width: none;
      }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="brand">
        <div>
          <h1>${escapeHtml(issuerCompany)}</h1>
          <p class="muted">Rechnungsvorlage mit VOB/B- und § 14 UStG-Hinweisen</p>
          <p><strong>${escapeHtml(issuerManager)}</strong><br>${escapeHtml(issuerRegistry)}</p>
          <p>${escapeHtml(issuerAddress).replace(/\n/g, '<br>')}</p>
          <p>Tel.: ${escapeHtml(issuerPhone)}<br>E-Mail: ${escapeHtml(issuerEmail)}</p>
        </div>
        <div>
          <p><strong>${escapeHtml(invoice.invoiceTypeLabel)}</strong></p>
          <p>Rechnungsnummer: ${escapeHtml(invoice.invoiceNumber)}</p>
          <p>Rechnungsdatum: ${escapeHtml(issueDateLabel)}</p>
          <p>Fällig am: ${escapeHtml(dueDateLabel)}</p>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="customer">
        <h3>Kunde</h3>
        <p><strong>${escapeHtml(invoice.customerName)}</strong></p>
        <p>${escapeHtml(invoice.customerAddress).replace(/\n/g, '<br>')}</p>
        <p><strong>Kunden-USt-IdNr.:</strong> ${escapeHtml(invoice.customerVatId || '-')}</p>
      </div>
      <div class="meta">
        <h3>Projektdaten</h3>
        <p><strong>Projekt:</strong> ${escapeHtml(invoice.projectName)}</p>
        <p><strong>Vertragsreferenz:</strong> ${escapeHtml(invoice.contractReference || '-')}</p>
        <p><strong>Leistungszeitraum:</strong> ${escapeHtml(invoice.servicePeriod || '-')}</p>
        <p><strong>Leistungsdatum:</strong> ${escapeHtml(serviceDateLabel)}</p>
        <p><strong>VOB/B-Bezug:</strong> ${escapeHtml(invoice.vobReference || '-')}</p>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Pos.</th>
          <th>Beschreibung</th>
          <th>Menge</th>
          <th>Einheit</th>
          <th>Einzelpreis</th>
          <th>Gesamt</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>

    <div class="totals">
      <h3>Summen</h3>
      <table>
        <tbody>
          <tr><td>Nettobetrag</td><td>${escapeHtml(formatCurrency(invoice.totals.netAmount))}</td></tr>
          <tr><td>Umsatzsteuer (${escapeHtml(invoice.vatRate)} %)</td><td>${escapeHtml(formatCurrency(invoice.totals.vatAmount))}</td></tr>
          <tr><td>Bruttobetrag</td><td>${escapeHtml(formatCurrency(invoice.totals.grossAmount))}</td></tr>
          <tr><td>Sicherheitseinbehalt (${escapeHtml(invoice.retentionPercent)} %)</td><td>${escapeHtml(formatCurrency(invoice.totals.retentionAmount))}</td></tr>
          <tr><td>Bereits gezahlt</td><td>${escapeHtml(formatCurrency(invoice.totals.alreadyPaidAmount))}</td></tr>
          <tr><th>Zahlbetrag</th><th>${escapeHtml(formatCurrency(invoice.totals.payableAmount))}</th></tr>
        </tbody>
      </table>
    </div>

    <div class="payment-box">
      <h3>Steuer- und Zahlungshinweise</h3>
      <p>${escapeHtml(taxReference)}</p>
      <p>${escapeHtml(invoice.compliance.paymentNote || '-')}</p>
      <p><strong>Bankverbindung:</strong><br>${escapeHtml(bankName)}<br>IBAN: ${escapeHtml(iban)}<br>BIC: ${escapeHtml(bic)}</p>
      ${invoice.isReverseCharge ? '<div class="callout"><strong>Hinweis:</strong> Gemäß § 13b UStG schuldet der Leistungsempfänger die Umsatzsteuer.</div>' : ''}
    </div>

    <div class="compliance">
      <h3>Pflichtangaben & VOB/B-Check</h3>
      <p>${escapeHtml(invoice.compliance.legalNote)}</p>
      <ul>
        <li>Rechnungsaussteller vollständig: ${invoice.compliance.hasIssuer ? 'Ja' : 'Nein'}</li>
        <li>Rechnungsdatum angegeben: ${invoice.compliance.hasIssueDate ? 'Ja' : 'Nein'}</li>
        <li>Steuerreferenz vorhanden: ${invoice.compliance.hasTaxReference ? 'Ja' : 'Nein'}</li>
        <li>Vertragsreferenz vorhanden: ${invoice.compliance.hasContractReference ? 'Ja' : 'Nein'}</li>
        <li>Leistungszeitraum angegeben: ${invoice.compliance.hasServicePeriod ? 'Ja' : 'Nein'}</li>
        <li>Leistungsdatum dokumentiert: ${invoice.compliance.hasServiceDate ? 'Ja' : 'Nein'}</li>
        <li>Positionen aufgeschlüsselt: ${invoice.compliance.hasItemization ? 'Ja' : 'Nein'}</li>
        <li>Vorherige Zahlungen dokumentiert: ${invoice.compliance.hasPreviousPayments ? 'Ja' : 'Nein'}</li>
        <li>Einbehalt berücksichtigt: ${invoice.compliance.hasRetention ? 'Ja' : 'Nein'}</li>
        <li>Fälligkeitsdatum hinterlegt: ${invoice.compliance.hasDueDate ? 'Ja' : 'Nein'}</li>
        <li>VOB/B-Bezug dokumentiert: ${invoice.compliance.hasVobReference ? 'Ja' : 'Nein'}</li>
      </ul>
      <p class="muted">${escapeHtml(invoice.compliance.disclaimer || '')}</p>
    </div>

    <div class="notes">
      <h3>Anmerkungen</h3>
      <p>${escapeHtml(invoice.notes || 'Keine zusätzlichen Hinweise.').replace(/\n/g, '<br>')}</p>
    </div>
  </div>
</body>
</html>`;
}

function formatCurrency(value) {
  return `${roundCurrency(value).toFixed(2)} €`;
}

// Real visitor IP: Cloudflare sets CF-Connecting-IP; fall back to X-Forwarded-For or socket
function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress
  );
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;

      if (body.length > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendSubmission(record) {
  return fs.promises.appendFile(submissionsFile, `${JSON.stringify(record)}\n`);
}

const AGENT_TASKS = {
  lead_qualification: {
    description: 'Kualifikon lead-in e kontaktit dhe jep prioritet + hapat e ardhshëm.',
    prompt: `
Je një asistent profesional për ABA GmbH (Generalunternehmer në Bochum).
Detyra: Analizo lead-in dhe kthe një vlerësim praktik për ekipin e shitjes.

Kërkesat:
- Shkruaj qartë, profesionalisht, pa ekzagjerime.
- Vlerëso prioritetin: HIGH, MEDIUM ose LOW.
- Jep 3 rreziqe kryesore dhe 3 hapa të rekomanduar.
- Jep një draft përgjigjeje të shkurtër për klientin në gjermanisht.
- Mos shpik fakte; bazohu vetëm te të dhënat hyrëse.

Kthe rezultatin në JSON me këtë strukturë:
{
  "priority": "HIGH|MEDIUM|LOW",
  "reasoning": "...",
  "risks": ["..."],
  "nextSteps": ["..."],
  "clientReplyDe": "..."
}
    `.trim()
  },
  client_followup_email: {
    description: 'Gjeneron email ndjekës profesional për klientin.',
    prompt: `
Je copywriter biznesi për ABA GmbH.
Detyra: Shkruaj një email ndjekës profesional në gjermanisht për një klient që ka dërguar formularin.

Kërkesat:
- Ton profesional, i qartë, i sjellshëm.
- Maksimumi 170 fjalë.
- Përfshi: falënderim, përmbledhje të kërkesës, hapi i radhës, kohë përgjigjeje.
- Mos përdor premtime absolute dhe mos shpik informacion.

Kthe JSON:
{
  "subject": "...",
  "bodyDe": "..."
}
    `.trim()
  },
  project_risk_scan: {
    description: 'Bën skanim paraprak të rreziqeve të projektit.',
    prompt: `
Je konsultant teknik për ndërtim për ABA GmbH.
Detyra: Bëj risk scan paraprak për një projekt ndërtimi bazuar në të dhënat e klientit.

Kërkesat:
- Jep vetëm vlerësim paraprak, jo vendim final teknik.
- Klasifiko rreziqet sipas: afat, buxhet, leje, koordinim.
- Jep kontroll-listë verifikimi për takim në terren.
- Mos shpik norma ligjore ose numra të pa dhënë në input.

Kthe JSON:
{
  "riskByCategory": {
    "schedule": "...",
    "budget": "...",
    "permits": "...",
    "coordination": "..."
  },
  "siteVisitChecklist": ["..."],
  "summary": "..."
}
    `.trim()
  }
};

// ── Python agent bridge ──────────────────────────────────────────────────────
function runPythonAgent(agentName, task, data) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ agent: agentName, task, data });
    const proc = spawn(pythonPath, [agentRunner, input], {
      env: { ...process.env },
      timeout: Number(process.env.AGENT_TIMEOUT || 120) * 1000
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(stderr.trim() || `Python agent exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function runOllamaTask(taskName, data) {
  if (!ollamaEnabled) {
    throw new Error('Ollama agent is disabled.');
  }

  const task = AGENT_TASKS[taskName];
  if (!task) {
    throw new Error('Unknown task.');
  }

  const userPayload = JSON.stringify(data || {}, null, 2);

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      format: 'json',
      prompt: `${task.prompt}\n\nInput data:\n${userPayload}`
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status}).`);
  }

  const result = await response.json();
  return {
    task: taskName,
    model: ollamaModel,
    output: String(result.response || '').trim()
  };
}

async function runPublicWebsiteChat(message) {
  if (!ollamaEnabled) {
    throw new Error('Chat assistant is currently unavailable.');
  }

  const userMessage = String(message || '').trim().slice(0, 1000);
  if (!userMessage) {
    throw new Error('Message is required.');
  }

  const systemPrompt = `Du bist ein freundlicher Assistent der ABA GmbH, einem Generalunternehmer aus Bochum.
Antworte immer auf Deutsch. Halte dich kurz und klar.
Regeln:
- Gib nur allgemeine Informationen zu Leistungen, Ablauf, Kontakt und nächsten Schritten.
- Nenne keine festen Preise, festen Termine oder absolute Versprechen.
- Bei Anfragen zu konkreten Angeboten: Verweis auf das Kontaktformular.
- Antworte immer auf Deutsch, auch wenn der Nutzer eine andere Sprache verwendet.`.trim();

  const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: ollamaModel,
      stream: false,
      prompt: `${systemPrompt}\n\nUser question:\n${userMessage}`
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed (${response.status}).`);
  }

  const result = await response.json();
  return {
    model: ollamaModel,
    reply: String(result.response || '').trim()
  };
}

async function sendSubmissionEmail(submission, ip) {
  if (!mailTransport) {
    throw new Error('E-Mail-Versand ist nicht konfiguriert.');
  }

  const subject = `Neue Anfrage über Website: ${submission.projectType || 'Allgemein'}`;
  const text = [
    'Neue Kontaktanfrage',
    '',
    `Name/Firma: ${submission.name}`,
    `E-Mail: ${submission.email}`,
    `Telefon: ${submission.phone || '-'}`,
    `Anliegen: ${submission.leadIntent || '-'}`,
    `Projektart: ${submission.projectType}`,
    `Projektbeschreibung: ${submission.message || '-'}`,
    `IP: ${ip || '-'}`,
    `Zeit: ${submission.submittedAt}`
  ].join('\n');

  const html = `
    <h2>Neue Kontaktanfrage</h2>
    <p><strong>Name/Firma:</strong> ${escapeHtml(submission.name)}</p>
    <p><strong>E-Mail:</strong> ${escapeHtml(submission.email)}</p>
    <p><strong>Telefon:</strong> ${escapeHtml(submission.phone || '-')}</p>
    <p><strong>Anliegen:</strong> ${escapeHtml(submission.leadIntent || '-')}</p>
    <p><strong>Projektart:</strong> ${escapeHtml(submission.projectType)}</p>
    <p><strong>Projektbeschreibung:</strong><br>${escapeHtml(submission.message || '-').replace(/\n/g, '<br>')}</p>
    <hr>
    <p><strong>IP:</strong> ${escapeHtml(ip || '-')}</p>
    <p><strong>Zeit:</strong> ${escapeHtml(submission.submittedAt)}</p>
  `;

  await mailTransport.sendMail({
    from: mailFrom,
    to: mailTo,
    replyTo: submission.email,
    subject,
    text,
    html
  });
}

// ── Auth helper for agent endpoints ────────────────────────────────────────
function requireAgentKey(req, res) {
  const key = req.headers['x-agent-key'] || req.headers['x-api-key'];
  if (!agentApiKey || key !== agentApiKey) {
    sendJson(res, 401, { error: 'Unauthorized agent request.' });
    return false;
  }
  return true;
}

function isValidAdminCredentials(username, password) {
  return String(username || '').trim() === adminUsername && String(password || '').trim() === adminPassword;
}

function requireAdminCredentials(req, res) {
  const username = req.headers['x-admin-user'];
  const password = req.headers['x-admin-password'];

  if (!isValidAdminCredentials(username, password)) {
    sendJson(res, 401, { error: 'Admin-Anmeldung erforderlich.' });
    return false;
  }

  return true;
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/admin/login') {
    collectRequestBody(req).then((body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const username = String(payload.username || '').trim();
      const password = String(payload.password || '').trim();

      if (!isValidAdminCredentials(username, password)) {
        sendJson(res, 401, { error: 'Benutzername oder Passwort ist nicht korrekt.' });
        return;
      }

      sendJson(res, 200, {
        success: true,
        username,
        officeModules: ['workers', 'tasks', 'invoices']
      });
    }).catch(() => {
      sendJson(res, 500, { error: 'Admin-Login konnte nicht verarbeitet werden.' });
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/admin/bootstrap') {
    if (!requireAdminCredentials(req, res)) {
      return;
    }

    Promise.all([readWorkers(), readTasks(), readInvoices()]).then(([workers, tasks, invoices]) => {
      const stats = {
        workerCount: workers.length,
        activeWorkerCount: workers.filter((worker) => worker.status === 'active').length,
        openTaskCount: tasks.filter((task) => task.status === 'open').length,
        inProgressTaskCount: tasks.filter((task) => task.status === 'in_progress').length,
        doneTaskCount: tasks.filter((task) => task.status === 'done').length,
        invoiceCount: invoices.length,
        payableInvoiceTotal: roundCurrency(invoices.reduce((sum, invoice) => sum + normalizeNumber(invoice.totals && invoice.totals.payableAmount), 0))
      };

      sendJson(res, 200, { workers, tasks, invoices, stats });
    }).catch(() => {
      sendJson(res, 500, { error: 'Admin-Daten konnten nicht geladen werden.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/workers') {
    if (!requireAdminCredentials(req, res)) {
      return;
    }

    collectRequestBody(req).then(async (body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const firstName = String(payload.firstName || '').trim();
      const lastName = String(payload.lastName || '').trim();
      const role = String(payload.role || '').trim();
      const email = String(payload.email || '').trim();
      const phone = String(payload.phone || '').trim();
      const trade = String(payload.trade || '').trim();
      const employmentType = String(payload.employmentType || 'Festanstellung').trim();
      const availability = String(payload.availability || 'verfügbar').trim();
      const hourlyRate = normalizeNumber(payload.hourlyRate);
      const startDate = String(payload.startDate || '').trim();
      const notes = String(payload.notes || '').trim();
      const accessCode = String(payload.accessCode || generateWorkerAccessCode()).trim();
      const skillTags = Array.isArray(payload.skillTags)
        ? payload.skillTags.map((item) => String(item).trim()).filter(Boolean)
        : String(payload.skillTags || trade)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

      if (!firstName || !lastName || !role || !email) {
        sendJson(res, 400, { error: 'Bitte Vorname, Nachname, Rolle und E-Mail angeben.' });
        return;
      }

      const workers = await readWorkers();
      const existingWorker = workers.find((entry) => String(entry.email || '').toLowerCase() === email.toLowerCase());
      if (existingWorker) {
        sendJson(res, 409, { error: 'Für diese E-Mail existiert bereits ein Mitarbeiter.' });
        return;
      }

      const worker = {
        id: createId('worker'),
        firstName,
        lastName,
        role,
        email,
        phone,
        trade,
        employmentType,
        availability,
        skillTags,
        hourlyRate,
        startDate,
        notes,
        accessCode,
        portalEnabled: true,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        status: 'active'
      };

      workers.push(worker);
      await writeWorkers(workers);
      sendJson(res, 201, worker);
    }).catch(() => {
      sendJson(res, 500, { error: 'Mitarbeiter konnte nicht gespeichert werden.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/tasks') {
    if (!requireAdminCredentials(req, res)) {
      return;
    }

    collectRequestBody(req).then(async (body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const title = String(payload.title || '').trim();
      const description = String(payload.description || '').trim();
      const projectName = String(payload.projectName || '').trim();
      const priority = String(payload.priority || 'mittel').trim();
      const dueDate = String(payload.dueDate || '').trim();
      const siteAddress = String(payload.siteAddress || '').trim();
      const instructions = String(payload.instructions || '').trim();
      const estimatedHours = normalizeNumber(payload.estimatedHours);
      const createdBy = String(payload.createdBy || '').trim();
      const assignedWorkerIds = Array.isArray(payload.assignedWorkerIds)
        ? payload.assignedWorkerIds.map((item) => String(item).trim()).filter(Boolean)
        : [];

      if (!title || !projectName || !priority || !createdBy) {
        sendJson(res, 400, { error: 'Bitte Titel, Projekt, Priorität und Ersteller angeben.' });
        return;
      }

      const workers = await readWorkers();
      const validWorkerIds = new Set(workers.map((worker) => worker.id));
      const invalidWorkerId = assignedWorkerIds.find((workerId) => !validWorkerIds.has(workerId));

      if (invalidWorkerId) {
        sendJson(res, 400, { error: 'Mindestens ein zugewiesener Mitarbeiter ist ungültig.' });
        return;
      }

      const tasks = await readTasks();
      const task = {
        id: createId('task'),
        title,
        description,
        projectName,
        priority,
        dueDate,
        siteAddress,
        instructions,
        estimatedHours,
        assignedWorkerIds,
        createdBy,
        workerNote: '',
        lastUpdatedAt: new Date().toISOString(),
        status: 'open',
        createdAt: new Date().toISOString()
      };

      tasks.push(task);
      await writeTasks(tasks);
      sendJson(res, 201, task);
    }).catch(() => {
      sendJson(res, 500, { error: 'Aufgabe konnte nicht gespeichert werden.' });
    });
    return;
  }

  if (req.method === 'PATCH' && /^\/api\/admin\/tasks\/[^/]+\/status$/.test(req.url.split('?')[0])) {
    if (!requireAdminCredentials(req, res)) {
      return;
    }

    const match = req.url.split('?')[0].match(/^\/api\/admin\/tasks\/([^/]+)\/status$/);
    const taskId = match && match[1];

    collectRequestBody(req).then(async (body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const status = String(payload.status || '').trim();
      if (!VALID_TASK_STATUSES.includes(status)) {
        sendJson(res, 400, { error: 'Ungültiger Status.' });
        return;
      }

      const tasks = await readTasks();
      const task = tasks.find((entry) => entry.id === taskId);

      if (!task) {
        sendJson(res, 404, { error: 'Aufgabe nicht gefunden.' });
        return;
      }

      task.status = status;
      task.lastUpdatedAt = new Date().toISOString();
      await writeTasks(tasks);
      sendJson(res, 200, task);
    }).catch(() => {
      sendJson(res, 500, { error: 'Status konnte nicht aktualisiert werden.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/worker/login') {
    collectRequestBody(req).then(async (body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const email = String(payload.email || '').trim().toLowerCase();
      const accessCode = String(payload.accessCode || '').trim();

      if (!email || !accessCode) {
        sendJson(res, 400, { error: 'Bitte E-Mail und Zugangscode angeben.' });
        return;
      }

      const workers = await readWorkers();
      const worker = workers.find((entry) => {
        return String(entry.email || '').trim().toLowerCase() === email && String(entry.accessCode || '').trim() === accessCode;
      });

      if (!worker) {
        sendJson(res, 401, { error: 'Anmeldung fehlgeschlagen. Bitte Daten prüfen.' });
        return;
      }

      if (worker.status !== 'active') {
        sendJson(res, 403, { error: 'Dieser Mitarbeiterzugang ist derzeit nicht aktiv.' });
        return;
      }

      worker.lastLoginAt = new Date().toISOString();
      await writeWorkers(workers);

      const tasks = (await readTasks())
        .filter((task) => Array.isArray(task.assignedWorkerIds) && task.assignedWorkerIds.includes(worker.id))
        .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

      sendJson(res, 200, { worker, tasks });
    }).catch(() => {
      sendJson(res, 500, { error: 'Mitarbeiterportal konnte nicht geladen werden.' });
    });
    return;
  }

  if (req.method === 'PATCH' && /^\/api\/worker\/tasks\/[^/]+\/status$/.test(req.url.split('?')[0])) {
    const match = req.url.split('?')[0].match(/^\/api\/worker\/tasks\/([^/]+)\/status$/);
    const taskId = match && match[1];

    collectRequestBody(req).then(async (body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const workerId = String(payload.workerId || '').trim();
      const accessCode = String(payload.accessCode || '').trim();
      const status = String(payload.status || '').trim();
      const note = String(payload.note || '').trim();

      if (!workerId || !accessCode || !VALID_TASK_STATUSES.includes(status)) {
        sendJson(res, 400, { error: 'Bitte gültige Zugangsdaten und einen Status übermitteln.' });
        return;
      }

      const workers = await readWorkers();
      const worker = workers.find((entry) => entry.id === workerId && String(entry.accessCode || '').trim() === accessCode);
      if (!worker) {
        sendJson(res, 401, { error: 'Mitarbeiter konnte nicht verifiziert werden.' });
        return;
      }

      const tasks = await readTasks();
      const task = tasks.find((entry) => entry.id === taskId);
      if (!task) {
        sendJson(res, 404, { error: 'Aufgabe nicht gefunden.' });
        return;
      }

      if (!Array.isArray(task.assignedWorkerIds) || !task.assignedWorkerIds.includes(worker.id)) {
        sendJson(res, 403, { error: 'Diese Aufgabe ist nicht diesem Mitarbeiter zugewiesen.' });
        return;
      }

      task.status = status;
      task.workerNote = note || task.workerNote || '';
      task.lastUpdatedAt = new Date().toISOString();
      await writeTasks(tasks);
      sendJson(res, 200, task);
    }).catch(() => {
      sendJson(res, 500, { error: 'Statusupdate im Mitarbeiterportal fehlgeschlagen.' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/admin/invoices') {
    if (!requireAdminCredentials(req, res)) {
      return;
    }

    collectRequestBody(req).then(async (body) => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (error) {
        sendJson(res, 400, { error: 'Ungültige JSON-Daten.' });
        return;
      }

      const customerName = String(payload.customerName || '').trim();
      const customerAddress = String(payload.customerAddress || '').trim();
      const customerVatId = String(payload.customerVatId || '').trim();
      const invoiceType = String(payload.invoiceType || '').trim();
      const projectName = String(payload.projectName || '').trim();
      const contractReference = String(payload.contractReference || '').trim();
      const servicePeriod = String(payload.servicePeriod || '').trim();
      const issueDate = String(payload.issueDate || new Date().toISOString().slice(0, 10)).trim();
      const serviceDate = String(payload.serviceDate || '').trim();
      const notes = String(payload.notes || '').trim();
      const isReverseCharge = Boolean(payload.isReverseCharge);
      const requestedVatRate = normalizeNumber(payload.vatRate ?? 19);
      const vatRate = isReverseCharge ? 0 : requestedVatRate;
      const retentionPercent = normalizeNumber(payload.retentionPercent);
      const alreadyPaid = normalizeNumber(payload.alreadyPaid);
      const paymentTermDays = Math.max(0, Math.round(normalizeNumber(payload.paymentTermDays ?? 14)));
      const dueDate = String(payload.dueDate || computeDueDate(issueDate, paymentTermDays)).trim();
      const issuerCompany = String(payload.issuerCompany || DEFAULT_ISSUER_DETAILS.company).trim();
      const issuerManager = String(payload.issuerManager || DEFAULT_ISSUER_DETAILS.manager).trim();
      const issuerRegistry = String(payload.issuerRegistry || DEFAULT_ISSUER_DETAILS.registry).trim();
      const issuerAddress = String(payload.issuerAddress || DEFAULT_ISSUER_DETAILS.address).trim();
      const issuerPhone = String(payload.issuerPhone || DEFAULT_ISSUER_DETAILS.phone).trim();
      const issuerEmail = String(payload.issuerEmail || DEFAULT_ISSUER_DETAILS.email).trim();
      const bankName = String(payload.bankName || DEFAULT_ISSUER_DETAILS.bankName).trim();
      const iban = String(payload.iban || DEFAULT_ISSUER_DETAILS.iban).trim();
      const bic = String(payload.bic || DEFAULT_ISSUER_DETAILS.bic).trim();
      const taxNumber = String(payload.taxNumber || '').trim();
      const vatId = String(payload.vatId || DEFAULT_ISSUER_DETAILS.vatId).trim();
      const vobReference = String(payload.vobReference || 'Abrechnung gemäß VOB/B und Vertragsunterlagen').trim();

      const items = Array.isArray(payload.items)
        ? payload.items.map((item) => ({
            description: String(item && item.description || '').trim(),
            quantity: normalizeNumber(item && item.quantity),
            unit: String(item && item.unit || '').trim(),
            unitPrice: normalizeNumber(item && item.unitPrice)
          })).filter((item) => item.description)
        : [];

      if (!customerName || !customerAddress || !invoiceType || !projectName || !issueDate) {
        sendJson(res, 400, { error: 'Bitte Kunde, Adresse, Rechnungsart, Projekt und Rechnungsdatum angeben.' });
        return;
      }

      if (!VALID_INVOICE_TYPES.includes(invoiceType)) {
        sendJson(res, 400, { error: 'Ungültige Rechnungsart.' });
        return;
      }

      if (!items.length) {
        sendJson(res, 400, { error: 'Mindestens eine Rechnungsposition ist erforderlich.' });
        return;
      }

      const invalidItem = items.find((item) => !item.unit || item.quantity <= 0 || item.unitPrice < 0);
      if (invalidItem) {
        sendJson(res, 400, { error: 'Alle Positionen benötigen Beschreibung, Einheit, Menge und Preis.' });
        return;
      }

      const invoices = await readInvoices();
      const totals = calculateInvoiceTotals(items, vatRate, retentionPercent, alreadyPaid);
      const compliance = buildInvoiceCompliance({
        invoiceType,
        issuerCompany,
        issuerAddress,
        issueDate,
        serviceDate,
        dueDate,
        contractReference,
        servicePeriod,
        alreadyPaid,
        retentionPercent,
        taxNumber,
        vatId,
        vobReference,
        paymentTermDays,
        isReverseCharge
      }, items);

      const invoice = {
        id: createId('invoice'),
        invoiceNumber: generateInvoiceNumber(invoices),
        customerName,
        customerAddress,
        customerVatId,
        invoiceType,
        invoiceTypeLabel: getInvoiceTypeLabel(invoiceType),
        projectName,
        contractReference,
        servicePeriod,
        issueDate,
        serviceDate,
        dueDate,
        paymentTermDays,
        issuerCompany,
        issuerManager,
        issuerRegistry,
        issuerAddress,
        issuerPhone,
        issuerEmail,
        bankName,
        iban,
        bic,
        taxNumber,
        vatId,
        vobReference,
        isReverseCharge,
        items,
        vatRate,
        retentionPercent,
        alreadyPaid,
        notes,
        totals,
        compliance,
        createdAt: new Date().toISOString()
      };

      invoices.push(invoice);
      await writeInvoices(invoices);
      sendJson(res, 201, invoice);
    }).catch(() => {
      sendJson(res, 500, { error: 'Rechnung konnte nicht erstellt werden.' });
    });
    return;
  }

  if (req.method === 'GET' && /^\/api\/admin\/invoices\/[^/]+\/print$/.test(req.url.split('?')[0])) {
    const match = req.url.split('?')[0].match(/^\/api\/admin\/invoices\/([^/]+)\/print$/);
    const invoiceId = match && match[1];

    readInvoices().then((invoices) => {
      const invoice = invoices.find((entry) => entry.id === invoiceId);

      if (!invoice) {
        sendHtml(res, 404, '<h1>Rechnung nicht gefunden</h1>');
        return;
      }

      sendHtml(res, 200, buildInvoicePrintHtml(invoice));
    }).catch(() => {
      sendHtml(res, 500, '<h1>Rechnung konnte nicht geladen werden</h1>');
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/agent/tasks') {
    const tasks = Object.entries(AGENT_TASKS).map(([key, value]) => ({
      task: key,
      description: value.description
    }));

    sendJson(res, 200, {
      enabled: ollamaEnabled,
      model: ollamaModel,
      tasks
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/agent/chat') {
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }

      const message = String(payload.message || '').trim();
      if (!message) {
        sendJson(res, 400, { error: 'Message is required.' });
        return;
      }

      try {
        const result = await runPublicWebsiteChat(message);
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 503, { error: e.message || 'Chat unavailable.' });
      }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  // ── POST /agent/scrape ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent/scrape') {
    if (!requireAgentKey(req, res)) return;
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
      const { urls, depth = 1, analyze = true } = payload;
      if (!Array.isArray(urls) || urls.length === 0) { sendJson(res, 400, { error: 'urls[] required.' }); return; }
      try {
        const scraped = await runPythonAgent('WebScraperAgent', 'scrape_links', { urls, depth });
        let ai_analysis = null;
        if (analyze) {
          ai_analysis = await runPythonAgent('DesignGeneratorAgent', 'design_recommendations', {
            project_data: {},
            references: scraped
          });
        }
        sendJson(res, 200, { scraped, ai_analysis });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  // ── POST /agent/design ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent/design') {
    if (!requireAgentKey(req, res)) return;
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
      const { project_type, area, location, preferences, references_urls } = payload;
      let references = {};
      if (Array.isArray(references_urls) && references_urls.length > 0) {
        references = await runPythonAgent('WebScraperAgent', 'scrape_links', { urls: references_urls, depth: 1 });
      }
      try {
        const design = await runPythonAgent('DesignGeneratorAgent', 'generate_concept', {
          project_type, area, location, preferences: preferences || [], references
        });
        sendJson(res, 200, design);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  // ── POST /agent/analyze ────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent/analyze') {
    if (!requireAgentKey(req, res)) return;
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
      try {
        const analysis = await runPythonAgent('ProjectAnalyzerAgent', 'analyze_requirements', payload);
        const cost = await runPythonAgent('ProjectAnalyzerAgent', 'estimate_costs', {
          project_data: analysis,
          location: payload.location || 'Bochum'
        });
        sendJson(res, 200, { analysis, cost_estimate: cost });
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  // ── POST /agent/future-trends ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent/future-trends') {
    if (!requireAgentKey(req, res)) return;
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
      try {
        const result = await runPythonAgent('DesignGeneratorAgent', 'future_trends', payload);
        sendJson(res, 200, result);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  // ── POST /agent/seo ────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent/seo') {
    if (!requireAgentKey(req, res)) return;
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
      const task = String(payload.task || 'seo_audit');
      try {
        const result = await runPythonAgent('SeoAgent', task, payload);
        sendJson(res, 200, result);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  // ── POST /agent/ceo ────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/agent/ceo') {
    if (!requireAgentKey(req, res)) return;
    collectRequestBody(req).then(async (body) => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
      try {
        const result = await runPythonAgent('SeoAgent', 'ceo_brief', payload);
        sendJson(res, 200, result);
      } catch (e) { sendJson(res, 500, { error: e.message }); }
    }).catch(() => sendJson(res, 500, { error: 'Server error.' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/agent/task') {
    if (!requireAgentKey(req, res)) {
      return;
    }

    collectRequestBody(req)
      .then(async (body) => {
        let payload;

        try {
          payload = JSON.parse(body || '{}');
        } catch (error) {
          sendJson(res, 400, { error: 'Invalid JSON body.' });
          return;
        }

        const taskName = String(payload.task || '').trim();
        const taskData = payload.data || {};

        if (!taskName) {
          sendJson(res, 400, { error: 'Task is required.' });
          return;
        }

        try {
          const taskResult = await runOllamaTask(taskName, taskData);
          sendJson(res, 200, taskResult);
        } catch (error) {
          sendJson(res, 500, { error: error.message || 'Agent task failed.' });
        }
      })
      .catch(() => {
        sendJson(res, 500, { error: 'Server error while processing agent task.' });
      });

    return;
  }

  if (req.method === 'POST' && req.url === '/contact') {
    collectRequestBody(req)
      .then(async (body) => {
        let payload;

        try {
          payload = JSON.parse(body || '{}');
        } catch (error) {
          sendJson(res, 400, { error: 'Ungültige Anfrage.' });
          return;
        }

        const submission = {
          name: String(payload.name || '').trim(),
          email: String(payload.email || '').trim(),
          phone: String(payload.phone || '').trim(),
          leadIntent: String(payload.leadIntent || 'Angebot anfordern').trim(),
          projectType: String(payload.projectType || '').trim(),
          message: String(payload.message || '').trim(),
          submittedAt: new Date().toISOString()
        };

        if (!submission.name || !submission.email || !submission.projectType) {
          sendJson(res, 400, { error: 'Bitte Name, E-Mail und Projektart ausfüllen.' });
          return;
        }

        const ip = getClientIp(req);
        const record = { ...submission, ip };

        try {
          await appendSubmission(record);
        } catch (error) {
          sendJson(res, 500, { error: 'Anfrage konnte nicht gespeichert werden.' });
          return;
        }

        try {
          await sendSubmissionEmail(submission, ip);
        } catch (error) {
          sendJson(res, 500, { error: 'Anfrage gespeichert, aber E-Mail konnte nicht gesendet werden.' });
          return;
        }

        sendJson(res, 200, { success: true });
      })
      .catch(() => {
        sendJson(res, 500, { error: 'Serverfehler beim Senden der Anfrage.' });
      });

    return;
  }

  const cleanUrl = req.url.split('?')[0];
  const requestedPath = cleanUrl === '/' ? '/index.html' : cleanUrl;
  const filePath = path.join(root, requestedPath);

  if (!filePath.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('Server Error');
        return;
      }

      const ttl = cacheTTL[ext];
      const cacheHeader = ttl === 0
        ? 'no-store'
        : `public, max-age=${ttl}, immutable`;

      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': contentType,
        'Cache-Control': cacheHeader
      });
      res.end(data);
    });
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`ABA site running on port ${port}`);
});