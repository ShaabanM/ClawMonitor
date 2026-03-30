#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = parseInt(process.env.PORT || '7842');
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const PUBLIC_DIR = __dirname;

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
function readText(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
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
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\s+\[([^\]]+)\]\s+(.*)$/);
  if (m) return { ts: m[1], subsystem: m[2], msg: m[3], level: m[3].includes('ERROR') || m[2].includes('error') ? 'error' : m[3].includes('WARN') ? 'warn' : 'info' };
  return { ts: null, subsystem: null, msg: line, level: 'debug' };
}
function parseIdentity(text) {
  if (!text) return {};
  const get = (label) => {
    const m = text.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i'));
    if (!m) return null;
    let v = m[1].trim().replace(/^_\(.*?\)_$/g, '').replace(/^_|_$/g, '').trim();
    if (!v || v.startsWith('(') || v === '—' || v === '-') return null;
    return v;
  };
  return { name: get('Name'), creature: get('Creature'), vibe: get('Vibe'), emoji: get('Emoji') };
}

const FILE_PRIORITY = ['SOUL.md','USER.md','AGENTS.md','HEARTBEAT.md','IDENTITY.md','MEMORY.md','TOOLS.md'];

function collectWorkspaceFiles(workDir) {
  try {
    const files = fs.readdirSync(workDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .map(f => { const st = fs.statSync(path.join(workDir, f)); return { name: f, size: st.size, modified: st.mtimeMs }; })
      .sort((a, b) => {
        const ai = FILE_PRIORITY.indexOf(a.name), bi = FILE_PRIORITY.indexOf(b.name);
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1; if (bi >= 0) return 1;
        const aJob = a.name.startsWith('JOB_') || a.name.startsWith('AI_');
        const bJob = b.name.startsWith('JOB_') || b.name.startsWith('AI_');
        if (aJob && !bJob) return -1; if (!aJob && bJob) return 1;
        return a.name.localeCompare(b.name);
      });
    return files;
  } catch { return []; }
}

function normalizeJob(j, agentId) {
  const st = j.state || {};
  const sched = j.schedule || {};
  return {
    id: j.id, name: j.name || j.id, description: j.description,
    enabled: j.enabled !== false, agentId,
    schedule: sched.expr || (typeof j.schedule === 'string' ? j.schedule : null),
    tz: sched.tz || null, model: j.payload?.model || null,
    deliveryMode: j.delivery?.mode || null,
    lastRun: st.lastRunAtMs ? new Date(st.lastRunAtMs).toISOString() : null,
    nextRun: st.nextRunAtMs ? new Date(st.nextRunAtMs).toISOString() : null,
    lastStatus: st.lastStatus || st.lastRunStatus || null,
    lastDuration: st.lastDurationMs || null,
    consecutiveErrors: st.consecutiveErrors || 0,
    lastError: st.lastError || null,
  };
}

function normalizeRun(r) {
  return {
    startedAt: r.runAtMs ? new Date(r.runAtMs).toISOString() : (r.startedAt || null),
    finishedAt: r.ts ? new Date(r.ts).toISOString() : null,
    duration: r.durationMs ?? r.duration ?? null,
    status: r.status || null,
    summary: r.summary || r.error || null,
    error: r.error || null,
    tokens: r.usage?.total_tokens || r.tokens || null,
    model: r.model || null,
  };
}

// ── Full status collection (same shape as collect.js for static mode) ────────
function collectStatus() {
  const cfg = readJSON(path.join(OPENCLAW_DIR, 'openclaw.json'));
  if (!cfg) return null;

  const logLines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), 200);
  const lastLogLine = logLines[logLines.length - 1] || '';
  const lastLogTs = lastLogLine.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/)?.[1] || null;
  const gatewayActive = lastLogTs ? (Date.now() - new Date(lastLogTs).getTime()) < 600_000 : false;

  const agentDefaults = cfg.agents?.defaults || {};
  const agentList = cfg.agents?.list || [{ id: 'main' }];
  const telegram = cfg.channels?.telegram || {};
  const telegramAccounts = telegram.accounts || {};

  const rawJobs = readJSON(path.join(OPENCLAW_DIR, 'cron/jobs.json'));
  const allJobs = Array.isArray(rawJobs) ? rawJobs : (rawJobs?.jobs || []);

  const agents = agentList.map(agentDef => {
    const id = agentDef.id;
    const isDefault = id === 'main';
    const workspace = agentDef.workspace || agentDefaults.workspace || path.join(OPENCLAW_DIR, 'workspace');

    const identityText = readText(path.join(workspace, 'IDENTITY.md'));
    const identity = parseIdentity(identityText);

    let telegramInfo = null;
    if (isDefault && telegram.enabled !== false) {
      const acc = telegramAccounts.default || {};
      telegramInfo = { account: 'default', name: acc.name || identity.name || 'Main', enabled: acc.enabled !== false, online: gatewayActive && acc.enabled !== false };
    }

    const sessionsFile = readJSON(path.join(OPENCLAW_DIR, `agents/${id}/sessions/sessions.json`)) || {};
    const sessions = {};
    for (const [k, v] of Object.entries(sessionsFile)) {
      sessions[k] = { sessionId: v.sessionId, updatedAt: v.updatedAt, chatType: v.chatType, accountId: v.deliveryContext?.accountId, channel: v.deliveryContext?.channel };
    }
    let lastActive = null;
    for (const s of Object.values(sessionsFile)) { if (!lastActive || s.updatedAt > lastActive) lastActive = s.updatedAt; }

    const jobs = allJobs.filter(j => (j.agentId || 'main') === id).map(j => normalizeJob(j, id));
    const runs = {};
    for (const j of jobs) {
      const fp = path.join(OPENCLAW_DIR, 'cron/runs', `${j.id}.jsonl`);
      runs[j.id] = tailLines(fp, 10).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map(normalizeRun);
    }

    const files = collectWorkspaceFiles(workspace);
    const fileContents = {};
    for (const f of files) {
      if (f.size < 50000) { const c = readText(path.join(workspace, f.name)); if (c) fileContents[f.name] = c; }
    }

    return {
      id, name: identity.name || agentDef.name || id, emoji: identity.emoji || null,
      creature: identity.creature || null, vibe: identity.vibe || null,
      model: agentDef.model || agentDefaults.model?.primary || null, workspace,
      telegram: telegramInfo, sessionCount: Object.keys(sessions).length, lastActive,
      sessions, jobs, runs, files, fileContents,
    };
  });

  return {
    collectedAt: new Date().toISOString(), machine: os.hostname(),
    health: { gatewayActive, lastLogTs },
    logs: logLines.map(parseLogLine),
    config: sanitizeConfig(cfg),
    agents,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
const routes = {};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css', '.png': 'image/png' };

routes['GET /api/health'] = (req, res) => {
  const logLines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), 5);
  const lastLog = logLines[logLines.length - 1] || '';
  const lastLogTs = lastLog.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/)?.[1] || null;
  const gatewayActive = lastLogTs ? (Date.now() - new Date(lastLogTs).getTime()) < 600_000 : false;
  res.json({ ok: true, uptime: process.uptime(), localIPs: getLocalIPs(), gatewayActive, lastLogTs });
};

routes['GET /api/status'] = (req, res) => {
  const status = collectStatus();
  if (!status) return res.err(503, 'openclaw config not found');
  res.json(status);
};

routes['POST /api/gateway/restart'] = (req, res) => {
  exec('launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway', { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) return res.err(500, 'restart failed: ' + (stderr || err.message));
    res.json({ ok: true, message: 'Gateway restart requested' });
  });
};

routes['POST /api/gateway/stop'] = (req, res) => {
  exec('launchctl kill SIGTERM gui/$(id -u)/ai.openclaw.gateway', { timeout: 5000 }, (err) => {
    if (err) return res.err(500, 'stop failed: ' + err.message);
    res.json({ ok: true, message: 'Gateway stop requested' });
  });
};

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  res.json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  res.err  = (c, m) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: m })); };

  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const key = `${req.method} ${pathname}`;
  const handler = routes[key];
  if (handler) { try { handler(req, res, url.searchParams); } catch (e) { res.err(500, e.message); } return; }

  // Static files
  let fp = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
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
