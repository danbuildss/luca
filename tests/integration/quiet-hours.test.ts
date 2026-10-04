// Integration: nothing Luca sends on its own reaches an operator between 22:00 and 08:00
// their time (src/notify/quiet-hours.ts), and the operator sets their timezone in chat.
import { it, expect } from 'vitest';
import { describeDb, useIntegrationDb, seedUserWithWallet, sql } from './helpers/db.js';
import { getUndeliveredAlerts } from '../../src/alerts/deliver.js';
import { setTimezone } from '../../src/notify/timezone.js';
import { executeTool } from '../../src/agent/tools.js';

const alert = (userId: string, type: string) =>
  sql(`INSERT INTO alerts (user_id, type, message, dedup_key) VALUES ($1, $2, $3, $4)`, [userId, type, type, `${type}:${userId}`]);

describeDb('quiet hours (integration)', () => {
  useIntegrationDb();

  it('a large outflow at 23:30 Lagos time waits for the morning; "your books are ready" does not', async () => {
    const { user } = await seedUserWithWallet({ timezone: 'Africa/Lagos' });
    await alert(user.id, 'large_outflow');
    await alert(user.id, 'wallet_ready');

    const night = new Date('2026-10-04T22:30:00Z'); // 23:30 in Lagos
    expect((await getUndeliveredAlerts(user.id, night)).map((a) => a.type)).toEqual(['wallet_ready']);

    const morning = new Date('2026-10-05T07:05:00Z'); // 08:05 in Lagos
    expect((await getUndeliveredAlerts(user.id, morning)).map((a) => a.type).sort()).toEqual(['large_outflow', 'wallet_ready']);
  });

  it('"I\'m in London": saved straight away, in Luca\'s words; an unknown zone changes nothing', async () => {
    const { user } = await seedUserWithWallet();
    const now = new Date('2026-10-04T13:05:00Z');
    expect(await setTimezone(user.id, 'Europe/London', now)).toBe(
      "Got it, I'll use London time (it's 14:05 there now). I won't message you between 22:00 and 08:00.",
    );
    expect((await sql<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [user.id]))[0].timezone).toBe('Europe/London');

    expect(await setTimezone(user.id, 'Mars/Base', now)).toMatch(/^I don't recognise that timezone, so I haven't changed anything\./);
    expect((await sql<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [user.id]))[0].timezone).toBe('Europe/London');

    // Through the chat tool, for this operator only
    const other = await seedUserWithWallet();
    await executeTool(other.user.id, 'set_timezone', { timezone: 'africa/lagos' });
    expect((await sql<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [other.user.id]))[0].timezone).toBe('Africa/Lagos');
    expect((await sql<{ timezone: string }>(`SELECT timezone FROM users WHERE id = $1`, [user.id]))[0].timezone).toBe('Europe/London');
  });
});
