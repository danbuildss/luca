import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset module registry so config re-evaluates on each test
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads successfully with required vars set', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.NODE_ENV = 'test';

    const { config } = await import('../src/config.js');
    expect(config.DATABASE_URL).toBe('postgresql://localhost:5432/test');
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.LLM_DAILY_SPEND_CAP_USD).toBe(1.0);
  });

  it('uses PORT from env when set', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.PORT = '4000';
    process.env.NODE_ENV = 'test';

    const { config } = await import('../src/config.js');
    expect(config.PORT).toBe(4000);
  });

  it('uses custom LLM_DAILY_SPEND_CAP_USD', async () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    process.env.NODE_ENV = 'test';
    process.env.LLM_DAILY_SPEND_CAP_USD = '5.0';

    const { config } = await import('../src/config.js');
    expect(config.LLM_DAILY_SPEND_CAP_USD).toBe(5.0);
  });
});

describe('classification labels', () => {
  it('canonical 10-label set is complete', async () => {
    const { CLASSIFICATION_LABELS } = await import('../src/types/index.js');
    expect(CLASSIFICATION_LABELS).toHaveLength(10);
    expect(CLASSIFICATION_LABELS).toContain('revenue');
    expect(CLASSIFICATION_LABELS).toContain('expense');
    expect(CLASSIFICATION_LABELS).toContain('internal_transfer');
    expect(CLASSIFICATION_LABELS).toContain('treasury');
    expect(CLASSIFICATION_LABELS).toContain('gas');
    expect(CLASSIFICATION_LABELS).toContain('x402_income');
    expect(CLASSIFICATION_LABELS).toContain('x402_spend');
    expect(CLASSIFICATION_LABELS).toContain('refund');
    expect(CLASSIFICATION_LABELS).toContain('swap');
    expect(CLASSIFICATION_LABELS).toContain('unknown');
  });

  it('ClassificationLabel enum matches array', async () => {
    const { ClassificationLabel, CLASSIFICATION_LABELS } = await import('../src/types/index.js');
    const enumValues = Object.values(ClassificationLabel);
    expect(enumValues.sort()).toEqual([...CLASSIFICATION_LABELS].sort());
  });

  it('brief categories cover every label with no overlap', async () => {
    const { BRIEF_CATEGORIES, CLASSIFICATION_LABELS } = await import('../src/types/index.js');
    const allCovered = Object.values(BRIEF_CATEGORIES).flat();
    const unique = new Set(allCovered);
    // Every label is covered
    for (const label of CLASSIFICATION_LABELS) {
      expect(allCovered).toContain(label);
    }
    // No label appears in more than one category
    expect(unique.size).toBe(allCovered.length);
  });

  it('the AI can never choose gas, internal transfer or swap', async () => {
    const { MODEL_LABELS } = await import('../src/types/index.js');
    for (const label of ['gas', 'internal_transfer', 'swap']) {
      expect(MODEL_LABELS).not.toContain(label);
    }
  });
});
