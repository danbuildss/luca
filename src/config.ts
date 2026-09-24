import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const schema = z.object({
  // Database — required in all environments
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Telegram — required in non-test environments
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required').optional(),

  // Alchemy — required in non-test environments
  ALCHEMY_API_KEY: z.string().min(1, 'ALCHEMY_API_KEY is required').optional(),
  BASE_RPC_URL: z.string().url('BASE_RPC_URL must be a valid URL').optional(),

  // LLM — OpenAI (gpt-4o-mini) for classification, gpt-4o for agent
  OPENAI_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default('gpt-4o'),
  // Agent LLM override — use a different key/endpoint for the agent (e.g. Bankr LLM Gateway)
  // If unset, OPENAI_API_KEY + standard OpenAI endpoint are used.
  AGENT_LLM_KEY: z.string().optional(),
  AGENT_BASE_URL: z.string().url().optional(),

  // Optional
  BASESCAN_API_KEY: z.string().optional(),

  // App
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // API bind address. Loopback by default: user routes trust the x-user-id header,
  // so the API must never be reachable from outside the host without real auth.
  API_HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // LLM circuit breaker (dollars per day — halt LLM calls if exceeded)
  LLM_DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(1.0),

  // Admin key for beta invite management (POST /admin/invite)
  LUCA_ADMIN_KEY: z.string().min(1).optional(),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  // Never log env values — only key names and messages
  const issues = result.error.issues
    .map(i => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Luca cannot start — configuration error:\n${issues}`);
  process.exit(1);
}

export const config = result.data;

export function requireProductionConfig() {
  const missing: string[] = [];
  if (!config.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.ALCHEMY_API_KEY) missing.push('ALCHEMY_API_KEY');
  if (!config.BASE_RPC_URL) missing.push('BASE_RPC_URL');
  // OPENAI_API_KEY is optional — classification degrades gracefully without it
  if (missing.length > 0) {
    console.error(`Luca cannot start in production — missing:\n${missing.map(k => `  ${k}`).join('\n')}`);
    process.exit(1);
  }
}
