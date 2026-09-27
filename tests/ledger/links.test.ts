import { describe, it, expect, vi } from 'vitest';
import { txLink, txUrl, withLink } from '../../src/ledger/links.js';
import { linksToEntities, sendMarkdownSafe, sendPlainWithLinks } from '../../src/telegram/format.js';

// Every transaction Luca names comes with a BaseScan link the operator can tap to check
// the claim on chain. Only real transaction hashes ever become links.
const HASH = '0xf5a236a3252c3385c02b7fe768ec90e37768f7a83fda13b3f2b4c197183aa0e3';
const URL = `https://basescan.org/tx/${HASH}`;
const LINK = `[0xf5a2…a0e3](${URL})`;

describe('transaction links', () => {
  it('turns a full hash into a short tappable BaseScan link', () => {
    expect(txUrl(HASH)).toBe(URL);
    expect(txLink(HASH)).toBe(LINK);
    // Mixed case from a provider still links to the canonical lowercase URL
    expect(txLink(HASH.toUpperCase().replace('0X', '0x'))).toBe(`[0xF5A2…A0E3](${URL})`);
  });

  it('never builds a link from anything that is not a full transaction hash', () => {
    expect(txUrl('0xf5a236a3')).toBeNull();
    expect(txLink('0xf5a236a3')).toBe('0xf5a236a3');
    expect(txLink(`${HASH})[x](https://evil.example`)).not.toContain('](');
    expect(txLink('0x4456e276faa5767d7de996dddd39cec4f53801f1')).toBe('0x4456…01f1'); // an address
  });

  it('adds the link to a row without changing anything else', () => {
    expect(withLink({ id: 'e1', hash: HASH, amount: '12' })).toEqual({ id: 'e1', hash: HASH, amount: '12', link: LINK });
  });
});

describe('links in messages sent as plain text', () => {
  it('turns explorer links into link entities over plain text', () => {
    const { text, entities } = linksToEntities(`Sep 3, 12.00 USDC in (${LINK}): missing.\nTransaction: ${LINK}`);
    expect(text).toBe('Sep 3, 12.00 USDC in (0xf5a2…a0e3): missing.\nTransaction: 0xf5a2…a0e3');
    expect(entities).toEqual([
      { type: 'text_link', offset: 22, length: 11, url: URL },
      { type: 'text_link', offset: 58, length: 11, url: URL },
    ]);
    for (const e of entities) expect(text.slice(e.offset, e.offset + e.length)).toBe('0xf5a2…a0e3');
  });

  it('counts offsets the way Telegram does, past emoji and other wide characters', () => {
    const { text, entities } = linksToEntities(`@dan_🚀 paid ${LINK}`);
    expect(text.slice(entities[0].offset, entities[0].offset + entities[0].length)).toBe('0xf5a2…a0e3');
  });

  it('leaves every other bracket, underscore and link alone', () => {
    const input = 'Wallet [ops_main] paid [click](https://evil.example/tx/1) and [x](https://basescan.org/address/0xabc)';
    expect(linksToEntities(input)).toEqual({ text: input, entities: [] });
  });

  it('sends plain text with the links as entities and no preview cards', async () => {
    const send = vi.fn((_t: string, _x: Record<string, unknown>) => Promise.resolve({ message_id: 1 }));
    await sendPlainWithLinks(send, `Large inflow\nTransaction: ${LINK}`);
    const [text, extra] = send.mock.calls[0];
    expect(text).toBe('Large inflow\nTransaction: 0xf5a2…a0e3');
    expect(extra).toEqual({
      link_preview_options: { is_disabled: true },
      entities: [{ type: 'text_link', offset: 26, length: 11, url: URL }],
    });
    expect(extra).not.toHaveProperty('parse_mode');
  });

  it('keeps links tappable when Telegram rejects a Markdown reply and it is resent as plain text', async () => {
    const send = vi.fn((_t: string, x: Record<string, unknown>) =>
      x.parse_mode ? Promise.reject(Object.assign(new Error('Bad Request'), { description: "Bad Request: can't parse entities" })) : Promise.resolve({ message_id: 2 }));
    await sendMarkdownSafe(send, `Checked @dan_x's wallet: ${LINK}`);
    expect(send).toHaveBeenCalledTimes(2);
    const [text, extra] = send.mock.calls[1];
    expect(text).toBe("Checked @dan_x's wallet: 0xf5a2…a0e3");
    expect(extra.entities).toEqual([{ type: 'text_link', offset: 25, length: 11, url: URL }]);
  });
});
