# ABA GmbH Website & Office Portal

Official website and internal office portal for **ABA GmbH**.

## Live URLs

- Website: `http://37.27.216.254/`
- Office portal: `http://37.27.216.254/office.html`

## Features

- Public construction company website
- Contact form with server-side storage and email forwarding
- AI chat and agent endpoints
- Office portal for:
  - worker registration
  - online task assignment
  - VOB/B-oriented invoice creation
  - printable invoice view

## Tech stack

- Node.js (`server.js`)
- Static HTML/CSS/JS (`index.html`, `office.html`)
- PM2 for production process management
- Python agents in `agents/`
- Ollama integration for AI features

## Local development

```bash
npm install
cp .env.example .env
node server.js
```

Default local port is controlled by `PORT`.

Example:

```bash
PORT=3002 node server.js
```

## Environment variables

See `.env.example` for the required configuration.

Important values:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- `MAIL_FROM`, `MAIL_TO`
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`
- `OLLAMA_ENABLED`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`
- `AGENT_API_KEY`

## Production deploy

Manual deploy from Windows:

```powershell
pwsh -File .\deploy-to-server.ps1
```

Server-side setup is handled by:

- `remote-setup.sh`
- `deploy.sh`
- `ecosystem.config.js`

## GitHub Actions deploy

A workflow is included at:

- `.github/workflows/deploy.yml`

Required GitHub secret:

- `SSH_PRIVATE_KEY`

The workflow deploys to the production server on pushes to `main`.

## Notes

- Production `.env` stays on the server and is not committed.
- Internal admin and worker access should be managed only through environment variables and generated access codes.
