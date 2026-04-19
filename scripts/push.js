#!/usr/bin/env node
'use strict';

/**
 * ClawMonitor push agent — runs on the host machine (Mac mini).
 * Collects current status from the local OpenClaw config + logs,
 * then POSTs it to the Cloudflare Worker `/api/ingest` endpoint.
 *
 * Required env:
 *   CLAWMONITOR_URL    — e.g. https://clawmonitor.<account>.workers.dev
 *   CLAWMONITOR_TOKEN  — the bearer token (same as Worker INGEST_TOKEN secret)
 *
 * Optional env:
 *   OPENCLAW_DIR       — defaults to ~/.openclaw
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect } = require('./collect.js');

const URL_BASE = process.env.CLAWMONITOR_URL || '';
const TOKEN = process.env.CLAWMONITOR_TOKEN || '';

if (!URL_BASE || !TOKEN) {
  console.error('[push] missing env CLAWMONITOR_URL or CLAWMONITOR_TOKEN');
  process.exit(2);
}

(async () => {
  const started = Date.now();
  let payload;
  try {
    payload = collect();
  } catch (e) {
    console.error('[push] collect failed:', e.message);
    process.exit(1);
  }
  if (!payload) {
    console.error('[push] collect returned no payload (missing openclaw.json?)');
    process.exit(1);
  }

  const body = JSON.stringify(payload);
  const url = URL_BASE.replace(/\/$/, '') + '/api/ingest';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + TOKEN,
        'x-machine': os.hostname(),
        'x-source': 'clawmonitor-push/0.3',
      },
      body,
      // Node 18+ has built-in fetch; AbortSignal.timeout is supported on 20+
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    console.error('[push] network error:', e.message);
    process.exit(1);
  }

  let respText = '';
  try { respText = await res.text(); } catch {}
  const elapsed = Date.now() - started;

  if (!res.ok) {
    console.error(`[push] HTTP ${res.status} after ${elapsed}ms: ${respText.slice(0, 240)}`);
    process.exit(1);
  }

  console.log(`[push] ok ${(body.length / 1024).toFixed(1)}KB · ${payload.agents.length} agents · ${elapsed}ms`);
})();
