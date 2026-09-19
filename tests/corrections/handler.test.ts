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
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
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
