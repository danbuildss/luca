import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildingData, type BuildingData } from '../../site/building.js';
import { renderBuildingPage, validate, publishedLog, publishedRoadmap, displayDate } from '../../site/render.js';

const root = path.resolve(__dirname, '../..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');
const clone = (): BuildingData => JSON.parse(JSON.stringify(buildingData)) as BuildingData;

describe('/building', () => {
  it('the committed page is exactly what site/building.ts renders (run `npm run site:building` after editing it)', () => {
    expect(read('landing/building/index.html')).toBe(renderBuildingPage(buildingData));
  });

  it('the content is valid', () => {
    expect(validate(buildingData)).toEqual([]);
  });

  it('drafts and private entries never reach the page', () => {
    const data = clone();
    data.roadmap.push({ title: 'Secret roadmap draft', stage: 'next', status: 'exploring', public: true, draft: true });
    data.roadmap.push({ title: 'Private roadmap item', stage: 'later', status: 'exploring', public: false, draft: false });
    data.buildLog.push({ date: '2026-10-01', title: 'Unpublished log draft', description: 'Not yet.', status: 'shipped', public: true, draft: true });
    data.buildLog.push({ date: '2026-10-02', title: 'Private log entry', description: 'Never.', status: 'fixed', public: false, draft: false });
    const html = renderBuildingPage(data);
    for (const hidden of ['Secret roadmap draft', 'Private roadmap item', 'Unpublished log draft', 'Private log entry', 'Not yet.', 'Never.']) {
      expect(html, hidden).not.toContain(hidden);
    }
    expect(publishedLog(data).map((e) => e.title)).not.toContain('Private log entry');
  });

  it('shows CURRENTLY from the data, with the last-updated date', () => {
    const html = renderBuildingPage(buildingData);
    expect(html).toContain('Testing Luca against real financial activity and onboarding the first outside operators.');
    expect(html).toContain('Base · Invite-only beta · Read-only');
    expect(html).toContain('Last updated: <time datetime="2026-09-27">Sep 27, 2026</time>');
  });

  it('roadmap: SHIPPED, NOW, NEXT, LATER in that order; NEXT and LATER are direction, not commitments', () => {
    expect(publishedRoadmap(buildingData).map((g) => [g.stage, g.items.length])).toEqual([['shipped', 11], ['now', 4], ['next', 4], ['later', 4]]);
    const html = renderBuildingPage(buildingData);
    expect(html.match(/Direction, not commitments\./g)).toHaveLength(2);
    // A stage with nothing published is not shown at all
    const data = clone();
    data.roadmap = data.roadmap.filter((r) => r.stage !== 'next');
    expect(renderBuildingPage(data)).not.toContain('>Next<');
  });

  it('build log: newest first, same-day entries in the order written', () => {
    const data = clone();
    data.buildLog.push({ date: '2026-09-28', title: 'Later entry', description: 'x', status: 'shipped', public: true, draft: false });
    const titles = publishedLog(data).map((e) => e.title);
    expect(titles[0]).toBe('Later entry');
    expect(titles.slice(1, 3)).toEqual(['Corrections now ask before changing history', 'Books can now be checked against Base']);
    expect(titles.at(-1)).toBe('Balance reconciliation caught missing gas entries');
    expect(displayDate('2026-09-24')).toBe('Sep 24, 2026');
  });

  it('refuses content it would render wrongly, and escapes everything', () => {
    const bad = clone();
    bad.current.lastUpdated = '27 Sep';
    bad.buildLog[0].date = '2026-02-30';
    (bad.roadmap[0] as { status: string }).status = 'done';
    bad.buildLog[1].evidenceLink = 'javascript:alert(1)';
    expect(() => renderBuildingPage(bad)).toThrow(/lastUpdated[\s\S]*unknown status: done[\s\S]*2026-02-30[\s\S]*evidenceLink/);

    const data = clone();
    data.buildLog.find((e) => e.public && !e.draft)!.title = '<script>alert(1)</script>';
    const html = renderBuildingPage(data);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('makes no claim the page must not make', () => {
    const text = renderBuildingPage(buildingData).replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/\d+\s?%/);
    expect(text).not.toMatch(/guarantee|coming soon|can (send|sign|trade|move)/i);
  });

  it('is linked from the site: nav and footer of the homepage, the sitemap, and served at /building', () => {
    const home = read('landing/index.html');
    expect(home).toContain('<li><a href="/building">Building</a></li>');
    expect(home.match(/href="\/building"/g)).toHaveLength(2);
    expect(read('landing/sitemap.xml')).toContain('<loc>https://askluca.xyz/building</loc>');
    const vercel = JSON.parse(read('vercel.json')) as { rewrites: Array<{ source: string; destination: string }> };
    expect(vercel.rewrites).toContainEqual({ source: '/building', destination: '/building/index.html' });
  });

  it('the phone menu is wired on every page that has the nav', () => {
    for (const html of [read('landing/index.html'), renderBuildingPage(buildingData)]) {
      expect(html).toContain('<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-links">Menu</button>');
      expect(html).toContain('<ul class="nav-links" id="nav-links">');
    }
    expect(read('landing/main.js')).toContain("document.querySelector('.nav-toggle')");
  });
});
