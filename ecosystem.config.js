module.exports = {
  apps: [
    {
      name: 'aba-website',
      script: './server.js',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 80,
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_SECURE: process.env.SMTP_SECURE,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,
        MAIL_FROM: process.env.MAIL_FROM,
        MAIL_TO: process.env.MAIL_TO,
        OLLAMA_ENABLED: process.env.OLLAMA_ENABLED,
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
        OLLAMA_MODEL: process.env.OLLAMA_MODEL,
        AGENT_API_KEY: process.env.AGENT_API_KEY,
        PYTHON_PATH: process.env.PYTHON_PATH || 'python3',
        AGENTS_PATH: process.env.AGENTS_PATH || './agents',
        AGENT_TIMEOUT: process.env.AGENT_TIMEOUT || '120',
        MAX_SCRAPE_DEPTH: process.env.MAX_SCRAPE_DEPTH || '3',
        SEO_MAX_URLS: process.env.SEO_MAX_URLS || '20',
        SEO_CONCURRENCY: process.env.SEO_CONCURRENCY || '5'
      }
    }
  ]
};
