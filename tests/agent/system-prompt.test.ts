import { describe, it, expect, vi } from 'vitest';

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
