import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB so the save path can be exercised without Postgres
vi.mock('../../src/db.js', () => ({
  pool: { connect: vi.fn() },
  query: vi.fn(),
}));

import * as db from '../../src/db.js';
import {
  saveManyClassifications,
  failureBackoffSeconds,
  MAX_CLASSIFICATION_ATTEMPTS,
} from '../../src/classification/store.js';
import type { SaveClassificationRow } from '../../src/classification/store.js';

type Active = { id: string; source: string | null; attempts: number };

// Fake client: returns the configured active classifications per event
function makeClient(activeByEvent: Record<string, Active[]>) {
  // eslint-disable-next-line @typescript-eslint/require-await -- mock mirrors the async client API
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM normalized_events[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ id: params[0] }] };
    if (/SELECT id, source, attempts FROM classifications/.test(sql)) {
      return { rows: activeByEvent[String(params[0])] ?? [] };
    }
    return { rows: [] };
  });
  return { query, release: vi.fn() };
}

function row(overrides: Partial<SaveClassificationRow> = {}): SaveClassificationRow {
  return {
    event_id: 'evt-1',
    user_id: 'user-1',
    label: 'revenue',
    confidence: 0.9,
    method: 'model',
    evidence: 'x',
    ...overrides,
  };
}

function writes(client: ReturnType<typeof makeClient>): string[] {
  return client.query.mock.calls
    .map((c) => String(c[0]))
    .filter((s) => /^\s*(INSERT|UPDATE)/.test(s));
}

describe('saveManyClassifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never supersedes a user correction', async () => {
    const client = makeClient({ 'evt-1': [{ id: 'c-user', source: 'user', attempts: 0 }] });
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    const written = await saveManyClassifications([row()]);
    expect(written).toBe(0);
    expect(writes(client)).toEqual([]);
  });

  it('skips when the active classification changed since the event was read', async () => {
    const client = makeClient({ 'evt-1': [{ id: 'c-new', source: null, attempts: 0 }] });
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    const written = await saveManyClassifications([row({ expected_active_id: null })]);
    expect(written).toBe(0);
    expect(writes(client)).toEqual([]);
  });

  it('replaces the failure placeholder it read', async () => {
    const client = makeClient({ 'evt-1': [{ id: 'c-fail', source: 'failure', attempts: 1 }] });
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    const written = await saveManyClassifications([row({ expected_active_id: 'c-fail' })]);
    expect(written).toBe(1);
    const w = writes(client);
    expect(w.some((s) => s.includes('SET superseded_at'))).toBe(true);
    expect(w.some((s) => s.includes('INSERT INTO classifications'))).toBe(true);
  });

  it('updates an existing failure placeholder in place and bumps attempts', async () => {
    const client = makeClient({ 'evt-1': [{ id: 'c-fail', source: 'failure', attempts: 2 }] });
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    await saveManyClassifications([
      row({
        label: 'unknown',
        confidence: 0,
        expected_active_id: 'c-fail',
        failure: { countsAsAttempt: true, reason: 'bad output' },
      }),
    ]);
    const update = client.query.mock.calls.find((c) => /SET attempts/.test(String(c[0])));
    expect(update).toBeDefined();
    expect(update?.[1]).toEqual(['c-fail', 3, failureBackoffSeconds(3, true), 'bad output']);
    expect(client.query.mock.calls.some((c) => /INSERT INTO classifications/.test(String(c[0])))).toBe(false);
  });

  it('inserts a new failure placeholder with source = failure', async () => {
    const client = makeClient({});
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    await saveManyClassifications([
      row({
        label: 'unknown',
        confidence: 0,
        expected_active_id: null,
        failure: { countsAsAttempt: false, reason: 'no key' },
      }),
    ]);
    const insert = client.query.mock.calls.find((c) => /INSERT INTO classifications/.test(String(c[0])));
    expect(String(insert?.[0])).toContain("'failure'");
    expect(insert?.[1]).toEqual(['evt-1', 'user-1', 'no key', 0, failureBackoffSeconds(0, false)]);
  });
});

describe('failureBackoffSeconds', () => {
  it('retries uncounted failures hourly', () => {
    expect(failureBackoffSeconds(0, false)).toBe(3600);
    expect(failureBackoffSeconds(4, false)).toBe(3600);
  });

  it('backs off exponentially for counted failures, capped at 24h', () => {
    expect(failureBackoffSeconds(1, true)).toBe(1800);
    expect(failureBackoffSeconds(2, true)).toBe(3600);
    expect(failureBackoffSeconds(3, true)).toBe(7200);
    expect(failureBackoffSeconds(20, true)).toBe(86400);
  });

  it('has a positive attempt cap', () => {
    expect(MAX_CLASSIFICATION_ATTEMPTS).toBeGreaterThan(0);
  });
});
