// Integration: src/briefs/generate.ts + src/briefs/store.ts against real Postgres.
// See tests/integration/helpers/db.ts for how to run.
import { describe, it, expect } from 'vitest';
import {
  describeDb, useIntegrationDb, seedUserWithWallet, insertUser, insertWallet, insertWatchJob,
  insertClassifiedEvent, insertCounterpartyRule, insertBrief, dbTime, sql,
} from './helpers/db.js';
import { buildMorning } from '../../src/briefs/generate.js';
import {
  getBriefSlotStatus, getAllBriefUsers, saveBrief, markBriefSent, updateBriefContent,
} from '../../src/briefs/store.js';

const CUSTOMER = '0x00000000000000000000000000000000000c0ffe';
const VENDOR = '0x0000000000000000000000000000000000000bad';

// One describeDb per file: useIntegrationDb()'s afterAll closes src/db.ts's pool.
describeDb('briefs (integration)', () => {
  useIntegrationDb();

describe('names in the morning message', () => {
  const since = () => new Date(Date.now() - 24 * 3_600_000);

  it('escapes Markdown underscores in a name the operator gave', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertCounterpartyRule({ userId: user.id, address: CUSTOMER, label: 'revenue', name: 'acme_corp_llc', direction: 'in' });
    await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', counterparty: CUSTOMER, amount: 42, usdValue: 42 });

    const m = await buildMorning(user.id, { timezone: 'UTC', since: since() });
    expect(m.text).toContain('- Received 42 USDC from acme\\_corp\\_llc.');
  });

  it('a same-direction name wins over a legacy one, which is still used when it is the only one', async () => {
    const { user, wallet } = await seedUserWithWallet();
    await insertCounterpartyRule({ userId: user.id, address: VENDOR, label: 'expense', name: 'Vendor Out', direction: 'out' });
    await insertCounterpartyRule({ userId: user.id, address: VENDOR, label: 'expense', name: 'Legacy Vendor', direction: null });
    await insertCounterpartyRule({ userId: user.id, address: CUSTOMER, label: 'revenue', name: 'Old Customer', direction: null });
    await insertClassifiedEvent({ wallet, direction: 'out', label: 'expense', counterparty: VENDOR, amount: 150, usdValue: 150 });
    await insertClassifiedEvent({ wallet, direction: 'in', label: 'revenue', counterparty: CUSTOMER, amount: 20, usdValue: 20 });

    const text = (await buildMorning(user.id, { timezone: 'UTC', since: since() })).text!;
    expect(text).toContain('- Paid 150 USDC to Vendor Out.');
    expect(text).toContain('- Received 20 USDC from Old Customer.');
    expect(text).not.toContain('Legacy Vendor');
  });
});

describe('brief slot status / scheduler due-logic', () => {
  async function localDate(tz: string): Promise<string> {
    const rows = await sql<{ d: string }>(`SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [tz]);
    return rows[0].d;
  }

  // Instant at which today's local slot `hhmm` opens in `tz`
  async function slotInstant(tz: string, hhmm: string): Promise<Date> {
    return dbTime(`(((NOW() AT TIME ZONE $1)::date + $2::time) AT TIME ZONE $1)`, [tz, hhmm]);
  }

  it('reports not sent / no pending when there are no briefs', async () => {
    const { user } = await seedUserWithWallet();
    const status = await getBriefSlotStatus({
      userId: user.id, type: 'daily', localDate: await localDate('UTC'), briefTime: '00:00', timezone: 'UTC',
    });
    expect(status).toEqual({ sent: false, pendingBriefId: null });
  });

  it('counts a brief sent after the slot opened; ignores one sent before it and other types', async () => {
    const { user } = await seedUserWithWallet();
    const params = { userId: user.id, type: 'daily' as const, localDate: await localDate('UTC'), briefTime: '00:00', timezone: 'UTC' };

    await insertBrief({ userId: user.id, type: 'daily', createdAt: '2 days', sentAt: '2 days' });
    await insertBrief({ userId: user.id, type: 'weekly', sentAt: '1 minute' });
    expect((await getBriefSlotStatus(params)).sent).toBe(false);

    await insertBrief({ userId: user.id, type: 'daily', sentAt: '1 second' });
    expect((await getBriefSlotStatus(params)).sent).toBe(true);
  });

  it('compares in the user\'s local wall-clock time, not UTC', async () => {
    const tz = 'Pacific/Kiritimati'; // UTC+14 — local date usually differs from UTC date
    const { user } = await seedUserWithWallet({ timezone: tz });
    const slot = await slotInstant(tz, '00:00');
    const params = { userId: user.id, type: 'daily' as const, localDate: await localDate(tz), briefTime: '00:00', timezone: tz };

    await insertBrief({ userId: user.id, type: 'daily', createdAt: new Date(slot.getTime() - 120_000), sentAt: new Date(slot.getTime() - 60_000) });
    expect((await getBriefSlotStatus(params)).sent).toBe(false);

    await insertBrief({ userId: user.id, type: 'daily', createdAt: slot, sentAt: new Date(slot.getTime() + 60_000) });
    expect((await getBriefSlotStatus(params)).sent).toBe(true);
  });

  it('returns the latest unsent brief created since the slot opened as pending, and reuses it', async () => {
    const { user } = await seedUserWithWallet();
    const params = { userId: user.id, type: 'daily' as const, localDate: await localDate('UTC'), briefTime: '00:00', timezone: 'UTC' };

    await insertBrief({ userId: user.id, type: 'daily', createdAt: '2 days', sentAt: null }); // stale, before slot
    expect((await getBriefSlotStatus(params)).pendingBriefId).toBeNull();

    const periodEnd = await dbTime('NOW()');
    const periodStart = new Date(periodEnd.getTime() - 86_400_000);
    const id = await saveBrief({ userId: user.id, type: 'daily', content: 'v1', periodStart, periodEnd });
    let status = await getBriefSlotStatus(params);
    expect(status).toEqual({ sent: false, pendingBriefId: id });

    await updateBriefContent({ briefId: id, content: 'v2', periodStart, periodEnd });
    await markBriefSent(id, 777);
    status = await getBriefSlotStatus(params);
    expect(status).toEqual({ sent: true, pendingBriefId: null });

    const rows = await sql<{ content: string; telegram_message_id: string; sent_at: Date | null }>(
      'SELECT content, telegram_message_id::text, sent_at FROM briefs WHERE id = $1', [id],
    );
    expect(rows[0].content).toBe('v2');
    expect(rows[0].telegram_message_id).toBe('777');
    expect(rows[0].sent_at).not.toBeNull();

    // A sent brief's content is frozen
    await updateBriefContent({ briefId: id, content: 'v3', periodStart, periodEnd });
    const after = await sql<{ content: string }>('SELECT content FROM briefs WHERE id = $1', [id]);
    expect(after[0].content).toBe('v2');
  });

  it('getAllBriefUsers only returns users with an active watch job', async () => {
    const { user: active } = await seedUserWithWallet({ timezone: 'Europe/Berlin', briefTime: '09:30' });
    const paused = await insertUser();
    const pw = await insertWallet({ userId: paused.id });
    await insertWatchJob({ userId: paused.id, walletId: pw.id, status: 'paused' });
    await insertUser(); // no wallet at all

    const users = await getAllBriefUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      userId: active.id, timezone: 'Europe/Berlin', briefTime: '09:30',
    });
    expect(typeof users[0].telegramId).toBe('number');
  });
});
});
