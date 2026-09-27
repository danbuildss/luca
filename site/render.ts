import {
  LOG_STATUSES, STAGES, STATUSES,
  type BuildLogEntry, type BuildingData, type RoadmapItem, type Stage,
} from './building.js';

// Renders askluca.xyz/building as one static page (landing/building/index.html) in the
// site's own markup and styles. Only published content (public, not draft) is rendered.

export const SITE = 'https://askluca.xyz';

const STAGE_LABEL: Record<Stage, string> = { shipped: 'Shipped', now: 'Now', next: 'Next', later: 'Later' };
// NEXT and LATER are direction, not commitments
const STAGE_NOTE: Partial<Record<Stage, string>> = { next: 'Direction, not commitments.', later: 'Direction, not commitments.' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

// "2026-09-27" → "Sep 27, 2026"
export function displayDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

const published = <T extends { public: boolean; draft: boolean }>(x: T): boolean => x.public && !x.draft;

// Fails the build on anything the page would render wrongly
export function validate(data: BuildingData): string[] {
  const errors: string[] = [];
  if (!isDate(data.current.lastUpdated)) errors.push(`current.lastUpdated is not a YYYY-MM-DD date: ${data.current.lastUpdated}`);
  if (!data.current.text.trim()) errors.push('current.text is empty');
  data.roadmap.forEach((r, i) => {
    if (!r.title.trim()) errors.push(`roadmap[${i}] has no title`);
    if (!(STAGES as readonly string[]).includes(r.stage)) errors.push(`roadmap[${i}] "${r.title}" has an unknown stage: ${r.stage}`);
    if (!(STATUSES as readonly string[]).includes(r.status)) errors.push(`roadmap[${i}] "${r.title}" has an unknown status: ${r.status}`);
  });
  data.buildLog.forEach((e, i) => {
    if (!isDate(e.date)) errors.push(`buildLog[${i}] "${e.title}" date is not YYYY-MM-DD: ${e.date}`);
    if (!e.title.trim() || !e.description.trim()) errors.push(`buildLog[${i}] needs a title and a description`);
    if (!(LOG_STATUSES as readonly string[]).includes(e.status)) errors.push(`buildLog[${i}] "${e.title}" has an unknown status: ${e.status}`);
    if (e.evidenceLink && !/^https:\/\//.test(e.evidenceLink)) errors.push(`buildLog[${i}] "${e.title}" evidenceLink must be an https:// link`);
  });
  return errors;
}

// Published roadmap items by stage, in the order they are listed
export function publishedRoadmap(data: BuildingData): Array<{ stage: Stage; items: RoadmapItem[] }> {
  return STAGES
    .map((stage) => ({ stage, items: data.roadmap.filter((r) => r.stage === stage && published(r)) }))
    .filter((g) => g.items.length > 0);
}

// Published log entries, newest first; entries on the same day keep their listed order
export function publishedLog(data: BuildingData): BuildLogEntry[] {
  return data.buildLog
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => published(e))
    .sort((a, b) => (a.e.date === b.e.date ? a.i - b.i : a.e.date < b.e.date ? 1 : -1))
    .map(({ e }) => e);
}

// LIVE carries the site's pulsing live dot (landing/styles.css .live-dot)
const status = (s: string): string =>
  `<span class="b-status${s === 'live' ? ' live' : ''}">${s === 'live' ? '<span class="live-dot" aria-hidden="true"></span>' : ''}${esc(s)}</span>`;

function roadmapHtml(data: BuildingData): string {
  return publishedRoadmap(data).map(({ stage, items }) => {
    const note = STAGE_NOTE[stage];
    const rows = items.map((r) => `
          <li>
            <div class="b-item"><span>${esc(r.title)}</span>${r.description ? `<p class="b-item-note">${esc(r.description)}</p>` : ''}</div>
            ${status(r.status)}
          </li>`).join('');
    return `
      <div class="b-stage">
        <div class="b-stage-head">
          <h3 class="b-stage-label">${STAGE_LABEL[stage]}</h3>${note ? `\n          <p class="b-stage-note">${note}</p>` : ''}
        </div>
        <ul class="b-items">${rows}
        </ul>
      </div>`;
  }).join('');
}

function logHtml(data: BuildingData): string {
  return publishedLog(data).map((e) => `
      <li>
        <p class="b-date"><time datetime="${e.date}">${displayDate(e.date)}</time></p>
        <div>
          <h3>${esc(e.title)}</h3>
          <p>${esc(e.description)}</p>
          <p class="b-log-meta">${status(e.status)}${e.evidenceLink ? `<a class="b-evidence" href="${esc(e.evidenceLink)}" target="_blank" rel="noopener">Evidence</a>` : ''}</p>
        </div>
      </li>`).join('');
}

export function renderBuildingPage(data: BuildingData): string {
  const errors = validate(data);
  if (errors.length > 0) throw new Error(`site/building.ts has problems:\n- ${errors.join('\n- ')}`);

  const title = 'Building — Luca';
  const description = "Luca's public build record: what works today, what we're proving now, where we're heading, and a log of what changed.";
  const url = `${SITE}/building`;

  return `<!DOCTYPE html>
<!-- Generated from site/building.ts by \`npm run site:building\`. Edit that file, not this one. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="author" content="Luca">
<meta property="og:locale" content="en_US">
<meta name="theme-color" content="#F4F3EE">
<meta name="color-scheme" content="light">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Luca">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Luca — Your financial employee on-chain.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@AskLucaAI">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/og.png">

<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap">
<link rel="stylesheet" href="/styles.css">
<script>document.documentElement.classList.add('js')</script>
<script defer src="https://cdn.vercel-insights.com/v1/script.js"></script>
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<header class="nav">
  <div class="wrap nav-inner">
    <a href="/" class="brand" aria-label="Luca home">
      <svg class="mark" viewBox="0 0 318 348" aria-hidden="true"><use href="#luca-mark"/></svg>
      <span class="wordmark" aria-hidden="true"></span>
    </a>
    <nav aria-label="Primary">
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-links">Menu</button>
      <ul class="nav-links" id="nav-links">
        <li><a href="/#books">Books</a></li>
        <li><a href="/#memory">Memory</a></li>
        <li><a href="/#briefs">Briefs</a></li>
        <li><a href="/#security">Security</a></li>
        <li><a href="/building" aria-current="page">Building</a></li>
      </ul>
    </nav>
    <a class="btn btn-sm" href="https://tally.so/r/J9yy8X" target="_blank" rel="noopener">Apply for beta</a>
  </div>
</header>

<main id="main" class="b-page">
  <div class="wrap">
    <h1>Building</h1>

    <section class="b-current" aria-labelledby="b-currently">
      <h2 class="kicker" id="b-currently"><span class="live-dot" aria-hidden="true"></span>Currently</h2>
      <p class="b-current-text">${esc(data.current.text)}</p>
      <p class="b-meta"><span>${esc(data.current.statusLine)}</span><span>Last updated: <time datetime="${data.current.lastUpdated}">${displayDate(data.current.lastUpdated)}</time></span></p>
    </section>

    <section class="b-section" aria-labelledby="b-roadmap">
      <div class="b-section-head">
        <h2 class="kicker" id="b-roadmap">Roadmap</h2>
        <p>What works, what we're proving now, and where we're heading.</p>
      </div>${roadmapHtml(data)}
    </section>

    <section class="b-section" aria-labelledby="b-log">
      <div class="b-section-head">
        <h2 class="kicker" id="b-log">Build log</h2>
        <p>Not everything we shipped. Everything worth remembering.</p>
      </div>
      <ol class="b-log">${logHtml(data)}
      </ol>
    </section>
  </div>
</main>

<footer class="footer">
  <div class="wrap footer-inner">
    <a href="/" class="brand" aria-label="Luca home">
      <svg class="mark" viewBox="0 0 318 348" aria-hidden="true"><use href="#luca-mark"/></svg>
      <span class="wordmark" aria-hidden="true"></span>
    </a>
    <ul class="footer-links">
      <li><a href="/building">Building</a></li>
      <li><a href="https://x.com/AskLucaAI" target="_blank" rel="noopener">X</a></li>
      <li><a href="https://t.me/asklucaai" target="_blank" rel="noopener">Telegram</a></li>
      <li><a href="https://tally.so/r/J9yy8X" target="_blank" rel="noopener">Apply</a></li>
    </ul>
    <p class="footer-copy">© 2026 Luca · Built by <a href="https://somehow-internet.vercel.app" target="_blank" rel="noopener">SOMEHOW</a></p>
  </div>
</footer>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="luca-mark" viewBox="0 0 318 348">
    <path d="M85 0H102V221A30 30 0 0 0 132 251H318V283A65 65 0 0 1 253 348H85A85 85 0 0 1 0 263V85A85 85 0 0 1 85 0Z"/>
    <rect x="152" y="118" width="86" height="86" rx="10"/>
  </symbol>
</svg>

<script src="/main.js" defer></script>
</body>
</html>
`;
}
