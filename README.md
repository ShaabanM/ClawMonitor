# ClawMonitor

A small PWA + Cloudflare Worker for monitoring [OpenClaw](https://openclaw.ai)
AI agents (jobs, runs, sessions, gateway health, workspace files, logs) from
your phone.

```
┌──────────────┐    POST /api/ingest     ┌────────────────────────┐
│ Mac mini     │ ──────────────────────▶ │ Cloudflare Worker      │
│ (push agent  │                         │   • /api/ingest (auth) │
│  every 2 min)│                         │   • /api/status        │
└──────────────┘                         │   • /api/health        │
                                         │   • static PWA assets  │
                                         │   • KV: status:latest  │
                                         └──────────┬─────────────┘
                                                    │
                                                    ▼ GET /api/status
                                         ┌────────────────────────┐
                                         │ PWA on your phone      │
                                         │ (installed from URL)   │
                                         └────────────────────────┘
```

The push agent reads the local `~/.openclaw` directory, normalises it into a
single JSON snapshot, and POSTs it to the Worker. The Worker stores it in KV
and serves it to the PWA. No more GitHub auto-commits, no more 5-minute stale
data, sub-100 ms response times worldwide.

---

## Layout

```
.
├── wrangler.toml           # Worker + KV + assets binding
├── src/worker.js           # Worker: API routes + static asset fall-through
├── public/                 # PWA shipped as Worker static assets
│   ├── index.html
│   ├── app.css
│   ├── app.js
│   ├── sw.js               # service worker (offline + cache)
│   ├── manifest.json
│   └── icon.svg
├── scripts/
│   ├── collect.js          # reads ~/.openclaw → snapshot object
│   ├── push.js             # collect.js + POST to Worker (Bearer auth)
│   ├── install-push-agent.sh
│   └── com.clawmonitor.push.plist
└── package.json
```

---

## Deploy from scratch

You only need to do this once. Pre-reqs: Node 18+, a Cloudflare account.

```bash
npm install --save-dev wrangler
npx wrangler login                 # one-shot OAuth in browser

# Create KV namespace and copy the ID into wrangler.toml
npx wrangler kv namespace create STATUS_KV

# Generate an ingest secret and store it on the Worker
TOKEN=$(openssl rand -base64 36 | tr -d '\n=+/' | head -c 48)
echo "$TOKEN" | npx wrangler secret put INGEST_TOKEN

# Deploy
npx wrangler deploy
```

You'll get a URL like `https://clawmonitor.<account>.workers.dev`.

---

## Install the push agent (on the host machine that runs OpenClaw)

```bash
cat > .env <<EOF
CLAWMONITOR_URL=https://clawmonitor.<account>.workers.dev
CLAWMONITOR_TOKEN=<the same token you put as INGEST_TOKEN>
EOF
chmod 600 .env

bash scripts/install-push-agent.sh
```

This loads a macOS LaunchAgent (`com.clawmonitor.push`) that runs every 2
minutes. Logs are at `~/.openclaw/logs/clawmonitor-push.log`.

Run a single push manually to test:

```bash
node scripts/push.js
# → [push] ok 127.0KB · 2 agents · 763ms
```

---

## Install the PWA on your phone

1. Open `https://clawmonitor.<account>.workers.dev` in **Safari** (iOS) or
   **Chrome** (Android).
2. Share → **Add to Home Screen**.
3. Launches in standalone mode, works offline (cached app shell + last
   successful status snapshot).

---

## Local development

```bash
npm run dev          # wrangler dev (local, in-memory KV)
npm run dev -- --remote   # wrangler dev against the real KV / production data
npm run tail         # live-tail Worker logs
```

The Worker runs on `http://127.0.0.1:8787` by default and serves both the
PWA and the API.

---

## Endpoints

| Method | Path             | Auth          | Purpose |
|--------|------------------|---------------|---------|
| `GET`  | `/api/status`    | none          | Latest status snapshot from KV. 404 until first ingest. |
| `GET`  | `/api/health`    | none          | Liveness + ingest age. `stale: true` if last push >15 min. |
| `POST` | `/api/ingest`    | `Bearer …`    | Stores a status snapshot in KV. Token must match `INGEST_TOKEN`. |
| `GET`  | `/anything-else` | none          | Static asset (PWA shell) or 404. |

`POST /api/ingest` enforces:

- `Authorization: Bearer <token>` — constant-time compared to `INGEST_TOKEN`
- `Content-Type: application/json`
- Body must be a JSON object with an `agents` array
- ≤ `MAX_PAYLOAD_KB` (default 900) — Workers KV value limit is 25 MB but we
  keep snapshots small

---

## Updating

```bash
# After editing public/* or src/worker.js
npm run deploy
```

Asset versions are query-string busted (`app.css?v=…`) and the service worker
cache name (`clawmonitor-…`) is bumped, so the PWA picks up changes after the
next launch.

---

## Removing the push agent

```bash
launchctl unload ~/Library/LaunchAgents/com.clawmonitor.push.plist
rm ~/Library/LaunchAgents/com.clawmonitor.push.plist
```
