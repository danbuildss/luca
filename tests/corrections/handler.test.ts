import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyCorrection, EventNotFoundError } from '../../src/corrections/handler.js';

// Mock DB modules to keep tests unit-level (no real DB)
vi.mock('../../src/corrections/store.js', () => ({
  getEventWithClassification: vi.fn(),
  upsertCounterpartyRule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db.js', () => {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn().mockResolvedValue(client) },
    query: vi.fn(),
  };
});

import * as store from '../../src/corrections/store.js';
import * as db from '../../src/db.js';

describe('applyCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset pool.connect mock with fresh client each test
    // (the corrections INSERT ... RETURNING id needs a row)
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'corr-1' }] }),
      release: vi.fn(),
    };
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
  });

  it('throws EventNotFoundError when event does not belong to user', async () => {
    (store.getEventWithClassification as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      applyCorrection({
        userId: 'user-1',
        eventId: 'evt-missing',
        newLabel: 'revenue',
      }),
    ).rejects.toThrow(EventNotFoundError);
  });

  it('calls upsertCounterpartyRule with from_address for incoming events', async () => {
    (store.getEventWithClassification as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'evt-1',
      direction: 'in',
      from_address: '0xSENDER',
      to_address: '0xMYWALLET',
      asset: 'USDC',
      amount: 100,
      current_label: 'unknown',
    });

    await applyCorrection({
      userId: 'user-1',
      eventId: 'evt-1',
      newLabel: 'revenue',
      reason: 'client payment',
      counterpartyName: 'Acme',
    });

    expect(store.upsertCounterpartyRule).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0xSENDER',
        label: 'revenue',
        name: 'Acme',
      }),
    );
  });

  it('calls upsertCounterpartyRule with to_address for outgoing events', async () => {
    (store.getEventWithClassification as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'evt-2',
      direction: 'out',
      from_address: '0xMYWALLET',
      to_address: '0xVENDOR',
      asset: 'USDC',
      amount: 50,
      current_label: null,
    });

    await applyCorrection({
      userId: 'user-1',
      eventId: 'evt-2',
      newLabel: 'expense',
    });

    expect(store.upsertCounterpartyRule).toHaveBeenCalledWith(
      expect.objectContaining({ address: '0xVENDOR', label: 'expense' }),
    );
  });

  it('records the event direction on the learned rule', async () => {
    (store.getEventWithClassification as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'evt-4',
      direction: 'in',
      from_address: '0xCUSTOMER',
      to_address: '0xMYWALLET',
      asset: 'USDC',
      amount: 100,
      current_label: null,
    });

    await applyCorrection({ userId: 'user-1', eventId: 'evt-4', newLabel: 'revenue' });

    expect(store.upsertCounterpartyRule).toHaveBeenCalledWith(
      expect.objectContaining({ address: '0xCUSTOMER', label: 'revenue', direction: 'in' }),
    );
  });

  it('stores the corrected classification as user-sourced, under the event lock', async () => {
    (store.getEventWithClassification as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'evt-5',
      direction: 'out',
      from_address: '0xMYWALLET',
      to_address: '0xVENDOR',
      asset: 'USDC',
      amount: 10,
      current_label: 'revenue',
    });
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'corr-1' }] }),
      release: vi.fn(),
    };
    (db.pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);

    await applyCorrection({ userId: 'user-1', eventId: 'evt-5', newLabel: 'refund' });

    const sqls = client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    const lockIdx = sqls.findIndex((s) => /FROM normalized_events[\s\S]*FOR UPDATE/.test(s));
    const insertIdx = sqls.findIndex((s) => s.includes('INSERT INTO classifications'));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(lockIdx);
    expect(sqls[insertIdx]).toContain("'user'");
    expect(store.upsertCounterpartyRule).toHaveBeenCalledWith(
      expect.objectContaining({ address: '0xVENDOR', label: 'refund', direction: 'out' }),
    );
  });

  it('skips upsertCounterpartyRule when to_address is null', async () => {
    (store.getEventWithClassification as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'evt-3',
      direction: 'out',
      from_address: '0xMYWALLET',
      to_address: null,
      asset: 'ETH',
      amount: 0.00005,
      current_label: null,
    });

    await applyCorrection({ userId: 'user-1', eventId: 'evt-3', newLabel: 'gas' });

    expect(store.upsertCounterpartyRule).not.toHaveBeenCalled();
  });
});
