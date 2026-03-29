#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '7842');
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const PUBLIC_DIR = __dirname;

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function tailLines(fp, n = 100) {
  try {
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.min(n, lines.length));
  } catch { return []; }
}

function getLocalIPs() {
  const ips = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const cfg of iface || []) {
      if (cfg.family === 'IPv4' && !cfg.internal) ips.push(cfg.address);
    }
  }
  return ips;
}

function sanitizeConfig(cfg) {
  const s = JSON.parse(JSON.stringify(cfg));
  if (s.channels?.telegram) {
    delete s.channels.telegram.botToken;
    for (const a of Object.values(s.channels.telegram.accounts || {})) delete a.botToken;
  }
  if (s.gateway?.auth) delete s.gateway.auth.token;
  if (s.auth?.profiles) {
    for (const p of Object.values(s.auth.profiles)) { delete p.access; delete p.refresh; }
  }
  return s;
}

function parseLogLine(line) {
  // Parse gateway.log format: "2026-03-29T16:30:01.791Z [subsystem] message"
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[([^\]]+)\]\s+(.*)$/);
  if (m) return { ts: m[1], subsystem: m[2], msg: m[3], level: m[3].includes('ERROR') || m[2].includes('error') ? 'error' : m[3].includes('WARN') ? 'warn' : 'info' };
  return { ts: null, subsystem: null, msg: line, level: 'debug' };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
};

const FILE_PRIORITY = ['SOUL.md','USER.md','AGENTS.md','HEARTBEAT.md','IDENTITY.md','MEMORY.md','TOOLS.md'];

// --- Route handlers ---
const routes = {};

routes['GET /api/health'] = (req, res) => {
  const logLines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), 5);
  const lastLog = logLines[logLines.length - 1] || '';
  const lastLogTs = lastLog.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] || null;
  const gatewayActive = lastLogTs ? (Date.now() - new Date(lastLogTs).getTime()) < 600_000 : false;
  res.json({ ok: true, uptime: process.uptime(), localIPs: getLocalIPs(), gatewayActive, lastLogTs });
};

routes['GET /api/bots'] = (req, res) => {
  const cfg = readJSON(path.join(OPENCLAW_DIR, 'openclaw.json'));
  if (!cfg) return res.err(503, 'openclaw config not found');
  const sessions = readJSON(path.join(OPENCLAW_DIR, 'agents/main/sessions/sessions.json')) || {};
  const telegram = cfg.channels?.telegram || {};
  const accounts = { default: { name: 'Main', ...(telegram.accounts?.default || {}) }, ...(telegram.accounts || {}) };
  // Check gateway liveness from log
  const logLines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), 20);
  const lastLogLine = logLines[logLines.length - 1] || '';
  const lastLogTs = lastLogLine.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1] || null;
  const gatewayActive = lastLogTs ? (Date.now() - new Date(lastLogTs).getTime()) < 600_000 : false;
  // Count active sessions per account
  const sessionCounts = {};
  for (const [key, s] of Object.entries(sessions)) {
    const acc = s.deliveryContext?.accountId || 'default';
    sessionCounts[acc] = (sessionCounts[acc] || 0) + 1;
  }
  // Get most recent session activity
  let lastActive = null;
  for (const s of Object.values(sessions)) {
    if (!lastActive || s.updatedAt > lastActive) lastActive = s.updatedAt;
  }
  const bots = [];
  for (const [id, acc] of Object.entries(accounts)) {
    bots.push({
      id,
      name: acc.name || id,
      enabled: acc.enabled !== false,
      channel: 'telegram',
      online: gatewayActive && acc.enabled !== false,
      sessions: sessionCounts[id] || 0,
      lastActive: id === 'default' ? lastActive : null,
      dmPolicy: acc.dmPolicy || telegram.dmPolicy,
    });
  }
  res.json(bots);
};

routes['GET /api/jobs'] = (req, res) => {
  const jobs = readJSON(path.join(OPENCLAW_DIR, 'cron/jobs.json'));
  res.json(jobs || []);
};

routes['GET /api/runs'] = (req, res, query) => {
  const jobId = query.get('jobId');
  const limit = Math.min(parseInt(query.get('limit') || '20'), 100);
  if (!jobId || !/^[a-f0-9-]{36}$/.test(jobId)) return res.err(400, 'invalid jobId');
  const fp = path.join(OPENCLAW_DIR, 'cron/runs', `${jobId}.jsonl`);
  const lines = tailLines(fp, limit);
  const runs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(runs);
};

routes['GET /api/files'] = (req, res) => {
  const dir = path.join(OPENCLAW_DIR, 'workspace');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .map(f => { const st = fs.statSync(path.join(dir, f)); return { name: f, size: st.size, modified: st.mtimeMs }; })
      .sort((a, b) => {
        const ai = FILE_PRIORITY.indexOf(a.name), bi = FILE_PRIORITY.indexOf(b.name);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1; if (bi >= 0) return 1;
        // JOB_ files next
        const aJob = a.name.startsWith('JOB_') || a.name.startsWith('AI_');
        const bJob = b.name.startsWith('JOB_') || b.name.startsWith('AI_');
        if (aJob && !bJob) return -1; if (!aJob && bJob) return 1;
        return a.name.localeCompare(b.name);
      });
    res.json(files);
  } catch { res.json([]); }
};

routes['GET /api/file'] = (req, res, query) => {
  const name = query.get('name');
  if (!name || !name.endsWith('.md') || name.includes('/') || name.includes('..')) return res.err(400, 'invalid name');
  const fp = path.join(OPENCLAW_DIR, 'workspace', name);
  try {
    const content = fs.readFileSync(fp, 'utf8');
    const st = fs.statSync(fp);
    res.json({ name, content, size: st.size, modified: st.mtimeMs });
  } catch { res.err(404, 'not found'); }
};

routes['GET /api/logs'] = (req, res, query) => {
  const n = Math.min(parseInt(query.get('n') || '100'), 500);
  const lines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), n);
  res.json(lines.map(parseLogLine));
};

routes['GET /api/sessions'] = (req, res) => {
  const raw = readJSON(path.join(OPENCLAW_DIR, 'agents/main/sessions/sessions.json')) || {};
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    result[k] = { sessionId: v.sessionId, updatedAt: v.updatedAt, chatType: v.chatType,
      accountId: v.deliveryContext?.accountId, channel: v.deliveryContext?.channel,
      abortedLastRun: v.abortedLastRun, compactionCount: v.compactionCount };
  }
  res.json(result);
};

// --- Server ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  res.json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  res.err  = (c, m) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: m })); };

  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname.replace(/\/$/, '') || '/'}`;
  const handler = routes[key];
  if (handler) { try { handler(req, res, url.searchParams); } catch (e) { res.err(500, e.message); } return; }

  // Static files
  let fp = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  // Security: don't serve outside PUBLIC_DIR
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const data = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\n🦞 ClawMonitor`);
  console.log(`   Local:   http://localhost:${PORT}/`);
  ips.forEach(ip => console.log(`   Network: http://${ip}:${PORT}/`));
  console.log(`\n   📱 Add to phone: http://${ips[0] || 'YOUR_IP'}:${PORT}/\n`);
});
