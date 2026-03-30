#!/bin/bash
# Collects OpenClaw status and pushes to GitHub so GitHub Pages serves fresh data.
# Run via launchd every 5 minutes.

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# Collect fresh status
/opt/homebrew/bin/node collect.js

# Only push if data actually changed
if git diff --quiet data/status.json 2>/dev/null; then
  echo "$(date -Iseconds) No changes, skipping push"
  exit 0
fi

git add data/status.json

# Amend the last commit if it was an auto-status update (prevents repo bloat)
LAST_MSG=$(git log -1 --format=%s 2>/dev/null)
if [[ "$LAST_MSG" == auto:\ update\ status* ]]; then
  git commit --amend -m "auto: update status $(date -Iseconds)" --no-gpg-sign --author="ClawMonitor Bot <bot@clawmonitor>" >/dev/null 2>&1
  git push origin main --force-with-lease >/dev/null 2>&1
else
  git commit -m "auto: update status $(date -Iseconds)" --no-gpg-sign --author="ClawMonitor Bot <bot@clawmonitor>" >/dev/null 2>&1
  git push origin main >/dev/null 2>&1
fi

echo "$(date -Iseconds) Pushed status update"
