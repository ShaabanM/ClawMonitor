/**
 * ClawMonitor Worker
 *
 * - Serves the PWA static assets via the bound [assets] directory
 * - Exposes a small JSON API:
 *     GET  /api/status         → latest status snapshot from KV
 *     GET  /api/health         → liveness + ingest-age probe
 *     POST /api/ingest         → upserts a status snapshot (Bearer auth)
 */

const STATUS_KEY = 'status:latest';
const META_KEY = 'status:meta';

function json(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

function corsHeaders(req) {
  const origin = req.headers.get('origin');
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-machine, x-source',
    'access-control-max-age': '86400',
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  } else {
    headers['access-control-allow-origin'] = '*';
  }
  return headers;
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function handleStatus(req, env) {
  const value = await env.STATUS_KV.get(STATUS_KEY);
  if (!value) {
    return json(
      {
        error: 'no_data',
        hint: 'No status has been ingested yet. Run the local push agent on the host machine.',
      },
      { status: 404, headers: corsHeaders(req) }
    );
  }
  // Append server-side metadata (ingestedAt, age) into a wrapper field — keep
  // the original payload shape so the PWA does not have to special-case.
  let meta = {};
  try { meta = JSON.parse(await env.STATUS_KV.get(META_KEY)) || {}; } catch {}
  let parsed;
  try { parsed = JSON.parse(value); } catch { parsed = {}; }
  parsed._meta = {
    ingestedAt: meta.ingestedAt || null,
    ingestAgeSec: meta.ingestedAt ? Math.round((Date.now() - meta.ingestedAt) / 1000) : null,
    source: meta.source || null,
    machine: meta.machine || parsed.machine || null,
    bytes: meta.bytes || value.length,
  };
  return json(parsed, { headers: corsHeaders(req) });
}

async function handleHealth(req, env) {
  let meta = {};
  try { meta = JSON.parse(await env.STATUS_KV.get(META_KEY)) || {}; } catch {}
  const ingestAge = meta.ingestedAt ? Math.round((Date.now() - meta.ingestedAt) / 1000) : null;
  return json(
    {
      ok: true,
      ingestedAt: meta.ingestedAt || null,
      ingestAgeSec: ingestAge,
      // 15 minutes after last push we consider the pipeline stale
      stale: ingestAge == null || ingestAge > 15 * 60,
      bytes: meta.bytes || null,
      source: meta.source || null,
      machine: meta.machine || null,
    },
    { headers: corsHeaders(req) }
  );
}

async function handleIngest(req, env) {
  if (!env.INGEST_TOKEN) {
    return json(
      { error: 'server_misconfigured', detail: 'INGEST_TOKEN secret not set' },
      { status: 500, headers: corsHeaders(req) }
    );
  }
  const got = bearer(req);
  if (!constantTimeEqual(got, env.INGEST_TOKEN)) {
    return json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders(req) });
  }

  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return json({ error: 'expected_json' }, { status: 415, headers: corsHeaders(req) });
  }

  const maxKb = parseInt(env.MAX_PAYLOAD_KB || '900');
  const cl = parseInt(req.headers.get('content-length') || '0');
  if (cl && cl > maxKb * 1024) {
    return json({ error: 'payload_too_large', max_kb: maxKb }, { status: 413, headers: corsHeaders(req) });
  }

  // Parse + minimally validate
  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: 'invalid_json', detail: e.message }, { status: 400, headers: corsHeaders(req) });
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.agents)) {
    return json(
      { error: 'invalid_shape', hint: 'expected { agents: [...] , collectedAt, ... }' },
      { status: 400, headers: corsHeaders(req) }
    );
  }

  const body = JSON.stringify(payload);
  if (body.length > maxKb * 1024) {
    return json({ error: 'payload_too_large', max_kb: maxKb }, { status: 413, headers: corsHeaders(req) });
  }

  const ingestedAt = Date.now();
  const meta = {
    ingestedAt,
    bytes: body.length,
    source: req.headers.get('x-source') || 'unknown',
    machine: req.headers.get('x-machine') || payload.machine || null,
  };

  await Promise.all([
    env.STATUS_KV.put(STATUS_KEY, body),
    env.STATUS_KV.put(META_KEY, JSON.stringify(meta)),
  ]);

  return json(
    {
      ok: true,
      bytes: body.length,
      agents: payload.agents.length,
      ingestedAt,
    },
    { headers: corsHeaders(req) }
  );
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const { pathname } = url;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    // API routes
    if (pathname === '/api/status' && req.method === 'GET') return handleStatus(req, env);
    if (pathname === '/api/health' && req.method === 'GET') return handleHealth(req, env);
    if (pathname === '/api/ingest' && req.method === 'POST') return handleIngest(req, env);
    if (pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, { status: 404, headers: corsHeaders(req) });
    }

    // Static assets fall through to the bound [assets] directory.
    return env.ASSETS.fetch(req);
  },
};
