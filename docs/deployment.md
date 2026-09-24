# Luca — Deployment

## Development (Mac)

### Prerequisites
- Node.js 20+
- Postgres (local or Docker)
- Telegram Bot Token (from @BotFather)
- Alchemy API key (Base RPC + Transfers API)
- OpenAI or Anthropic API key (for the Luca agent)

### Setup

```bash
git clone https://github.com/danbuildss/luca
cd luca
cp .env.example .env
# fill in .env values
npm install
npm run db:migrate
npm run dev
```

### Local Postgres via Docker

```bash
docker run --name luca-db \
  -e POSTGRES_PASSWORD=luca \
  -e POSTGRES_DB=luca \
  -p 5432:5432 \
  -d postgres:16
```

### Run locally

```bash
npm run worker   # ingestion + classification
npm run bot      # telegram bot
npm run api      # api server
```

## Production (VPS)

### Recommended Stack
- Ubuntu 22.04 LTS
- Node.js 20
- Postgres 16
- PM2 (process manager)
- Nginx (reverse proxy for API)
- Certbot (SSL)

### Setup

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pm2
git clone https://github.com/danbuildss/luca
cd luca
cp .env.example .env
npm install
npm run db:migrate
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### PM2 Ecosystem (ecosystem.config.js)

```js
module.exports = {
  apps: [
    { name: 'luca-worker', script: 'dist/apps/worker/index.js', instances: 1, autorestart: true },
    { name: 'luca-bot', script: 'dist/apps/telegram/index.js', instances: 1, autorestart: true },
    { name: 'luca-api', script: 'dist/apps/api/index.js', instances: 1, autorestart: true },
  ],
};
```

## Environment Variables

Required:
- DATABASE_URL
- TELEGRAM_BOT_TOKEN
- ALCHEMY_API_KEY
- OPENAI_API_KEY or ANTHROPIC_API_KEY
- BASE_RPC_URL

## Backups

```bash
# daily postgres backup
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# automate with cron
0 2 * * * pg_dump $DATABASE_URL > /backups/luca_$(date +\%Y\%m\%d).sql
```

## Updates

```bash
git pull
npm install
npm run build
npm run db:migrate
pm2 restart all
```
