#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  push-to-ssh.sh
#  Syncs local files to root@37.27.216.254 via rsync, then runs remote deploy.
#
#  Usage: bash push-to-ssh.sh
#  Requirements: rsync + SSH access with valid key/passphrase
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SSH_HOST="root@37.27.216.254"
REMOTE_DIR="/var/www/aba-website"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Syncing files to ${SSH_HOST}:${REMOTE_DIR}"

rsync -avz --delete \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='contact-submissions.ndjson' \
  --exclude='agent_logs.ndjson' \
  --exclude='__pycache__/' \
  --exclude='.mypy_cache/' \
  --exclude='push-to-ssh.sh' \
  --exclude='.git/' \
  "${LOCAL_DIR}/" "${SSH_HOST}:${REMOTE_DIR}/"

echo "==> Files synced."
echo ""
echo "==> Copying .env to remote (if exists locally)..."
if [ -f "${LOCAL_DIR}/.env" ]; then
  scp "${LOCAL_DIR}/.env" "${SSH_HOST}:${REMOTE_DIR}/.env"
  echo "    .env copied."
else
  echo "    [WARN] .env not found locally – make sure it exists on the server."
fi

echo ""
echo "==> Running remote setup (Ollama install + deploy)..."
ssh "${SSH_HOST}" "bash ${REMOTE_DIR}/remote-setup.sh"

echo ""
echo "==> Done. App should be live at http://37.27.216.254"
