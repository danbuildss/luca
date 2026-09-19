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

  // LLM — at least one required in production
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Optional
  BASESCAN_API_KEY: z.string().optional(),

  // Bankr Wallet API — read-only portfolio enrichment
  BANKR_API_KEY: z.string().optional(),

  // App
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // LLM circuit breaker (dollars per day — halt LLM calls if exceeded)
  LLM_DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(1.0),
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
  if (!config.ANTHROPIC_API_KEY && !config.OPENAI_API_KEY) {
    missing.push('ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }
  if (missing.length > 0) {
    console.error(`Luca cannot start in production — missing:\n${missing.map(k => `  ${k}`).join('\n')}`);
    process.exit(1);
  }
}
