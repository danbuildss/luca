// Writes askluca.xyz/building (landing/building/index.html) from site/building.ts.
//
//   npm run site:building           regenerate the page
//   npm run site:building -- --check   fail if the committed page is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildingData } from '../site/building.js';
import { renderBuildingPage } from '../site/render.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../landing/building/index.html');
const html = renderBuildingPage(buildingData);

if (process.argv.includes('--check')) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (current !== html) {
    console.error('landing/building/index.html is out of date: run `npm run site:building` and commit it.');
    process.exit(1);
  }
  console.log('landing/building/index.html is up to date.');
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}
