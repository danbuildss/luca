import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    // Never log secrets or full wallet addresses
    paths: [
      'DATABASE_URL',
      'TELEGRAM_BOT_TOKEN',
      'ALCHEMY_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'key_hash',
      'token',
      'privateKey',
      'seed',
    ],
    censor: '[REDACTED]',
  },
});
