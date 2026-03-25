#!/usr/bin/env bash
set -euo pipefail

APP_NAME="aba-website"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$APP_DIR"

echo "[1/5] Updating Node.js dependencies"
npm install --omit=dev

echo "[1b/5] Installing Python agent dependencies"
if [ -n "${PYTHON_PATH:-}" ]; then
  PYTHON_BIN="$PYTHON_PATH"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Python not found. Install python3 (or set PYTHON_PATH in .env)."
  exit 1
fi

"$PYTHON_BIN" -m pip install -r agents/requirements.txt --quiet

if [ ! -f .env ]; then
  echo "Missing .env file. Copy .env.example to .env and fill SMTP settings first."
  exit 1
fi

set -a
. ./.env
set +a

echo "[2/5] Validating required environment variables"
required_vars=(SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM MAIL_TO)
for var_name in "${required_vars[@]}"; do
  if [ -z "${!var_name:-}" ]; then
    echo "Missing required variable: $var_name"
    exit 1
  fi
done

if [ "${OLLAMA_ENABLED:-false}" = "true" ]; then
  echo "[2b/5] Validating Ollama agent variables"
  ollama_vars=(OLLAMA_BASE_URL OLLAMA_MODEL AGENT_API_KEY)
  for var_name in "${ollama_vars[@]}"; do
    if [ -z "${!var_name:-}" ]; then
      echo "Missing required variable for Ollama: $var_name"
      exit 1
    fi
  done
fi

echo "[3/5] Checking Node.js app syntax"
node --check server.js

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[4/5] Installing pm2 globally"
  npm install -g pm2
else
  echo "[4/5] pm2 already installed"
fi

echo "[5/5] Starting or reloading app with pm2"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

echo "Deployment complete."
pm2 status "$APP_NAME"

if [ "${OLLAMA_ENABLED:-false}" = "true" ]; then
  echo "Ollama endpoints:"
  echo "  GET  /agent/tasks"
  echo "  POST /agent/task          (x-agent-key)"
fi
echo "Python agent endpoints:"
echo "  POST /agent/scrape        (x-agent-key)  — web scraper + AI analysis"
echo "  POST /agent/design        (x-agent-key)  — concept generator"
echo "  POST /agent/analyze       (x-agent-key)  — project requirements + cost"
echo "  POST /agent/future-trends (x-agent-key)  — architectural trend report"
echo "  POST /agent/seo           (x-agent-key)  — scalable SEO audit/keywords"
echo "  POST /agent/ceo           (x-agent-key)  — executive SEO brief"
