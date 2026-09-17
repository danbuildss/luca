import { describe, expect, it } from 'vitest';

import { ConfigurationError, readConfig } from '../core/config.js';

describe('readConfig', () => {
  it('parses the minimum Phase 1 configuration', () => {
    const config = readConfig({
      DATABASE_URL: 'postgresql://postgres:luca@localhost:5432/luca',
    });

    expect(config).toEqual({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      databaseUrl: 'postgresql://postgres:luca@localhost:5432/luca',
    });
  });

  it('rejects a missing database URL without exposing unrelated environment values', () => {
    const secret = 'should-not-appear';

    expect(() => readConfig({ BANKR_API_KEY: secret })).toThrow(ConfigurationError);

    try {
      readConfig({ BANKR_API_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects non-PostgreSQL database URLs', () => {
    expect(() => readConfig({ DATABASE_URL: 'https://example.com/database' })).toThrow(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
  });

  it('validates the configured port', () => {
    expect(() =>
      readConfig({
        DATABASE_URL: 'postgresql://postgres:luca@localhost:5432/luca',
        PORT: '70000',
      }),
    ).toThrow('PORT');
  });
});
