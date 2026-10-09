// The README's images and links point at files that exist, so a renamed graphic or doc
// fails CI instead of showing a broken image on GitHub.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

function localTargets(text: string): string[] {
  const found = [
    ...[...text.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
  ];
  return [...new Set(found.map((t) => t.split('#')[0]).filter((t) => t && !/^[a-z]+:/i.test(t)))];
}

describe('README', () => {
  it('every local image and link exists', () => {
    const targets = localTargets(README);
    expect(targets.length).toBeGreaterThan(20);
    const missing = targets.filter((t) => !fs.existsSync(path.join(ROOT, t)));
    expect(missing).toEqual([]);
  });

  it('every themed graphic has both a light and a dark version', () => {
    for (const [, name] of README.matchAll(/docs\/assets\/([a-z-]+)-light\.svg/g)) {
      expect(fs.existsSync(path.join(ROOT, `docs/assets/${name}-dark.svg`)), name).toBe(true);
    }
  });
});
