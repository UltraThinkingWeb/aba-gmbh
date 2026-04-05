#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  remote-setup.sh  –  runs ON the SSH server
#  Idempotent: safe to re-run on every deploy
#
#  Installs: Node.js (if missing), pm2, Python deps, Ollama + model
#  Starts:   Ollama (systemd or background), app (pm2)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/var/www/aba-website"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:1b}"

cd "$APP_DIR"

# ── 1. Load .env ──────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "[ERROR] .env missing in ${APP_DIR}. Aborting."
  exit 1
fi

ENV_OLLAMA_MODEL="$(grep -E '^OLLAMA_MODEL=' .env | head -n 1 | cut -d '=' -f 2- || true)"
if [ -n "$ENV_OLLAMA_MODEL" ]; then
  OLLAMA_MODEL="$ENV_OLLAMA_MODEL"
fi

# ── 2. Node.js ───────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[1/7] Installing Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[1/7] Node.js already installed: $(node -v)"
fi

# ── 3. npm install ───────────────────────────────────────────────────────────
echo "[2/7] Installing Node dependencies..."
npm ci --omit=dev

# ── 4. Python + venv ─────────────────────────────────────────────────────────
echo "[3/7] Checking Python..."
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "      Installing python3..."
  apt-get install -y python3 python3-pip python3-venv python3.12-venv
  PYTHON_BIN="python3"
fi
echo "      Using: $PYTHON_BIN ($($PYTHON_BIN -V))"

# ensure pip + venv support
echo "      Ensuring python venv packages are installed..."
apt-get install -y python3-pip python3-venv python3.12-venv >/dev/null

if ! $PYTHON_BIN -m pip --version >/dev/null 2>&1; then
  echo "      Installing python3-pip..."
  apt-get install -y python3-pip
fi

VENV_DIR="$APP_DIR/.venv"
if [ -d "$VENV_DIR" ] && { [ ! -x "$VENV_DIR/bin/python" ] || [ ! -x "$VENV_DIR/bin/pip" ]; }; then
  rm -rf "$VENV_DIR"
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "      Creating virtual environment..."
  $PYTHON_BIN -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

$VENV_PIP install --upgrade pip --quiet

echo "[4/7] Installing Python agent dependencies..."
$VENV_PIP install -r agents/requirements.txt --quiet

# update PYTHON_PATH in .env if it was wrong
if ! grep -q "^PYTHON_PATH=" .env; then
  echo "PYTHON_PATH=${VENV_PYTHON}" >> .env
else
  sed -i "s|^PYTHON_PATH=.*|PYTHON_PATH=${VENV_PYTHON}|" .env
fi

# ── 5. Ollama ────────────────────────────────────────────────────────────────
echo "[5/7] Checking Ollama..."
if ! command -v ollama >/dev/null 2>&1; then
  echo "      Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "      Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown version')"
fi

# Start Ollama server if not already running
if ! pgrep -x "ollama" >/dev/null 2>&1; then
  echo "      Starting Ollama server..."
  if systemctl list-unit-files ollama.service &>/dev/null; then
    systemctl enable ollama --now || true
  else
    nohup ollama serve > /var/log/ollama.log 2>&1 &
    sleep 3
  fi
fi

# Pull model only if not already present
echo "      Checking model ${OLLAMA_MODEL}..."
if ! ollama list 2>/dev/null | grep -q "${OLLAMA_MODEL}"; then
  echo "      Pulling ${OLLAMA_MODEL} (this may take a few minutes)..."
  ollama pull "${OLLAMA_MODEL}"
else
  echo "      Model ${OLLAMA_MODEL} already present."
fi

# Ensure .env reflects Ollama enabled
sed -i 's|^OLLAMA_ENABLED=.*|OLLAMA_ENABLED=true|' .env

# ── 6. pm2 ───────────────────────────────────────────────────────────────────
echo "[6/7] Setting up pm2..."
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

# remove old conflicting app if it exists
pm2 delete aba-site 2>/dev/null || true

# node --check first
node --check server.js

pm2 startOrReload ecosystem.config.js --update-env
pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true

# ── 7. Summary ───────────────────────────────────────────────────────────────
echo ""
echo "[7/7] Status"
pm2 status aba-website
echo ""
echo "Ollama process:  $(pgrep -x ollama >/dev/null && echo 'running' || echo 'NOT running')"
echo "Model:           ${OLLAMA_MODEL}"
echo ""
echo "Endpoints:"
echo "  GET  http://37.27.216.254/            — Website"
echo "  POST http://37.27.216.254/agent/chat  — Public AI chat (no auth)"
echo "  POST http://37.27.216.254/agent/seo   — SEO audit (x-agent-key)"
echo "  POST http://37.27.216.254/agent/ceo   — CEO brief  (x-agent-key)"
echo ""
echo "Setup complete."
