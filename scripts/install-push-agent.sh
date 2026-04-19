#!/usr/bin/env bash
# Installs the ClawMonitor push agent as a macOS LaunchAgent.
# Required env (or pass via .env file in project root):
#   CLAWMONITOR_URL    e.g. https://clawmonitor.<account>.workers.dev
#   CLAWMONITOR_TOKEN  bearer token (same as Worker INGEST_TOKEN)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.clawmonitor.push"
PLIST_TEMPLATE="$PROJECT_DIR/scripts/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.openclaw/logs"

# Source .env file if present (POSIX dotenv)
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

if [[ -z "${CLAWMONITOR_URL:-}" || -z "${CLAWMONITOR_TOKEN:-}" ]]; then
  echo "❌ Missing CLAWMONITOR_URL or CLAWMONITOR_TOKEN."
  echo "   Either export them or create $PROJECT_DIR/.env with:"
  echo "     CLAWMONITOR_URL=https://clawmonitor.<account>.workers.dev"
  echo "     CLAWMONITOR_TOKEN=<token>"
  exit 2
fi

mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

# Render plist with substitutions (avoid sed delimiter conflicts with URL slashes)
TMP_PLIST=$(mktemp)
trap 'rm -f "$TMP_PLIST"' EXIT
PROJECT_DIR_ESC=$(printf '%s' "$PROJECT_DIR" | sed 's/[\\/&]/\\&/g')
HOME_ESC=$(printf '%s' "$HOME" | sed 's/[\\/&]/\\&/g')
URL_ESC=$(printf '%s' "$CLAWMONITOR_URL" | sed 's/[\\/&]/\\&/g')
TOKEN_ESC=$(printf '%s' "$CLAWMONITOR_TOKEN" | sed 's/[\\/&]/\\&/g')

sed \
  -e "s/__PROJECT_DIR__/$PROJECT_DIR_ESC/g" \
  -e "s/__HOME__/$HOME_ESC/g" \
  -e "s/__CLAWMONITOR_URL__/$URL_ESC/g" \
  -e "s/__CLAWMONITOR_TOKEN__/$TOKEN_ESC/g" \
  "$PLIST_TEMPLATE" > "$TMP_PLIST"

# Stop existing agent if loaded
if launchctl list | grep -q "$LABEL"; then
  echo "↻ Unloading existing $LABEL"
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

cp "$TMP_PLIST" "$PLIST_DEST"
chmod 600 "$PLIST_DEST"

launchctl load "$PLIST_DEST"
echo "✓ Installed $LABEL (runs every 2 minutes)"
echo "  Logs: $LOG_DIR/clawmonitor-push.log"
echo "  Test now: node $PROJECT_DIR/scripts/push.js"
