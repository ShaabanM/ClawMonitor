#!/usr/bin/env node
'use strict';

// Collects all OpenClaw agent status into data/status.json for GitHub Pages.

const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'status.json');

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
    // Skip unfilled template placeholders
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
    const fileContents = {};
    for (const f of files) {
      if (f.size < 50000) {
        try { fileContents[f.name] = fs.readFileSync(path.join(workDir, f.name), 'utf8'); } catch {}
      }
    }
    return { files, fileContents };
  } catch { return { files: [], fileContents: {} }; }
}

// ── Main collection ──────────────────────────────────────────────────────────
function collect() {
  const cfg = readJSON(path.join(OPENCLAW_DIR, 'openclaw.json'));
  if (!cfg) { console.error('Cannot read openclaw.json'); process.exit(1); }

  const status = { collectedAt: new Date().toISOString(), machine: os.hostname() };

  // Gateway health from logs
  const logLines = tailLines(path.join(OPENCLAW_DIR, 'logs/gateway.log'), 200);
  const lastLogLine = logLines[logLines.length - 1] || '';
  const lastLogTs = lastLogLine.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/)?.[1] || null;
  const gatewayActive = lastLogTs ? (Date.now() - new Date(lastLogTs).getTime()) < 600_000 : false;
  status.health = { gatewayActive, lastLogTs };
  status.logs = logLines.map(parseLogLine);
  status.config = sanitizeConfig(cfg);

  // Discover agents from config
  const agentDefaults = cfg.agents?.defaults || {};
  const agentList = cfg.agents?.list || [{ id: 'main' }];
  const telegram = cfg.channels?.telegram || {};
  const telegramAccounts = telegram.accounts || {};

  // Jobs + runs (shared across agents, filtered by agentId)
  const rawJobs = readJSON(path.join(OPENCLAW_DIR, 'cron/jobs.json'));
  const allJobs = Array.isArray(rawJobs) ? rawJobs : (rawJobs?.jobs || []);

  // Sessions (shared store, filtered by account binding)
  const allSessions = readJSON(path.join(OPENCLAW_DIR, 'agents/main/sessions/sessions.json')) || {};

  // Build per-agent data
  status.agents = agentList.map(agentDef => {
    const id = agentDef.id;
    const isDefault = id === 'main';

    // Workspace path
    const workspace = agentDef.workspace || agentDefaults.workspace || path.join(OPENCLAW_DIR, 'workspace');

    // Identity from IDENTITY.md
    const identityText = readText(path.join(workspace, 'IDENTITY.md'));
    const identity = parseIdentity(identityText);

    // Telegram binding: find account bound to this agent
    // For now: default account → main agent, others by explicit binding
    let telegramInfo = null;
    if (isDefault && telegram.enabled !== false) {
      const acc = telegramAccounts.default || {};
      telegramInfo = {
        account: 'default',
        name: acc.name || identity.name || 'Main',
        enabled: acc.enabled !== false,
        online: gatewayActive && acc.enabled !== false,
      };
    }
    // Check for explicitly bound accounts
    for (const [accId, acc] of Object.entries(telegramAccounts)) {
      if (accId === 'default') continue;
      // TODO: check routing bindings to match accounts to agents
    }

    // Sessions for this agent
    const agentSessions = {};
    const sessionsFile = readJSON(path.join(OPENCLAW_DIR, `agents/${id}/sessions/sessions.json`));
    if (sessionsFile) {
      for (const [k, v] of Object.entries(sessionsFile)) {
        agentSessions[k] = {
          sessionId: v.sessionId, updatedAt: v.updatedAt, chatType: v.chatType,
          accountId: v.deliveryContext?.accountId, channel: v.deliveryContext?.channel,
          abortedLastRun: v.abortedLastRun, compactionCount: v.compactionCount,
        };
      }
    }

    // Last activity from sessions
    let lastActive = null;
    for (const s of Object.values(sessionsFile || {})) {
      if (!lastActive || s.updatedAt > lastActive) lastActive = s.updatedAt;
    }

    // Jobs for this agent
    const agentJobs = allJobs
      .filter(j => (j.agentId || 'main') === id)
      .map(j => {
        const st = j.state || {};
        const sched = j.schedule || {};
        return {
          id: j.id, name: j.name || j.id, description: j.description,
          enabled: j.enabled !== false, agentId: id,
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
      });

    // Runs for each job
    const agentRuns = {};
    for (const j of agentJobs) {
      const fp = path.join(OPENCLAW_DIR, 'cron/runs', `${j.id}.jsonl`);
      const lines = tailLines(fp, 10);
      agentRuns[j.id] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
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

    // Workspace files
    const { files, fileContents } = collectWorkspaceFiles(workspace);

    return {
      id,
      name: identity.name || agentDef.name || id,
      emoji: identity.emoji || null,
      creature: identity.creature || null,
      vibe: identity.vibe || null,
      model: agentDef.model || agentDefaults.model?.primary || null,
      workspace,
      telegram: telegramInfo,
      sessionCount: Object.keys(agentSessions).length,
      lastActive,
      sessions: agentSessions,
      jobs: agentJobs,
      runs: agentRuns,
      files,
      fileContents,
    };
  });

  return status;
}

// ── Write output ─────────────────────────────────────────────────────────────
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const data = collect();
fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
console.log(`Collected ${data.agents.length} agents → ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
