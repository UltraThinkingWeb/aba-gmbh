const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nodemailer = require('nodemailer');

const port = process.env.PORT || 80;
const root = __dirname;
const submissionsFile = path.join(root, 'contact-submissions.ndjson');

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

const emailEnabled = Boolean(smtpHost && smtpPort && smtpUser && smtpPass && mailFrom && mailTo);

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
  '.css':  31536000,
  '.js':   31536000,
  '.png':  2592000,
  '.jpg':  2592000,
  '.jpeg': 2592000,
  '.svg':  2592000,
  '.ico':  2592000
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

  const systemPrompt = `
Je asistent virtual për faqen e ABA GmbH (Generalunternehmer në Bochum).
Rregulla:
- Jep vetëm informacion të përgjithshëm për shërbimet, procesin, kontaktin dhe hapat e ardhshëm.
- Mos shpik çmime fikse, data fikse, apo premtime absolute.
- Nëse kërkohet ofertë finale, orientoni përdoruesin te formulari i kontaktit.
- Përgjigju shkurt dhe qartë, në gjermanisht.
`.trim();

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

const server = http.createServer((req, res) => {
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
