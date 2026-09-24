// Integration: resolving a transaction reference (event id or tx hash) for agent
// corrections, against real Postgres. See tests/integration/helpers/db.ts for how to run.
import { it, expect } from 'vitest';
import { describeDb, useIntegrationDb, seedUserWithWallet, insertEvent, insertClassification, sql } from './helpers/db.js';
import { resolveEventRef } from '../../src/corrections/store.js';
import { prepareWriteAction, executeTool } from '../../src/agent/tools.js';

const HASH = '0x619bde940b307b97fb2450376627e4627ca169bdd0049c685ca4df438cc7362b';

describeDb('transaction references (integration)', () => {
  useIntegrationDb();

  it('resolves an event id, a full hash, and a shortened hash with an ellipsis', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertEvent({ wallet, direction: 'in', hash: HASH });

    for (const ref of [ev.id, HASH, HASH.toUpperCase().replace('0X', '0x'), '0x619bde94…', '0x619bde94...']) {
      const r = await resolveEventRef(user.id, ref);
      expect(r.status === 'found' && r.event.id).toBe(ev.id);
    }
  });

  it('never resolves another user\'s transaction, spam, or malformed input', async () => {
    const me = await seedUserWithWallet();
    const other = await seedUserWithWallet();
    await insertEvent({ wallet: other.wallet, direction: 'in', hash: HASH });
    await insertEvent({ wallet: me.wallet, direction: 'in', asset: 'SCAM', hash: `0xdead${'0'.repeat(60)}` });

    for (const ref of [HASH, '0xdead0000', 'not-a-hash', '0x12', '']) {
      expect((await resolveEventRef(me.user.id, ref)).status).toBe('not_found');
    }
  });

  it('reports ambiguity when one hash has several of the user\'s transfers', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const first = await insertEvent({ wallet, direction: 'out', hash: HASH, sourceKey: 'log:1', logIndex: 1 });
    // A second leg of the same transaction (e.g. a swap) shares its transactions row
    await sql(
      `INSERT INTO normalized_events
         (transaction_id, wallet_id, user_id, chain, hash, log_index, source_key, block_time,
          from_address, to_address, asset, amount, direction, token_address, supported)
       SELECT transaction_id, wallet_id, user_id, chain, hash, 2, 'log:2', block_time,
              to_address, from_address, 'BNKR', 1000, 'in', '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', TRUE
       FROM normalized_events WHERE id = $1`,
      [first.id],
    );
    const r = await resolveEventRef(user.id, HASH);
    expect(r.status).toBe('ambiguous');
  });

  it('prepares a correction given a shortened hash, and applies it once confirmed', async () => {
    const { user, wallet } = await seedUserWithWallet();
    const ev = await insertEvent({ wallet, direction: 'in', hash: HASH, amount: 49.438831 });
    await insertClassification({ eventId: ev.id, userId: user.id, label: 'revenue', confidence: 0.7 });

    const prepared = await prepareWriteAction(user.id, 'apply_correction', {
      event_id: '0x619bde94…', new_label: 'internal_transfer', counterparty_name: 'my other wallet',
    });
    expect(prepared).toMatchObject({ ok: true, args: { event_id: ev.id, tx_hash: HASH } });

    const result = await executeTool(user.id, 'apply_correction', prepared.ok ? prepared.args : {});
    expect(result).toMatchObject({ success: true, event_id: ev.id });
    const active = await sql<{ label: string; source: string }>(
      `SELECT label::text, source FROM classifications WHERE event_id = $1 AND superseded_at IS NULL`, [ev.id],
    );
    expect(active).toEqual([{ label: 'internal_transfer', source: 'user' }]);
  });

  it('refuses to prepare a correction for an unknown transaction, so no confirm button is shown', async () => {
    const { user } = await seedUserWithWallet();
    const prepared = await prepareWriteAction(user.id, 'apply_correction', { event_id: HASH, new_label: 'expense' });
    expect(prepared.ok).toBe(false);
  });
});
