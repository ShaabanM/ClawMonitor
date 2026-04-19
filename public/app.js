'use strict';

// ─── State ────────────────────────────────────────────────────────────────
const S = {
  tab: 'dashboard',
  agents: [],
  logs: [],
  logFilter: '',
  logLevel: 'all',
  config: null,
  health: null,
  collectedAt: null,
  machine: null,
  ingestedAt: null,
  ingestAgeSec: null,
  expandedAgent: null,
  expandedJob: null,
  agentFilter: null,
  activityFilter: 'all',
  activeFile: null,
  error: null,
  loading: false,
  firstLoad: true,
  online: navigator.onLine,
  lastRefresh: null,
  cfg: { interval: 30, autoRefresh: true },
};
let _refreshTimer = null;
let _freshnessTimer = null;

// ─── Config persistence ───────────────────────────────────────────────────
function loadCfg() {
  try {
    const raw = localStorage.getItem('clawmonitor-cfg3');
    if (raw) Object.assign(S.cfg, JSON.parse(raw));
  } catch {}
}
function saveCfg() {
  try { localStorage.setItem('clawmonitor-cfg3', JSON.stringify(S.cfg)); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const TABS = ['dashboard', 'activity', 'agents', 'jobs', 'files', 'logs', 'settings'];
const TAB_ICONS = {
  dashboard: '🏠', activity: '⚡', agents: '🤖', jobs: '⏱',
  files: '📁', logs: '📋', settings: '⚙️',
};
const TAB_LABELS = {
  dashboard: 'Home', activity: 'Activity', agents: 'Agents', jobs: 'Jobs',
  files: 'Files', logs: 'Logs', settings: 'Settings',
};

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function h(strings, ...values) {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? escHtml(values[i]) : ''), '');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - new Date(ts).getTime();
  if (d < 0) return 'just now';
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  if (d < 7 * 86400000) return Math.floor(d / 86400000) + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeIn(ts) {
  if (!ts) return '—';
  const d = new Date(ts).getTime() - Date.now();
  if (d < 0) return 'overdue';
  if (d < 60000) return 'in ' + Math.floor(d / 1000) + 's';
  if (d < 3600000) return 'in ' + Math.floor(d / 60000) + 'm';
  if (d < 86400000) return 'in ' + Math.floor(d / 3600000) + 'h';
  return 'in ' + Math.floor(d / 86400000) + 'd';
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m + 'm ' + s + 's';
}
function fmtTokens(n) {
  if (!n) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function cronHuman(expr) {
  if (!expr) return '';
  const p = expr.trim().split(/\s+/);
  if (p.length < 5) return expr;
  const [min, hr, dom, mon, dow] = p;
  const fmtTime = (h, m) => {
    const hh = parseInt(h);
    const mm = m.padStart(2, '0');
    return `${hh}:${mm}`;
  };
  if (min === '*' && hr === '*') return 'Every minute';
  if (dom === '*' && mon === '*' && dow === '*') {
    if (min !== '*' && hr !== '*' && !hr.includes('/') && !min.includes('/')) return `Daily ${fmtTime(hr, min)}`;
    if (hr.startsWith('*/')) return `Every ${hr.slice(2)}h`;
    if (min.startsWith('*/')) return `Every ${min.slice(2)}m`;
  }
  if (dom === '*' && mon === '*' && dow !== '*' && min !== '*' && hr !== '*') {
    const d = dow.split(',').map(x => DAY[parseInt(x)] || x).join(',');
    return `${d} ${fmtTime(hr, min)}`;
  }
  return expr;
}

function fileIcon(n) {
  const name = String(n || '');
  if (name === 'SOUL.md') return '🧠';
  if (name === 'USER.md') return '👤';
  if (name === 'AGENTS.md') return '🤖';
  if (name === 'HEARTBEAT.md') return '💓';
  if (name === 'IDENTITY.md') return '🆔';
  if (name === 'MEMORY.md') return '🧠';
  if (name === 'TOOLS.md') return '🔧';
  if (name.startsWith('JOB_')) return '⏱';
  if (name.startsWith('AI_')) return '✨';
  if (name.endsWith('.md')) return '📄';
  return '📋';
}

function avatarColor(name) {
  const colors = ['#7c3aed', '#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#ec4899', '#f43f5e'];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return colors[hash % colors.length];
}

// ─── Safer markdown renderer ─────────────────────────────────────────────
function md2html(text) {
  if (!text) return '';
  // Split out code fences first so their content stays untouched
  const fences = [];
  let s = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    fences.push(`<pre><code${lang ? ` class="lang-${escHtml(lang)}"` : ''}>${escHtml(code)}</code></pre>`);
    return `\u0000F${fences.length - 1}\u0000`;
  });
  s = escHtml(s);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/^---+$/gm, '<hr>');
  s = s.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*?<\/li>\n?)+/g, m => '<ul>' + m + '</ul>');
  s = s.replace(/\[([^\]]+)\]\(((?:https?|mailto:)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.split(/\n{2,}/).map(p => {
    p = p.trim();
    if (!p) return '';
    if (/^<(h[123]|ul|ol|pre|hr|blockquote|\u0000F)/.test(p)) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  s = s.replace(/\u0000F(\d+)\u0000/g, (_, i) => fences[parseInt(i)] || '');
  return s;
}

// ─── API ──────────────────────────────────────────────────────────────────
async function fetchStatus() {
  const res = await fetch('/api/status?t=' + Date.now(), {
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  if (res.status === 404) {
    const err = new Error('No status ingested yet — start the local push agent on the host machine.');
    err.code = 'no_data';
    throw err;
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ─── Data loading ────────────────────────────────────────────────────────
async function refreshAll(opts = {}) {
  if (S.loading) { render(); return; }
  S.loading = true;
  S.error = null;
  const btn = document.getElementById('refresh-btn');
  if (btn) btn.classList.add('spinning');
  if (!opts.silent) renderHeader();
  try {
    const d = await fetchStatus();
    S.agents = d.agents || [];
    S.logs = d.logs || [];
    S.config = d.config || null;
    S.health = d.health || null;
    S.collectedAt = d.collectedAt || null;
    S.machine = d.machine || null;
    S.ingestedAt = d._meta?.ingestedAt || null;
    S.ingestAgeSec = d._meta?.ingestAgeSec || null;
    S.lastRefresh = Date.now();
    S.firstLoad = false;
  } catch (e) {
    S.error = e.message || String(e);
  } finally {
    S.loading = false;
    if (btn) btn.classList.remove('spinning');
    renderHeader();
    render();
    scheduleRefresh();
  }
}

function scheduleRefresh() {
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  if (!S.cfg.autoRefresh) return;
  if (document.hidden) return; // pause when tab is hidden
  _refreshTimer = setTimeout(() => refreshAll({ silent: true }), S.cfg.interval * 1000);
}

function freshnessClass() {
  const ts = S.ingestedAt || S.collectedAt;
  if (!ts) return '';
  const age = Date.now() - new Date(ts).getTime();
  if (age > 30 * 60000) return 'very-stale';
  if (age > 10 * 60000) return 'stale';
  return '';
}

function renderHeader() {
  const el = document.getElementById('refresh-status');
  if (!el) return;
  if (S.lastRefresh) {
    const ts = S.ingestedAt || S.collectedAt;
    el.textContent = ts ? timeAgo(ts) : timeAgo(S.lastRefresh);
    el.className = '';
    el.classList.add(freshnessClass());
  } else if (S.loading) {
    el.textContent = 'loading…';
  } else {
    el.textContent = '';
  }
}

// ─── Helpers: aggregates ─────────────────────────────────────────────────
function getAgent(id) { return S.agents.find(a => a.id === id); }
function allJobs() { return S.agents.flatMap(a => a.jobs || []); }
function allRuns() {
  const flat = [];
  for (const a of S.agents) {
    const byJob = a.runs || {};
    const jobById = Object.fromEntries((a.jobs || []).map(j => [j.id, j]));
    for (const [jobId, runs] of Object.entries(byJob)) {
      const job = jobById[jobId];
      for (const r of runs) {
        flat.push({ ...r, jobId, jobName: job?.name || jobId, agentId: a.id, agentName: a.name, agentEmoji: a.emoji });
      }
    }
  }
  flat.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  return flat;
}
function filteredJobs() { return S.agentFilter ? (getAgent(S.agentFilter)?.jobs || []) : allJobs(); }
function filteredFiles() {
  if (S.agentFilter) {
    const a = getAgent(S.agentFilter);
    return (a?.files || []).map(f => ({ ...f, agentId: a.id, agentName: a.name }));
  }
  return S.agents.flatMap(a => (a.files || []).map(f => ({ ...f, agentId: a.id, agentName: a.name })));
}

// ─── Agent filter pills ──────────────────────────────────────────────────
function renderAgentFilter() {
  if (S.agents.length < 2) return '';
  let html = '<div class="filter-pills">';
  html += `<button class="pill ${!S.agentFilter ? 'active' : ''}" data-action="filter-agent" data-id="">All</button>`;
  for (const a of S.agents) {
    const active = S.agentFilter === a.id ? 'active' : '';
    html += `<button class="pill ${active}" data-action="filter-agent" data-id="${escHtml(a.id)}">${escHtml(a.emoji || '🤖')} ${escHtml(a.name)}</button>`;
  }
  html += '</div>';
  return html;
}

// ─── Skeleton ────────────────────────────────────────────────────────────
function renderSkeleton(rows = 3) {
  let html = '';
  for (let i = 0; i < rows; i++) {
    html += `
      <div class="skel-card">
        <div class="skel-line w1 skeleton"></div>
        <div class="skel-line w2 skeleton"></div>
        <div class="skel-line w3 skeleton"></div>
      </div>`;
  }
  return html;
}

// ─── Dashboard ───────────────────────────────────────────────────────────
function renderDashboard() {
  const gwActive = S.health?.gatewayActive || false;
  const agents = S.agents;
  const onlineAgents = agents.filter(a => a.telegram?.online).length;
  const jobs = allJobs();
  const activeJobs = jobs.filter(j => j.enabled).length;
  const errorJobs = jobs.filter(j => j.consecutiveErrors > 0);
  const nextJob = jobs.filter(j => j.enabled && j.nextRun).sort((a, b) => new Date(a.nextRun) - new Date(b.nextRun))[0];
  const runs = allRuns();
  const last24h = runs.filter(r => Date.now() - new Date(r.startedAt || 0) < 86400000);
  const last24hErrors = last24h.filter(r => r.status !== 'ok' && r.status !== 'success');
  const tokens24h = last24h.reduce((s, r) => s + (r.tokens || 0), 0);

  let html = '';

  // Hero: gateway status
  const heroClass = gwActive ? 'online' : 'offline';
  const heroIcon = gwActive ? '● ACTIVE' : '○ INACTIVE';
  html += `
    <div class="dash-hero">
      <div class="dash-hero-label">
        <span class="dot ${gwActive ? 'green pulse' : 'red'}"></span>
        Gateway ${gwActive ? 'online' : 'offline'}
      </div>
      <div class="dash-hero-value">${onlineAgents} / ${agents.length} <span style="font-size:16px;color:var(--text3);font-weight:500">agents online</span></div>
      <div class="dash-hero-sub">${escHtml(S.machine || '')} · ${S.collectedAt ? escHtml(timeAgo(S.collectedAt)) : 'no data yet'}</div>
    </div>`;

  // Stat cards
  html += '<div class="stat-grid">';
  html += `
    <div class="stat-card ${errorJobs.length > 0 ? 'stat-danger' : ''}">
      <div class="stat-label">⏱ Jobs</div>
      <div class="stat-val">${activeJobs}</div>
      <div class="stat-sub">${errorJobs.length > 0 ? escHtml(errorJobs.length + ' failing') : 'all healthy'}</div>
    </div>`;
  html += `
    <div class="stat-card ${last24hErrors.length > 0 ? 'stat-danger' : 'stat-ok'}">
      <div class="stat-label">⚡ Runs 24h</div>
      <div class="stat-val">${last24h.length}</div>
      <div class="stat-sub">${last24hErrors.length} errors · ${fmtTokens(tokens24h)} tokens</div>
    </div>`;
  html += `
    <div class="stat-card">
      <div class="stat-label">📅 Next run</div>
      <div class="stat-val" style="font-size:18px">${nextJob ? escHtml(timeIn(nextJob.nextRun)) : '—'}</div>
      <div class="stat-sub">${nextJob ? escHtml(nextJob.name) : 'no scheduled jobs'}</div>
    </div>`;
  const totalSessions = agents.reduce((s, a) => s + (a.sessionCount || 0), 0);
  html += `
    <div class="stat-card">
      <div class="stat-label">💬 Sessions</div>
      <div class="stat-val">${totalSessions}</div>
      <div class="stat-sub">across ${agents.length} agent${agents.length !== 1 ? 's' : ''}</div>
    </div>`;
  html += '</div>';

  // Quick actions
  html += `
    <div class="section-header">Quick actions</div>
    <div class="card">
      <div class="ctrl-row">
        <button class="ctrl-btn" data-action="goto" data-tab="activity">⚡ Activity</button>
        <button class="ctrl-btn" data-action="goto" data-tab="jobs">⏱ Jobs</button>
        <button class="ctrl-btn" data-action="goto" data-tab="logs">📋 Logs</button>
        <button class="ctrl-btn" data-action="refresh">↻ Refresh</button>
      </div>
    </div>`;

  // Failing jobs callout
  if (errorJobs.length > 0) {
    html += `<div class="section-header">⚠️ Needs attention</div>`;
    for (const j of errorJobs.slice(0, 5)) {
      const agent = S.agents.find(a => a.id === j.agentId);
      html += `
        <div class="card" data-action="goto-job" data-job-id="${escHtml(j.id)}" style="cursor:pointer">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.name)}</div>
              <div style="font-size:12px;color:var(--text3);margin-top:2px">${escHtml(agent?.name || j.agentId)} · ${escHtml(j.consecutiveErrors)} consecutive errors</div>
            </div>
            <span class="badge badge-red">✗ ${escHtml(j.consecutiveErrors)}</span>
          </div>
        </div>`;
    }
  }

  // Recent activity preview
  if (runs.length > 0) {
    html += `
      <div class="section-header">
        Recent activity
        <button class="sh-right" data-action="goto" data-tab="activity" style="background:none;border:none;color:var(--accent2);cursor:pointer">View all →</button>
      </div>`;
    for (const r of runs.slice(0, 5)) {
      const ok = r.status === 'ok' || r.status === 'success';
      const cls = ok ? 'ok' : 'error';
      const icon = ok ? '✓' : '✗';
      html += `
        <div class="activity-item ${cls}" data-action="goto-job" data-job-id="${escHtml(r.jobId)}">
          <div class="activity-icon">${icon}</div>
          <div class="activity-body">
            <div class="activity-title">${escHtml(r.jobName)}</div>
            <div class="activity-meta">
              <span>${escHtml(r.agentEmoji || '🤖')} ${escHtml(r.agentName)}</span>
              <span>•</span>
              <span>${escHtml(timeAgo(r.startedAt))}</span>
              <span>•</span>
              <span>${escHtml(fmtDuration(r.duration))}</span>
              ${r.tokens ? `<span>•</span><span>${escHtml(fmtTokens(r.tokens))} tok</span>` : ''}
            </div>
          </div>
        </div>`;
    }
  }

  return html;
}

// ─── Activity Timeline ───────────────────────────────────────────────────
function renderActivity() {
  const runs = allRuns();
  const filtered = runs.filter(r => {
    if (S.activityFilter === 'errors') return r.status !== 'ok' && r.status !== 'success';
    if (S.activityFilter === 'ok') return r.status === 'ok' || r.status === 'success';
    if (S.activityFilter && S.activityFilter.startsWith('agent:')) {
      return r.agentId === S.activityFilter.slice(6);
    }
    return true;
  });

  let html = '';
  html += '<div class="filter-pills">';
  html += `<button class="pill ${S.activityFilter === 'all' ? 'active' : ''}" data-action="filter-activity" data-val="all">All ${runs.length}</button>`;
  html += `<button class="pill ${S.activityFilter === 'ok' ? 'active' : ''}" data-action="filter-activity" data-val="ok">✓ OK</button>`;
  html += `<button class="pill ${S.activityFilter === 'errors' ? 'active' : ''}" data-action="filter-activity" data-val="errors">✗ Errors</button>`;
  for (const a of S.agents) {
    const val = 'agent:' + a.id;
    html += `<button class="pill ${S.activityFilter === val ? 'active' : ''}" data-action="filter-activity" data-val="${escHtml(val)}">${escHtml(a.emoji || '🤖')} ${escHtml(a.name)}</button>`;
  }
  html += '</div>';

  if (filtered.length === 0) {
    html += `<div class="empty-state">
      <div class="empty-icon">⚡</div>
      <div class="empty-title">No runs yet</div>
      <div class="empty-hint">Run a job to see activity here</div>
    </div>`;
    return html;
  }

  // Group by date
  const groups = {};
  for (const r of filtered) {
    const d = r.startedAt ? new Date(r.startedAt).toDateString() : 'Unknown';
    (groups[d] = groups[d] || []).push(r);
  }
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86400000).toDateString();

  for (const [date, items] of Object.entries(groups)) {
    const label = date === today ? 'Today' : date === yest ? 'Yesterday' :
      date === 'Unknown' ? 'Unknown' :
      new Date(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    html += `<div class="section-header">${escHtml(label)} <span class="sh-right">${items.length} run${items.length !== 1 ? 's' : ''}</span></div>`;
    for (const r of items.slice(0, 50)) {
      const ok = r.status === 'ok' || r.status === 'success';
      const cls = ok ? 'ok' : 'error';
      const icon = ok ? '✓' : '✗';
      const summary = (r.summary || '').trim();
      html += `
        <div class="activity-item ${cls}" data-action="goto-job" data-job-id="${escHtml(r.jobId)}">
          <div class="activity-icon">${icon}</div>
          <div class="activity-body">
            <div class="activity-title">${escHtml(r.jobName)}</div>
            <div class="activity-meta">
              <span>${escHtml(r.agentEmoji || '🤖')} ${escHtml(r.agentName)}</span>
              <span>•</span>
              <span>${escHtml(r.startedAt ? new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')}</span>
              <span>•</span>
              <span>${escHtml(fmtDuration(r.duration))}</span>
              ${r.tokens ? `<span>•</span><span>${escHtml(fmtTokens(r.tokens))} tok</span>` : ''}
              ${r.model ? `<span>•</span><span class="mono">${escHtml(r.model)}</span>` : ''}
            </div>
            ${summary ? `<div class="activity-summary">${escHtml(summary.slice(0, 220))}</div>` : ''}
          </div>
        </div>`;
    }
  }
  return html;
}

// ─── Agents ──────────────────────────────────────────────────────────────
function renderAgents() {
  if (S.agents.length === 0) {
    return `<div class="empty-state"><div class="empty-icon">🤖</div><div class="empty-title">No agents</div><div class="empty-hint">Configure agents in ~/.openclaw/openclaw.json</div></div>`;
  }

  let html = '<div class="agent-grid">';
  for (const a of S.agents) {
    const isOnline = a.telegram?.online || false;
    const isExpanded = S.expandedAgent === a.id;
    const jobCount = (a.jobs || []).length;
    const errCount = (a.jobs || []).reduce((s, j) => s + (j.consecutiveErrors || 0), 0);
    const avatar = a.emoji || (a.name?.[0]?.toUpperCase() || '?');
    const color = avatarColor(a.name);
    const onlineClass = isOnline ? 'online' : 'offline';
    const errClass = errCount > 0 ? 'has-errors' : '';

    let detail = '';
    if (isExpanded) {
      const sessionEntries = Object.entries(a.sessions || {});
      if (sessionEntries.length > 0) {
        detail += '<div class="session-list">';
        for (const [k, s] of sessionEntries.slice(0, 5)) {
          const badge = s.chatType === 'group'
            ? '<span class="badge badge-blue">Group</span>'
            : '<span class="badge badge-purple">DM</span>';
          detail += `<div class="session-row">${badge}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${escHtml(k.slice(0, 22))}…</span><span style="color:var(--text3);font-size:10px">${escHtml(timeAgo(s.updatedAt))}</span></div>`;
        }
        if (sessionEntries.length > 5) detail += `<div class="hint" style="margin-top:4px">+${sessionEntries.length - 5} more</div>`;
        detail += '</div>';
      }
      if (a.jobs?.length) {
        detail += '<div style="padding-top:8px;margin-top:6px;border-top:1px solid var(--card-border)">';
        detail += '<div style="font-size:10px;color:var(--text3);margin-bottom:6px;font-weight:600;letter-spacing:0.5px">JOBS</div>';
        for (const j of a.jobs.slice(0, 8)) {
          const st = j.consecutiveErrors > 0 ? '❌' : j.lastStatus === 'ok' ? '✅' : '—';
          detail += `<div style="font-size:11px;color:var(--text2);padding:2px 0;display:flex;gap:4px;align-items:center"><span>${st}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(j.name)}</span>${j.schedule ? `<span style="color:var(--text3);font-size:10px">${escHtml(cronHuman(j.schedule))}</span>` : ''}</div>`;
        }
        detail += '</div>';
      }
    }

    html += `
      <div class="agent-card ${onlineClass} ${errClass}" data-action="toggle-agent" data-id="${escHtml(a.id)}">
        <div class="agent-header">
          <div class="agent-avatar" style="background:${color}">${escHtml(avatar)}</div>
          <div style="flex:1;min-width:0">
            <div class="agent-name">${escHtml(a.name)}</div>
            ${a.telegram
              ? `<div class="agent-status ${isOnline ? 'online-text' : 'offline-text'}"><span class="dot ${isOnline ? 'green pulse' : 'red'}"></span>${isOnline ? 'Online' : 'Offline'}</div>`
              : '<div class="agent-status"><span class="dot yellow"></span>No channel</div>'}
          </div>
        </div>
        <div class="agent-meta-grid">
          <div class="agent-meta-row">💬 <span class="agent-meta-val">${escHtml(a.sessionCount)}</span></div>
          <div class="agent-meta-row">⏱ <span class="agent-meta-val">${escHtml(jobCount)}</span></div>
          <div class="agent-meta-row">🕐 <span class="agent-meta-val">${escHtml(timeAgo(a.lastActive))}</span></div>
          <div class="agent-meta-row">${errCount > 0 ? `⚠ <span class="agent-meta-val" style="color:var(--red)">${escHtml(errCount)}</span>` : `✓ <span class="agent-meta-val" style="color:var(--green)">healthy</span>`}</div>
        </div>
        ${a.model ? `<div class="agent-badges"><span class="badge badge-gray">🧠 ${escHtml(a.model)}</span>${a.telegram ? `<span class="badge badge-blue">📱 ${escHtml(a.telegram.account)}</span>` : ''}</div>` : ''}
        ${detail}
      </div>`;
  }
  html += '</div>';
  return html;
}

// ─── Jobs ────────────────────────────────────────────────────────────────
function renderJobs() {
  const jobs = filteredJobs();
  let html = renderAgentFilter();
  if (jobs.length === 0) {
    return html + `<div class="empty-state"><div class="empty-icon">⏱</div><div class="empty-title">No jobs${S.agentFilter ? ' for this agent' : ''}</div></div>`;
  }
  const runs = {};
  for (const a of S.agents) Object.assign(runs, a.runs || {});

  for (const j of jobs) {
    const isExpanded = S.expandedJob === j.id;
    const hasErrors = (j.consecutiveErrors || 0) > 0;
    let statusBadge;
    if (!j.enabled) statusBadge = '<span class="badge badge-gray">⏸ Disabled</span>';
    else if (hasErrors) statusBadge = `<span class="badge badge-red">✗ ${escHtml(j.consecutiveErrors)}</span>`;
    else if (j.lastStatus === 'ok') statusBadge = '<span class="badge badge-green">✓ OK</span>';
    else statusBadge = '<span class="badge badge-gray">—</span>';

    const runsArr = runs[j.id] || [];
    const agent = S.agents.find(a => a.id === j.agentId);
    const agentBadge = !S.agentFilter && agent
      ? `<span class="badge badge-purple">${escHtml(agent.emoji || '🤖')} ${escHtml(agent.name)}</span>` : '';
    const runsHtml = isExpanded ? renderRunsSection(runsArr) : '';
    const errorHtml = isExpanded && j.lastError
      ? `<div class="error-detail">${escHtml(j.lastError)}</div>` : '';

    html += `
      <div class="job-card ${isExpanded ? 'expanded' : ''} ${hasErrors ? 'has-errors' : ''}">
        <div class="job-header" data-action="toggle-job" data-id="${escHtml(j.id)}">
          <div class="job-title-row">
            <span class="job-name">${escHtml(j.name || j.id)}</span>
            <div style="display:flex;align-items:center;gap:6px">${statusBadge}<span class="job-chevron">▼</span></div>
          </div>
          ${j.description ? `<div class="job-desc">${escHtml(j.description)}</div>` : ''}
          <div class="job-tags">
            ${agentBadge}
            ${j.schedule ? `<span class="badge badge-purple">🕐 ${escHtml(cronHuman(j.schedule))}</span>` : ''}
            ${j.tz ? `<span class="badge badge-gray">${escHtml(j.tz)}</span>` : ''}
            ${j.model ? `<span class="badge badge-gray">🧠 ${escHtml(j.model)}</span>` : ''}
            ${j.lastRun ? `<span class="badge badge-gray">Last: ${escHtml(timeAgo(j.lastRun))}</span>` : ''}
            ${j.nextRun && j.enabled ? `<span class="badge badge-blue">Next: ${escHtml(timeIn(j.nextRun))}</span>` : ''}
          </div>
          ${errorHtml}
        </div>
        <div class="job-runs">${runsHtml}</div>
      </div>`;
  }
  return html;
}

function renderRunsSection(runs) {
  if (!runs || !runs.length) return '<div class="hint text-center" style="padding:14px">No runs recorded</div>';
  let html = '';
  for (const r of runs.slice(0, 10).reverse()) {
    const ok = r.status === 'ok' || r.status === 'success';
    const icon = ok ? '✅' : '❌';
    const timeStr = r.startedAt
      ? new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';
    const summary = (r.summary || '').trim();
    html += `
      <div class="run-row">
        <span class="run-icon">${icon}</span>
        <div class="run-info">
          <div class="run-top">
            <span class="run-time">${escHtml(timeStr)}</span>
            <span class="run-dur">${escHtml(fmtDuration(r.duration))}</span>
            ${r.tokens ? `<span class="run-tok">${escHtml(fmtTokens(r.tokens))} tok</span>` : ''}
            ${r.model ? `<span class="run-model">[${escHtml(r.model)}]</span>` : ''}
          </div>
          <div class="run-summary ${ok ? '' : 'error'}">${escHtml(summary.slice(0, 300))}</div>
        </div>
      </div>`;
  }
  return html;
}

// ─── Files ───────────────────────────────────────────────────────────────
function renderFiles() {
  const files = filteredFiles();
  let html = renderAgentFilter();
  if (files.length === 0) {
    return html + `<div class="empty-state"><div class="empty-icon">📁</div><div class="empty-title">No files</div></div>`;
  }
  html += '<div class="section-header">Workspace Files</div>';
  for (const f of files) {
    html += `
      <div class="file-row" data-action="open-file" data-name="${escHtml(f.name)}" data-agent-id="${escHtml(f.agentId || '')}">
        <div class="file-icon">${fileIcon(f.name)}</div>
        <div class="file-info">
          <div class="file-name">${escHtml(f.name)}${!S.agentFilter && f.agentName ? ` <span style="color:var(--text3);font-size:11px;font-weight:400">· ${escHtml(f.agentName)}</span>` : ''}</div>
          <div class="file-meta">${escHtml(fmtBytes(f.size))} · ${escHtml(timeAgo(f.modified))}</div>
        </div>
        <div class="file-chevron">›</div>
      </div>`;
  }
  return html;
}

// ─── Logs ────────────────────────────────────────────────────────────────
function renderLogsToolbar() {
  return `
    <div class="log-toolbar">
      <input class="log-filter" id="log-filter-input" type="text"
        placeholder="Filter logs…"
        value="${escHtml(S.logFilter)}"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      <select class="log-level-filter" id="log-level-select">
        <option value="all" ${S.logLevel === 'all' ? 'selected' : ''}>All</option>
        <option value="error" ${S.logLevel === 'error' ? 'selected' : ''}>Errors</option>
        <option value="warn" ${S.logLevel === 'warn' ? 'selected' : ''}>Warnings</option>
        <option value="info" ${S.logLevel === 'info' ? 'selected' : ''}>Info</option>
      </select>
    </div>`;
}
function renderLogsList() {
  const q = S.logFilter.toLowerCase();
  const filtered = S.logs.filter(l => {
    if (S.logLevel !== 'all' && l.level !== S.logLevel) return false;
    if (!q) return true;
    return ((l.msg || '') + (l.subsystem || '') + (l.ts || '')).toLowerCase().includes(q);
  });
  if (!filtered.length) {
    return `<div class="log-lines"><div class="log-empty">${S.logFilter ? 'No matching lines' : 'No log lines'}</div></div>`;
  }
  let html = '<div class="log-lines">';
  for (const l of filtered) {
    html += `<div class="log-line ${escHtml(l.level)}">`;
    html += `<span class="log-ts">${l.ts ? escHtml(new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) : '—'}</span>`;
    if (l.subsystem) html += `<span class="log-sub">[${escHtml(l.subsystem)}]</span>`;
    html += `<span class="log-msg">${escHtml(l.msg || '')}</span>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// ─── Settings ────────────────────────────────────────────────────────────
function renderConfigTree(obj, depth = 0) {
  if (obj === null || obj === undefined) return '<span class="config-null">null</span>';
  if (typeof obj === 'boolean') return `<span class="config-bool">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="config-num">${obj}</span>`;
  if (typeof obj === 'string') return `<span class="config-str">"${escHtml(obj.length > 80 ? obj.slice(0, 80) + '…' : obj)}"</span>`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return '[' + obj.map(v => renderConfigTree(v, depth + 1)).join(', ') + ']';
  }
  if (typeof obj === 'object') {
    const e = Object.entries(obj);
    if (!e.length) return '{}';
    const pad = '  '.repeat(depth + 1);
    return '{\n' + e.map(([k, v]) => `${pad}<span class="config-key">${escHtml(k)}</span>: ${renderConfigTree(v, depth + 1)}`).join(',\n') + '\n' + '  '.repeat(depth) + '}';
  }
  return escHtml(String(obj));
}

function renderSettings() {
  let html = '';
  html += `
    <div class="settings-section">
      <div class="settings-label">Connection</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label">Backend</span>
          <span class="badge badge-purple">Cloudflare Worker</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">Machine</span>
          <span class="settings-row-value mono">${escHtml(S.machine || '—')}</span>
        </div>
        ${S.ingestedAt ? `
        <div class="settings-row">
          <span class="settings-row-label">Last push</span>
          <span class="settings-row-value ${freshnessClass()}">${escHtml(timeAgo(S.ingestedAt))}</span>
        </div>` : ''}
        ${S.collectedAt ? `
        <div class="settings-row">
          <span class="settings-row-label">Collected</span>
          <span class="settings-row-value">${escHtml(timeAgo(S.collectedAt))}</span>
        </div>` : ''}
        <div class="settings-row">
          <span class="settings-row-label">Agents</span>
          <span class="settings-row-value">${S.agents.length}</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label"></span>
          <button class="btn btn-primary btn-sm" data-action="refresh">↻ Refresh now</button>
        </div>
      </div>
    </div>`;

  html += `
    <div class="settings-section">
      <div class="settings-label">Auto refresh</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label">Enabled</span>
          <label class="toggle">
            <input type="checkbox" ${S.cfg.autoRefresh ? 'checked' : ''} data-action="toggle-auto">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">Interval</span>
          <select class="settings-select" data-action="set-interval">
            ${[10, 15, 30, 60, 120, 300].map(v => `<option value="${v}" ${S.cfg.interval == v ? 'selected' : ''}>${v < 60 ? v + 's' : (v / 60) + 'm'}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`;

  const gwActive = S.health?.gatewayActive || false;
  html += `
    <div class="settings-section">
      <div class="settings-label">Gateway (read-only)</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-row-label">Status</span>
          <span class="badge ${gwActive ? 'badge-green' : 'badge-red'}">${gwActive ? '● Active' : '○ Down'}</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">Last log</span>
          <span class="settings-row-value">${S.health?.lastLogTs ? escHtml(timeAgo(S.health.lastLogTs)) : '—'}</span>
        </div>
      </div>
    </div>`;

  html += `
    <div class="settings-section">
      <div class="settings-label">Agent config (sanitized)</div>
      <div class="settings-card">
        <div style="padding:12px 14px;max-height:340px;overflow-y:auto">
          ${S.config
            ? `<pre class="config-tree">${renderConfigTree(S.config)}</pre>`
            : '<div class="hint">No config loaded</div>'}
        </div>
      </div>
    </div>`;

  html += `
    <div class="settings-section">
      <div class="settings-label">Install</div>
      <div class="instructions">
        Open this page in <strong>Safari</strong> (iOS) or <strong>Chrome</strong> (Android) → tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.
        Works offline after first load.
      </div>
    </div>`;

  html += `<div class="hint text-center" style="padding:16px 0">ClawMonitor · <a href="https://github.com/minimo93/ClawMonitor" style="color:var(--accent2)">github</a></div>`;

  return html;
}

// ─── File viewer (modal) ─────────────────────────────────────────────────
function openFile(name, agentId) {
  let agent = agentId ? getAgent(agentId) : null;
  if (!agent || !agent.fileContents?.[name]) {
    for (const a of S.agents) {
      if (a.fileContents?.[name]) { agent = a; break; }
    }
  }
  if (!agent || !agent.fileContents?.[name]) {
    toast('File content not available', 'error');
    return;
  }
  const meta = (agent.files || []).find(f => f.name === name);
  S.activeFile = {
    name,
    content: agent.fileContents[name],
    size: meta?.size || 0,
    modified: meta?.modified || 0,
    agentName: agent.name,
  };
  showModal();
}

function showModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const modal = document.getElementById('modal');
  const f = S.activeFile;
  if (!f) return;
  document.getElementById('modal-title').textContent = f.name;
  document.getElementById('modal-subtitle').textContent = `${fmtBytes(f.size)} · ${f.agentName || ''}`;
  document.getElementById('modal-body').innerHTML = '<div class="md-content">' + md2html(f.content) + '</div>';
  backdrop.classList.add('visible');
  modal.classList.add('visible');
}
function closeModal() {
  document.getElementById('modal-backdrop').classList.remove('visible');
  document.getElementById('modal').classList.remove('visible');
  setTimeout(() => { S.activeFile = null; }, 200);
}

// ─── Toasts ──────────────────────────────────────────────────────────────
function toast(msg, kind = 'info', ms = 2800) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const icon = kind === 'success' ? '✓' : kind === 'error' ? '⚠' : 'ℹ';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 280);
  }, ms);
}

// ─── Confirm dialog ──────────────────────────────────────────────────────
function confirmDialog(title, msg, confirmText = 'Confirm', kind = 'primary') {
  return new Promise(resolve => {
    const backdrop = document.getElementById('confirm-backdrop');
    backdrop.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-title"></div>
        <div class="confirm-msg"></div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" data-confirm="no">Cancel</button>
          <button class="btn ${kind === 'danger' ? 'btn-danger' : 'btn-primary'}" data-confirm="yes"></button>
        </div>
      </div>`;
    backdrop.querySelector('.confirm-title').textContent = title;
    backdrop.querySelector('.confirm-msg').textContent = msg;
    backdrop.querySelector('[data-confirm="yes"]').textContent = confirmText;
    backdrop.classList.add('visible');
    const off = (ans) => { backdrop.classList.remove('visible'); resolve(ans); };
    backdrop.addEventListener('click', (e) => {
      const v = e.target.closest('[data-confirm]')?.dataset.confirm;
      if (v === 'yes') off(true);
      else if (v === 'no' || e.target === backdrop) off(false);
    }, { once: true });
  });
}

// ─── Event delegation ────────────────────────────────────────────────────
function handleAction(e) {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  switch (action) {
    case 'tab': S.tab = target.dataset.tab; S.expandedAgent = null; S.expandedJob = null; render(); break;
    case 'goto': S.tab = target.dataset.tab; render(); scrollTop(); break;
    case 'goto-job':
      S.tab = 'jobs';
      S.expandedJob = target.dataset.jobId;
      S.agentFilter = null;
      render(); scrollTop();
      setTimeout(() => {
        const card = document.querySelector(`[data-action="toggle-job"][data-id="${CSS.escape(S.expandedJob)}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      break;
    case 'refresh': refreshAll(); break;
    case 'toggle-agent': S.expandedAgent = S.expandedAgent === id ? null : id; render(); break;
    case 'toggle-job': S.expandedJob = S.expandedJob === id ? null : id; render(); break;
    case 'filter-agent': S.agentFilter = id || null; render(); break;
    case 'filter-activity': S.activityFilter = target.dataset.val; render(); break;
    case 'open-file': openFile(target.dataset.name, target.dataset.agentId); break;
    case 'close-modal': closeModal(); break;
    case 'dismiss-error': S.error = null; render(); break;
    case 'toggle-auto':
      S.cfg.autoRefresh = target.checked;
      saveCfg();
      scheduleRefresh();
      toast(S.cfg.autoRefresh ? 'Auto-refresh enabled' : 'Auto-refresh paused', 'info', 1500);
      break;
    case 'set-interval':
      S.cfg.interval = parseInt(target.value);
      saveCfg();
      scheduleRefresh();
      break;
  }
}

function scrollTop() {
  const c = document.getElementById('content');
  if (c) c.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Focus-preserving log tab ────────────────────────────────────────────
let _logDebounce = null;
function renderLogsTab() {
  const el = document.getElementById('content');
  if (!document.getElementById('log-filter-input')) {
    // Full render first time
    el.innerHTML = renderLogsToolbar() + '<div id="log-list">' + renderLogsList() + '</div>';
    const input = document.getElementById('log-filter-input');
    input.addEventListener('input', (e) => {
      S.logFilter = e.target.value;
      clearTimeout(_logDebounce);
      _logDebounce = setTimeout(() => {
        const list = document.getElementById('log-list');
        if (list) list.innerHTML = renderLogsList();
      }, 100);
    });
    document.getElementById('log-level-select').addEventListener('change', (e) => {
      S.logLevel = e.target.value;
      const list = document.getElementById('log-list');
      if (list) list.innerHTML = renderLogsList();
    });
  } else {
    // Just update the list
    const list = document.getElementById('log-list');
    if (list) list.innerHTML = renderLogsList();
  }
}

// ─── Main render ─────────────────────────────────────────────────────────
function render() {
  // Update tabs
  for (const t of TABS) {
    const btn = document.getElementById('tab-' + t);
    if (btn) btn.classList.toggle('active', t === S.tab);
  }

  // Error banner
  const el = document.getElementById('content');
  if (!el) return;

  // Logs tab has its own render logic that preserves focus
  if (S.tab === 'logs') {
    // Preserve error banner above logs toolbar
    let prefix = '';
    if (!S.online) prefix += '<div class="offline-banner">🌐 You are offline — showing cached data</div>';
    if (S.error) prefix += `<div class="error-banner"><span class="error-banner-msg">⚠️ ${escHtml(S.error)}</span><button class="error-banner-close" data-action="dismiss-error">✕</button></div>`;

    // Always re-render prefix but preserve input
    let prefixEl = document.getElementById('logs-prefix');
    if (!prefixEl || document.getElementById('log-filter-input') == null) {
      el.innerHTML = `<div id="logs-prefix">${prefix}</div>` + renderLogsToolbar() + '<div id="log-list">' + renderLogsList() + '</div>';
      const input = document.getElementById('log-filter-input');
      input.addEventListener('input', (e) => {
        S.logFilter = e.target.value;
        clearTimeout(_logDebounce);
        _logDebounce = setTimeout(() => {
          const list = document.getElementById('log-list');
          if (list) list.innerHTML = renderLogsList();
        }, 100);
      });
      document.getElementById('log-level-select').addEventListener('change', (e) => {
        S.logLevel = e.target.value;
        const list = document.getElementById('log-list');
        if (list) list.innerHTML = renderLogsList();
      });
    } else {
      prefixEl.innerHTML = prefix;
      const list = document.getElementById('log-list');
      if (list) list.innerHTML = renderLogsList();
    }
    return;
  }

  let html = '';
  if (!S.online) html += '<div class="offline-banner">🌐 You are offline — showing cached data</div>';
  if (S.error) html += `<div class="error-banner"><span class="error-banner-msg">⚠️ ${escHtml(S.error)}</span><button class="error-banner-close" data-action="dismiss-error">✕</button></div>`;

  if (S.firstLoad && S.loading) {
    el.innerHTML = html + renderSkeleton(4);
    return;
  }

  switch (S.tab) {
    case 'dashboard': html += renderDashboard(); break;
    case 'activity': html += renderActivity(); break;
    case 'agents': html += renderAgents(); break;
    case 'jobs': html += renderJobs(); break;
    case 'files': html += renderFiles(); break;
    case 'settings': html += renderSettings(); break;
    default: html += renderDashboard();
  }
  el.innerHTML = html;
}

// ─── Pull to refresh ─────────────────────────────────────────────────────
function initPullToRefresh() {
  const content = document.getElementById('content');
  const ptr = document.getElementById('ptr');
  if (!content || !ptr) return;
  let startY = 0, currentY = 0, pulling = false;

  content.addEventListener('touchstart', (e) => {
    if (content.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    currentY = e.touches[0].clientY;
    const delta = currentY - startY;
    if (delta > 0 && content.scrollTop === 0) {
      const progress = Math.min(delta / 100, 1);
      ptr.style.transform = `translateX(-50%) translateY(${Math.min(delta * 0.4, 40)}px)`;
      ptr.classList.toggle('visible', delta > 20);
      ptr.querySelector('.ptr-text').textContent = progress >= 1 ? 'Release to refresh' : 'Pull to refresh';
    }
  }, { passive: true });

  content.addEventListener('touchend', () => {
    if (!pulling) return;
    const delta = currentY - startY;
    pulling = false;
    if (delta > 80) {
      ptr.classList.add('refreshing');
      ptr.querySelector('.ptr-text').textContent = 'Refreshing…';
      refreshAll().finally(() => {
        setTimeout(() => {
          ptr.classList.remove('refreshing', 'visible');
          ptr.style.transform = '';
        }, 400);
      });
    } else {
      ptr.classList.remove('visible');
      ptr.style.transform = '';
    }
  }, { passive: true });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────
function init() {
  loadCfg();
  // Wire up tab bar
  document.getElementById('tab-bar').addEventListener('click', handleAction);
  document.getElementById('content').addEventListener('click', handleAction);
  document.getElementById('header-buttons').addEventListener('click', handleAction);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  document.getElementById('modal').addEventListener('click', handleAction);

  // Online/offline
  window.addEventListener('online', () => { S.online = true; render(); toast('Back online', 'success', 1500); refreshAll({ silent: true }); });
  window.addEventListener('offline', () => { S.online = false; render(); });

  // Visibility change
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleRefresh();
      // Refresh if data is stale
      if (!S.lastRefresh || Date.now() - S.lastRefresh > 30000) refreshAll({ silent: true });
    } else if (_refreshTimer) {
      clearTimeout(_refreshTimer); _refreshTimer = null;
    }
  });

  initPullToRefresh();

  // Update "time ago" in header periodically
  _freshnessTimer = setInterval(renderHeader, 30000);

  render();
  refreshAll();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
