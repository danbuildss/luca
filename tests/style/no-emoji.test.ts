// Luca's voice is professional and friendly: no emojis in anything it sends or in the
// instructions that shape its replies. This guard fails the build if one slips back in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED = [
  { dir: 'src', ext: '.ts' },
  { dir: 'apps', ext: '.ts' },
  { dir: 'prompts', ext: '.md' },
];
// Pictographs, dingbats and misc symbols
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]/u;

function files(dir: string, ext: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(abs, f));
}

describe('house style', () => {
  it('has no emojis in source code or agent instructions', () => {
    const offenders: string[] = [];
    for (const { dir, ext } of SCANNED) {
      for (const file of files(dir, ext)) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (EMOJI.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
