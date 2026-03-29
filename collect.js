#!/usr/bin/env node
'use strict';

// Collects all OpenClaw status into a single static JSON file (data/status.json)
// that GitHub Pages can serve. Run this on a schedule to keep the data fresh.

const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'status.json');

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function tailLines(fp, n = 100) {
  try {
    const buf = fs.readFileSync(fp, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    return lines.slice(-Math.min(n, lines.length));
  } catch { return []; }
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

const FILE_PRIORITY = ['SOUL.md','USER.md','AGENTS.md','HEARTBEAT.md','IDENTITY.md','MEMORY.md','TOOLS.md'];

// ── Collect everything ───────────────────────────────────────────────────────

function collect() {
  const status = { collectedAt: new Date().toISOString(), machine: os.hostname() };

  // Health
  const logLines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), 200);
  const lastLogLine = logLines[logLines.length - 1] || '';
  const lastLogTs = lastLogLine.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/)?.[1] || null;
  const gatewayActive = lastLogTs ? (Date.now() - new Date(lastLogTs).getTime()) < 600_000 : false;
  status.health = { gatewayActive, lastLogTs };

  // Bots
  const cfg = readJSON(path.join(OPENCLAW_DIR, 'openclaw.json'));
  if (cfg) {
    const sessions = readJSON(path.join(OPENCLAW_DIR, 'agents/main/sessions/sessions.json')) || {};
    const telegram = cfg.channels?.telegram || {};
    const accounts = { default: { name: 'Main', ...(telegram.accounts?.default || {}) }, ...(telegram.accounts || {}) };
    const sessionCounts = {};
    for (const [key, s] of Object.entries(sessions)) {
      const acc = s.deliveryContext?.accountId || 'default';
      sessionCounts[acc] = (sessionCounts[acc] || 0) + 1;
    }
    let lastActive = null;
    for (const s of Object.values(sessions)) {
      if (!lastActive || s.updatedAt > lastActive) lastActive = s.updatedAt;
    }
    status.bots = [];
    for (const [id, acc] of Object.entries(accounts)) {
      status.bots.push({
        id, name: acc.name || id, enabled: acc.enabled !== false, channel: 'telegram',
        online: gatewayActive && acc.enabled !== false,
        sessions: sessionCounts[id] || 0,
        lastActive: id === 'default' ? lastActive : null,
        dmPolicy: acc.dmPolicy || telegram.dmPolicy,
      });
    }
    // Sessions detail
    status.sessions = {};
    for (const [k, v] of Object.entries(sessions)) {
      status.sessions[k] = {
        sessionId: v.sessionId, updatedAt: v.updatedAt, chatType: v.chatType,
        accountId: v.deliveryContext?.accountId, channel: v.deliveryContext?.channel,
        abortedLastRun: v.abortedLastRun, compactionCount: v.compactionCount,
      };
    }
    // Config (sanitized)
    status.config = sanitizeConfig(cfg);
  } else {
    status.bots = [];
    status.sessions = {};
    status.config = null;
  }

  // Jobs
  const rawJobs = readJSON(path.join(OPENCLAW_DIR, 'cron/jobs.json'));
  const jobsArr = Array.isArray(rawJobs) ? rawJobs : (rawJobs?.jobs || []);
  status.jobs = jobsArr.map(j => {
    const st = j.state || {};
    const sched = j.schedule || {};
    return {
      id: j.id, name: j.name || j.id, description: j.description,
      enabled: j.enabled !== false, agentId: j.agentId,
      schedule: sched.expr || (typeof j.schedule === 'string' ? j.schedule : null),
      tz: sched.tz || null, sessionTarget: j.sessionTarget,
      model: j.payload?.model || null,
      deliveryMode: j.delivery?.mode || null, deliveryChannel: j.delivery?.channel || null,
      lastRun: st.lastRunAtMs ? new Date(st.lastRunAtMs).toISOString() : null,
      nextRun: st.nextRunAtMs ? new Date(st.nextRunAtMs).toISOString() : null,
      lastStatus: st.lastStatus || st.lastRunStatus || null,
      lastDuration: st.lastDurationMs || null,
      consecutiveErrors: st.consecutiveErrors || 0,
      lastError: st.lastError || null,
      lastDeliveryStatus: st.lastDeliveryStatus || null,
    };
  });

  // Runs (last 10 for each job)
  status.runs = {};
  for (const j of status.jobs) {
    const fp = path.join(OPENCLAW_DIR, 'cron/runs', `${j.id}.jsonl`);
    const lines = tailLines(fp, 10);
    status.runs[j.id] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .map(r => ({
        startedAt: r.runAtMs ? new Date(r.runAtMs).toISOString() : (r.startedAt || null),
        finishedAt: r.ts ? new Date(r.ts).toISOString() : null,
        duration: r.durationMs ?? r.duration ?? null,
        status: r.status || null,
        summary: r.summary || r.error || null,
        error: r.error || null,
        tokens: r.usage?.total_tokens || r.tokens || null,
        model: r.model || null,
      }));
  }

  // Files
  const workDir = path.join(OPENCLAW_DIR, 'workspace');
  try {
    status.files = fs.readdirSync(workDir)
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
    // Include file contents for workspace files (they're small config/job files)
    status.fileContents = {};
    for (const f of status.files) {
      if (f.size < 50000) { // skip anything huge
        try { status.fileContents[f.name] = fs.readFileSync(path.join(workDir, f.name), 'utf8'); } catch {}
      }
    }
  } catch {
    status.files = [];
    status.fileContents = {};
  }

  // Logs (last 150 lines)
  status.logs = logLines.map(parseLogLine);

  return status;
}

// ── Write output ─────────────────────────────────────────────────────────────
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const data = collect();
fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
console.log(`Collected status → ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
