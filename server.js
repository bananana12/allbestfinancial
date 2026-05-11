const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const ROOT = __dirname;

function loadEnv(filePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  mailTo: process.env.MAIL_TO || 'allbesthowly53@gmail.com',
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      return Promise.resolve(JSON.parse(req.body));
    }
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function validatePayload(payload) {
  const clean = {
    name: String(payload.name || '').trim(),
    phone: String(payload.phone || '').trim(),
    loanType: String(payload.loanType || '').trim(),
    amount: String(payload.amount || '').trim(),
    message: String(payload.message || '').trim(),
    language: String(payload.language || '').trim(),
    pageUrl: String(payload.pageUrl || '').trim(),
  };

  if (!clean.name || !clean.phone) {
    return { ok: false, error: 'Name and phone are required.', clean };
  }
  if (clean.name.length > 120 || clean.phone.length > 60) {
    return { ok: false, error: 'Name or phone is too long.', clean };
  }
  if (clean.message.length > 2000) clean.message = clean.message.slice(0, 2000);
  return { ok: true, clean };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function encodeHeader(value) {
  return '=?UTF-8?B?' + Buffer.from(String(value), 'utf8').toString('base64') + '?=';
}

function wrapBase64(value) {
  return String(value).replace(/.{1,76}/g, '$&\r\n').trim();
}

function extractAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function buildEmail(payload) {
  const subject = `New loan application - ${payload.name}`;
  const rows = [
    ['Name', payload.name],
    ['Phone', payload.phone],
    ['Loan Type', payload.loanType || '-'],
    ['Amount', payload.amount || '-'],
    ['Message', payload.message || '-'],
    ['Language', payload.language || '-'],
    ['Page URL', payload.pageUrl || '-'],
    ['Submitted At', new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })],
  ];

  const html = `<!doctype html>
<html>
<body style="font-family:Arial,sans-serif;color:#222;line-height:1.5">
  <h2 style="color:#085041">New Loan Application</h2>
  <table style="border-collapse:collapse;width:100%;max-width:680px">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="border:1px solid #ddd;background:#f5f5f3;padding:10px;font-weight:bold;width:160px">${escapeHtml(label)}</td>
        <td style="border:1px solid #ddd;padding:10px;white-space:pre-wrap">${escapeHtml(value)}</td>
      </tr>`).join('')}
  </table>
</body>
</html>`;

  const body = wrapBase64(Buffer.from(html, 'utf8').toString('base64'));
  return [
    `From: ${CONFIG.mailFrom}`,
    `To: ${CONFIG.mailTo}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

function parseSmtpResponse(buffer) {
  const newline = buffer.includes('\r\n') ? '\r\n' : '\n';
  const lines = buffer.split(newline);
  if (!buffer.endsWith(newline)) lines.pop();
  if (!lines.length) return null;

  const responseLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    responseLines.push(line);
    if (/^\d{3} /.test(line)) {
      return {
        code: Number(line.slice(0, 3)),
        message: responseLines.join('\n'),
        rest: lines.slice(i + 1).join(newline),
      };
    }
  }
  return null;
}

function expectCode(actual, expected, message) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual.code)) {
    throw new Error(`${message}: ${actual.message}`);
  }
}

async function sendMail(message) {
  if (!CONFIG.smtpUser || !CONFIG.smtpPass || !CONFIG.mailFrom || !CONFIG.mailTo) {
    throw new Error('Email backend is missing SMTP_USER, SMTP_PASS, MAIL_FROM, or MAIL_TO.');
  }

  const socket = tls.connect({
    host: CONFIG.smtpHost,
    port: CONFIG.smtpPort,
    servername: CONFIG.smtpHost,
    rejectUnauthorized: true,
  });

  socket.setEncoding('utf8');
  let buffer = '';

  function readResponse() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('SMTP response timeout'));
      }, 15000);

      function cleanup() {
        clearTimeout(timeout);
        socket.off('data', onData);
        socket.off('error', onError);
      }

      function onError(err) {
        cleanup();
        reject(err);
      }

      function onData(chunk) {
        buffer += chunk;
        const parsed = parseSmtpResponse(buffer);
        if (!parsed) return;
        buffer = parsed.rest || '';
        cleanup();
        resolve(parsed);
      }

      const parsed = parseSmtpResponse(buffer);
      if (parsed) {
        buffer = parsed.rest || '';
        cleanup();
        resolve(parsed);
        return;
      }

      socket.on('data', onData);
      socket.on('error', onError);
    });
  }

  function writeLine(line) {
    socket.write(line + '\r\n');
  }

  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  expectCode(await readResponse(), 220, 'SMTP connection failed');
  writeLine('EHLO localhost');
  expectCode(await readResponse(), 250, 'SMTP EHLO failed');
  writeLine('AUTH LOGIN');
  expectCode(await readResponse(), 334, 'SMTP AUTH LOGIN failed');
  writeLine(Buffer.from(CONFIG.smtpUser, 'utf8').toString('base64'));
  expectCode(await readResponse(), 334, 'SMTP username rejected');
  writeLine(Buffer.from(CONFIG.smtpPass, 'utf8').toString('base64'));
  expectCode(await readResponse(), 235, 'SMTP password rejected');

  writeLine(`MAIL FROM:<${extractAddress(CONFIG.mailFrom)}>`); 
  expectCode(await readResponse(), 250, 'SMTP MAIL FROM failed');

  for (const recipient of CONFIG.mailTo.split(',').map(v => v.trim()).filter(Boolean)) {
    writeLine(`RCPT TO:<${extractAddress(recipient)}>`); 
    expectCode(await readResponse(), [250, 251], 'SMTP RCPT TO failed');
  }

  writeLine('DATA');
  expectCode(await readResponse(), 354, 'SMTP DATA failed');
  socket.write(message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.\r\n');
  expectCode(await readResponse(), 250, 'SMTP message rejected');
  writeLine('QUIT');
  await readResponse().catch(() => null);
  socket.end();
}

async function handleApply(req, res) {
  try {
    const payload = await readJson(req);
    const validated = validatePayload(payload);
    if (!validated.ok) {
      sendJson(res, 400, { ok: false, error: validated.error });
      return;
    }
    await sendMail(buildEmail(validated.clean));
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: 'Email could not be sent.' });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = url.pathname === '/'
    ? (fs.existsSync(path.join(ROOT, 'index.html')) ? '/index.html' : '/test.html')
    : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested.replace(/^\/+/, '')));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === 'POST' && req.url === '/api/apply') {
      handleApply(req, res);
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
  });
}

if (require.main === module) {
  createServer().listen(CONFIG.port, () => {
    console.log(`ALL BEST HOWLY site running at http://localhost:${CONFIG.port}`);
    console.log(`Applications will be emailed to ${CONFIG.mailTo}`);
  });
}

module.exports = { buildEmail, createServer, handleApply, validatePayload };
