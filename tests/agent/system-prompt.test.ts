import { describe, it, expect, vi, type Mock } from 'vitest';

// system.ts reads prompts/system.md relative to the compiled file in dist/; stub the read
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return { ...fs, readFileSync: vi.fn(() => '# Luca base prompt') };
});
vi.mock('../../src/db.js', () => ({
  query: vi.fn(() => Promise.resolve({ rows: [] })),
  pool: { connect: vi.fn() },
}));

import { buildSystemPrompt, ADMIN_NOTE } from '../../src/agent/system.js';

describe('system prompt by role', () => {
  it('tells the model it is talking to an admin, so it calls the admin tools', async () => {
    const prompt = await buildSystemPrompt('user-1', 'admin');
    expect(prompt).toContain(ADMIN_NOTE);
    expect(prompt).toContain('call the matching tool straight away');
  });

  it('never tells an operator about the admin tools by name', async () => {
    const prompt = await buildSystemPrompt('user-1', 'operator');
    expect(prompt).not.toContain(ADMIN_NOTE);
    expect(prompt).not.toMatch(/admin_get_/);
  });

  it('treats a caller without a role as an operator', async () => {
    expect(await buildSystemPrompt('user-1')).not.toContain(ADMIN_NOTE);
  });
});

describe('open questions about earlier transfers', () => {
  it('lists them, as data, so the model can answer the one the operator names', async () => {
    const db = await import('../../src/db.js');
    const q = db.query as unknown as Mock<(text: string) => Promise<{ rows: unknown[] }>>;
    q.mockImplementation((text: string) => Promise.resolve(
      text.includes('FROM label_proposals') ? {
        rows: [{ id: 'p-1', created_at: new Date('2026-09-27T12:30:00Z'), question: 'I found 6 earlier payments to 0xabcd…1234 that the same rule covers (6 labeled expense). Want me to label them revenue too?\n- Sep 20  12 USDC  [0x1111…2222](https://basescan.org/tx/0x1)' }],
      } : { rows: [] }));
    const prompt = await buildSystemPrompt('user-1', 'operator');
    expect(prompt).toContain('## Open Questions');
    expect(prompt).toContain('<data>\n1. id p-1, asked 2026-09-27 12:30 UTC: I found 6 earlier payments to 0xabcd…1234 that the same rule covers (6 labeled expense). Want me to label them revenue too?\n</data>');
    q.mockImplementation(() => Promise.resolve({ rows: [] }));
    expect(await buildSystemPrompt('user-1', 'operator')).not.toContain('## Open Questions');
  });
});
