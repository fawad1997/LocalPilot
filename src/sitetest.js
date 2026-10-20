// Testing mode: test_website crawls a site (same origin, read-only) and reports bugs:
// JavaScript errors, failed requests, broken links and images, visible "undefined"/"NaN" text,
// unlabeled fields, missing alt text, mobile overflow, slow pages and more. Problem elements are
// outlined in red in the screenshots; the run is recorded as a GIF and written to a self-contained
// HTML report (Downloads/LocalPilot), which also opens in a tab.
// It never submits forms, types, or follows logout / delete / checkout links.
import * as cdp from './cdp.js';
import { startRecording, addFrame, buildGif, saveDownload, copyToRoot, safeFileName, stamp, toBase64 } from './recorder.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SKIP_LINK = /(log-?out|sign-?out|delete|remove|destroy|unsubscribe|deactivate|\/cart\/(add|remove)|add-to-cart|checkout|purchase|\/pay\b|\/order)/i;
const SKIP_FILE = /\.(pdf|zip|rar|7z|gz|jpe?g|png|gif|svg|webp|ico|mp4|mov|webm|mp3|wav|docx?|xlsx?|pptx?|exe|dmg|msi|apk|csv|json|xml|txt)(\?|$)/i;
const BENIGN_NET = /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_CACHE_MISS/;
const SLOW_MS = 3000;

export const ISSUE_HELP = {
  'http-error': ['Page returned an error status', 'The page itself answered with a 4xx/5xx status. Visitors see an error page.'],
  'js-exception': ['Uncaught JavaScript exception', 'Code crashed on this page. Features that depend on it may not work.'],
  'js-error': ['Console error', 'The page logged an error. Often a failed feature, a missing file or a bad API response.'],
  'failed-request': ['Failed request', 'A file or API call failed (4xx/5xx or network error). Something on the page may be missing or broken.'],
  'broken-link': ['Broken link', 'A link on this site leads to a page that does not exist or errors.'],
  'broken-external-link': ['Broken external link', 'A link to another site returns "not found". Update or remove it.'],
  'broken-image': ['Broken image', 'An image did not load. Check the file path or the server.'],
  'bug-text': ['"undefined" / "NaN" / template text on screen', 'Visible text such as "undefined", "NaN", "[object Object]" or "{{ name }}" usually means data did not load or a template bug.'],
  'placeholder-text': ['Placeholder text', '"Lorem ipsum" is still on the page.'],
  'mixed-content': ['Insecure (http) content on an https page', 'Browsers block or warn about it, and it can break the page.'],
  'mobile-overflow': ['Page is wider than a phone screen', 'At 390 px wide the page scrolls sideways. Something is too wide for mobile.'],
  'horizontal-overflow': ['Page scrolls sideways on desktop', 'Some element is wider than the window.'],
  'slow-page': ['Slow page', `The page took longer than ${SLOW_MS / 1000} s to load.`],
  'missing-alt': ['Image without alt text', 'Screen readers cannot describe it. Add alt="" for decorative images or a short description.'],
  'unlabeled-field': ['Form field without a label', 'Screen readers and autofill cannot tell what the field is for. Add a <label> or aria-label.'],
  'unnamed-button': ['Button without a name', 'An icon-only button with no text or aria-label is unusable with a screen reader.'],
  'empty-link': ['Link without text', 'A link with no text or label. Screen readers announce only "link".'],
  'duplicate-id': ['Duplicate id', 'The same id is used more than once, which breaks labels, anchors and scripts.'],
  'missing-title': ['Missing page title', 'The browser tab and search results show no title.'],
  'missing-h1': ['No main heading (h1)', 'Pages should have one h1 for structure and SEO.'],
  'multiple-h1': ['Several h1 headings', 'Usually one main heading per page is clearer.'],
  'missing-viewport': ['No mobile viewport tag', 'Without <meta name="viewport"> phones show a zoomed-out desktop page.'],
  'missing-lang': ['No page language', 'Add lang="en" (or the right language) to <html> for screen readers and translation.'],
};

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function normalizeLink(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

// "/shop/" and "/shop/index.html" are the same page.
export const pageKey = (url) => String(url).replace(/\/index\.html?(?=$|\?)/i, '/');

// Which discovered links the crawler may open: same origin, a page (not a file), and not an action.
export function crawlable(url, origin) {
  if (!url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.origin === origin && !SKIP_FILE.test(u.pathname) && !SKIP_LINK.test(u.pathname + u.search);
}

export function sortIssues(issues) {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.type.localeCompare(b.type));
}

// The page audit keeps at most 8 examples per type. Every example counts 1, and the first one also
// carries the ones that were not listed, so the counts per type add up to the real total.
export function exampleCounts(examples, totals) {
  const shown = {};
  for (const i of examples) shown[i.type] = (shown[i.type] || 0) + 1;
  const first = new Set();
  return examples.map((i) => {
    const isFirst = !first.has(i.type);
    first.add(i.type);
    return { ...i, count: isFirst ? 1 + Math.max(0, (totals[i.type] || 0) - shown[i.type]) : 1 };
  });
}

export function countBy(issues) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity] += i.count || 1;
  return out;
}

// --- in the page --------------------------------------------------------------------------

// Runs in the page (isolated world). Marks problem elements with data-lp-issue for the screenshot.
function auditPage() {
  const issues = [];
  const perType = {};
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const txt = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('src') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${txt ? ` "${txt}"` : ''}`;
  };
  const add = (severity, type, detail, el) => {
    perType[type] = (perType[type] || 0) + 1;
    if (el) el.setAttribute('data-lp-issue', type);
    if (perType[type] > 8) return; // keep the report readable; the count says how many
    issues.push({ severity, type, detail, element: el ? describe(el) : '' });
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';

  for (const img of document.images) {
    if (!visible(img)) continue;
    const src = img.currentSrc || img.src || '';
    if (img.complete && img.naturalWidth === 0 && src) add('error', 'broken-image', `Image did not load: ${src}`, img);
    else if (!img.hasAttribute('alt')) add('warning', 'missing-alt', `Image has no alt attribute: ${src.slice(0, 100)}`, img);
  }

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  // "undefined" / "NaN" as whole words, also next to symbols or digits ("€NaN", "undefined%").
  const bugRe = /(?<![A-Za-z])(undefined|NaN)(?![A-Za-z])|\[object Object\]|\{\{\s*[\w.$]+\s*\}\}|\$\{\s*[\w.]+\s*\}/;
  for (let n = walker.nextNode(), seen = 0; n && seen < 5000; n = walker.nextNode(), seen += 1) {
    const parent = n.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA|TEMPLATE)$/.test(parent.tagName) || !visible(parent)) continue;
    const t = n.textContent;
    const m = bugRe.exec(t);
    if (m) add('error', 'bug-text', `Visible "${m[0].trim()}" in: "${t.replace(/\s+/g, ' ').trim().slice(0, 80)}"`, parent);
    else if (/lorem ipsum/i.test(t)) add('warning', 'placeholder-text', `"${t.trim().slice(0, 60)}"`, parent);
  }

  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (/^(hidden|submit|button|image|reset)$/i.test(el.type) || !visible(el)) continue;
    const named = (el.labels && el.labels.length) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title;
    if (!named) add('warning', 'unlabeled-field', `${el.tagName.toLowerCase()} ${el.name ? `name="${el.name}"` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''} has no label`, el);
  }
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    if (!visible(el)) continue;
    const name = (el.innerText || '').trim() || el.getAttribute('aria-label') || el.title || el.querySelector('img[alt]')?.alt || el.querySelector('svg title')?.textContent;
    if (!name) add('warning', 'unnamed-button', 'Button has no text or aria-label', el);
  }

  const links = [];
  const seenLinks = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href').trim();
    if (visible(a)) {
      const name = (a.innerText || '').trim() || a.getAttribute('aria-label') || a.title || a.querySelector('img[alt]')?.alt;
      if (!name) add('warning', 'empty-link', `Link to ${raw.slice(0, 80)} has no text`, a);
    }
    if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    let url;
    try {
      url = new URL(raw, location.href);
    } catch {
      continue;
    }
    url.hash = '';
    if (!seenLinks.has(url.href)) {
      seenLinks.add(url.href);
      links.push({ url: url.href, text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    }
  }

  const ids = {};
  for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
  const dups = Object.entries(ids).filter(([, c]) => c > 1);
  if (dups.length) add('warning', 'duplicate-id', `${dups.length} duplicate id(s): ${dups.slice(0, 5).map(([id, c]) => `#${id} ×${c}`).join(', ')}`);

  if (!document.title.trim()) add('warning', 'missing-title', 'The page has no <title>');
  const h1 = [...document.querySelectorAll('h1')].filter(visible).length;
  if (!h1) add('warning', 'missing-h1', 'No visible <h1> heading');
  else if (h1 > 1) add('info', 'multiple-h1', `${h1} visible <h1> headings`);
  if (!document.querySelector('meta[name="viewport"]')) add('warning', 'missing-viewport', 'No <meta name="viewport"> tag');
  if (!document.documentElement.lang) add('info', 'missing-lang', 'No lang attribute on <html>');

  if (location.protocol === 'https:') {
    for (const el of document.querySelectorAll('img[src^="http:"], script[src^="http:"], iframe[src^="http:"], link[rel="stylesheet"][href^="http:"]')) {
      add('error', 'mixed-content', `Insecure resource: ${(el.getAttribute('src') || el.getAttribute('href')).slice(0, 100)}`, el);
    }
  }
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 2) add('warning', 'horizontal-overflow', `Page is ${de.scrollWidth}px wide in a ${de.clientWidth}px window`);

  const nav = performance.getEntriesByType('navigation')[0];
  return {
    url: location.href,
    title: document.title,
    issues,
    counts: perType,
    links,
    loadMs: nav ? Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.responseEnd) : null,
  };
}

function setHighlight(on) {
  const id = 'lp-test-highlight';
  document.getElementById(id)?.remove();
  if (on) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = '[data-lp-issue]{outline:3px solid #ef4444 !important;outline-offset:2px !important;box-shadow:0 0 0 6px rgba(239,68,68,.25) !important}';
    document.documentElement.appendChild(style);
  } else {
    for (const el of document.querySelectorAll('[data-lp-issue]')) el.removeAttribute('data-lp-issue');
  }
}

function mobileOverflow() {
  const de = document.documentElement;
  if (de.scrollWidth <= de.clientWidth + 2) return null;
  // The widest element that sticks out, to name in the report.
  let worst = null;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > de.clientWidth + 2 && r.width > 0 && (!worst || r.right > worst.right)) worst = { el, right: r.right };
  }
  if (worst) worst.el.setAttribute('data-lp-issue', 'mobile-overflow');
  const d = worst?.el;
  return { width: de.scrollWidth, viewport: de.clientWidth, element: d ? `<${d.tagName.toLowerCase()}${d.id ? `#${d.id}` : ''}${typeof d.className === 'string' && d.className.trim() ? `.${d.className.trim().split(/\s+/)[0]}` : ''}>` : '' };
}

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// --- link checks ---------------------------------------------------------------------------

async function fetchStatus(url) {
  const attempt = async (method) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, { method, redirect: 'follow', cache: 'no-store', signal: ctl.signal });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const head = await attempt('HEAD');
    return [405, 403, 501, 400].includes(head) ? await attempt('GET') : head;
  } catch (err) {
    return err.name === 'AbortError' ? 'timeout' : 'unreachable';
  }
}

export async function checkLinks(links, origin, limit, known = new Map()) {
  // Pages the crawler already opened keep their status (no second request).
  const todo = links.slice(0, limit);
  const results = [];
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const l = todo[i++];
      results.push({ ...l, status: known.get(l.url) ?? (await fetchStatus(l.url)) });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const issues = [];
  for (const r of results) {
    const internal = new URL(r.url).origin === origin;
    if (internal && (typeof r.status !== 'number' || r.status >= 400)) {
      issues.push({ severity: 'error', type: 'broken-link', page: r.from, detail: `${r.url} → ${r.status}${r.text ? ` (link text "${r.text}")` : ''}` });
    } else if (!internal && [404, 410].includes(r.status)) {
      issues.push({ severity: 'warning', type: 'broken-external-link', page: r.from, detail: `${r.url} → ${r.status}${r.text ? ` (link text "${r.text}")` : ''}` });
    }
  }
  return { checked: results, issues };
}

// --- the report ------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function reportHtml(r) {
  const c = countBy(r.issues);
  const byType = {};
  for (const i of r.issues) (byType[i.type] ||= { severity: i.severity, n: 0 }).n += i.count || 1;
  const typeRows = Object.entries(byType)
    .sort((a, b) => SEVERITY_ORDER[a[1].severity] - SEVERITY_ORDER[b[1].severity] || b[1].n - a[1].n)
    .map(([type, v]) => `<tr><td><span class="sev ${v.severity}">${v.severity}</span></td><td><b>${esc(ISSUE_HELP[type]?.[0] || type)}</b><div class="help">${esc(ISSUE_HELP[type]?.[1] || '')}</div></td><td class="n">${v.n}</td></tr>`)
    .join('');
  const pageBlocks = r.pages.map((p, n) => {
    const issues = sortIssues(r.issues.filter((i) => i.page === p.url));
    return `<section class="page"><h3>${n + 1}. ${esc(p.title || '(no title)')}</h3>
<p class="meta"><a href="${esc(p.url)}">${esc(p.url)}</a> · status ${esc(p.status ?? '?')} · ${p.loadMs != null ? `${(p.loadMs / 1000).toFixed(1)} s` : 'load time unknown'}</p>
${issues.length ? `<table><tr><th></th><th>Problem</th><th>Where</th></tr>${issues.map((i) => `<tr><td><span class="sev ${i.severity}">${i.severity}</span></td><td><b>${esc(ISSUE_HELP[i.type]?.[0] || i.type)}</b>${i.count > 1 ? ` <span class="help">(${i.count} on this page)</span>` : ''}<div class="detail">${esc(i.detail)}</div></td><td class="el">${esc(i.element || '')}</td></tr>`).join('')}</table>` : '<p class="ok">No problems found on this page.</p>'}
<div class="shots">${p.shot ? `<figure><img src="data:image/jpeg;base64,${p.shot}" alt="Desktop screenshot of ${esc(p.url)}"><figcaption>Desktop (problems outlined in red)</figcaption></figure>` : ''}${p.mobileShot ? `<figure class="mobile"><img src="data:image/jpeg;base64,${p.mobileShot}" alt="Mobile screenshot of ${esc(p.url)}"><figcaption>Phone, 390 px</figcaption></figure>` : ''}</div></section>`;
  }).join('\n');
  const linkRows = r.linkCheck.filter((l) => typeof l.status !== 'number' || l.status >= 400)
    .map((l) => `<tr><td>${esc(l.status)}</td><td><a href="${esc(l.url)}">${esc(l.url)}</a></td><td>${esc(l.text)}</td><td>${esc(l.from)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report: ${esc(r.origin)}</title>
<style>
:root{--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--err:#dc2626;--warn:#d97706;--info:#2563eb;--ok:#16a34a}
body{margin:0;font:15px/1.5 "Segoe UI",system-ui,-apple-system,Arial,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:26px}h2{margin:32px 0 12px;font-size:20px}h3{margin:0 0 4px}
.sub,.meta,.help{color:var(--muted)}.help{font-size:13px}.detail{font-size:13px;word-break:break-word}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.card b{display:block;font-size:28px}
.card.error b{color:var(--err)}.card.warning b{color:var(--warn)}.card.info b{color:var(--info)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:8px 0}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:13px;color:var(--muted)}
td.n{font-weight:700;text-align:right}td.el{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted);word-break:break-all}
.sev{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;color:#fff}.sev.error{background:var(--err)}.sev.warning{background:var(--warn)}.sev.info{background:var(--info)}
.page{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}.ok{color:var(--ok)}
.shots{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}figure{margin:0;flex:1 1 560px}figure.mobile{flex:0 1 220px}
figure img{width:100%;border:1px solid var(--line);border-radius:8px}figcaption{font-size:12px;color:var(--muted)}
.gif img{max-width:100%;border-radius:12px;border:1px solid var(--line)}
.note{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px 14px;font-size:14px}
</style></head><body><main>
<h1>Website test: ${esc(r.origin)}</h1>
<p class="sub">${esc(new Date(r.startedAt).toLocaleString())} · ${r.pages.length} page(s) · ${r.linkCheck.length} link(s) checked · ${(r.durationMs / 1000).toFixed(0)} s · LocalPilot ${esc(r.version)}</p>
<div class="cards"><div class="card error"><b>${c.error}</b>errors</div><div class="card warning"><b>${c.warning}</b>warnings</div><div class="card info"><b>${c.info}</b>notes</div><div class="card"><b>${r.pages.length}</b>pages tested</div></div>
<p class="note">Read-only test: LocalPilot opened pages and checked links, but did not fill or submit forms, and skipped links that look like logout, delete or checkout. Counts are capped at 8 examples per problem type on each page.</p>
<h2>Problems by type</h2>
${typeRows ? `<table><tr><th></th><th>Problem and what it means</th><th>Count</th></tr>${typeRows}</table>` : '<p class="ok">No problems found.</p>'}
${r.gif ? `<h2>Recording</h2><div class="gif"><img src="data:image/gif;base64,${r.gif}" alt="Animated recording of the test"></div>` : ''}
<h2>Pages</h2>
${pageBlocks}
${linkRows ? `<h2>Broken or unreachable links</h2><table><tr><th>Status</th><th>Link</th><th>Text</th><th>Found on</th></tr>${linkRows}</table>` : ''}
<script type="application/json" id="data">${JSON.stringify({ origin: r.origin, startedAt: r.startedAt, pages: r.pages.map(({ shot, mobileShot, ...p }) => p), issues: r.issues, linkCheck: r.linkCheck }).replace(/</g, '\\u003c')}</script>
</main></body></html>`;
}

// --- the tool ----------------------------------------------------------------------------------

export const TEST_WEBSITE_DEF = {
  name: 'test_website',
  description:
    'Testing mode: crawl a website read-only and report bugs: JavaScript errors and exceptions, failed requests, broken links and images, visible "undefined"/"NaN"/template text, ' +
    'unlabeled fields, missing alt text, buttons without names, duplicate ids, insecure content, pages too wide for phones, slow pages. ' +
    'Problems are outlined in red in screenshots; the run is recorded as an animated GIF and saved with an HTML report (Downloads/LocalPilot), which opens in a new tab. ' +
    'It never fills or submits forms and skips logout/delete/checkout links. Afterwards, explain the most important problems to the user in plain words.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Start page (default: the current tab).' },
      max_pages: { type: 'number', description: 'Pages to open on the same site (default 8, max 40).' },
      check_links: { type: 'number', description: 'How many links to check for broken targets (default 60, max 300, 0 = none).' },
      mobile: { type: 'boolean', description: 'Also check each page at phone width (default true).' },
      record_gif: { type: 'boolean', description: 'Record an animated GIF of the test (default true).' },
      open_report: { type: 'boolean', description: 'Open the report in a new tab when done (default true).' },
      save_to: { type: 'object', properties: { root: { type: 'string' }, path: { type: 'string' } }, required: ['root'], description: 'Also copy the report and GIF into a PC root folder (needs the PC bridge).' },
    },
  },
};

// helpers: { open(url) -> loads the url in ctx.tabId and waits, shot(opts) -> { data, cssW, cssH }, botCheck() -> note }
export async function testWebsite(ctx, input, helpers) {
  const { tabId } = ctx;
  const startUrl = normalizeLink(input.url || (await chrome.tabs.get(tabId)).url, 'https://example.invalid/');
  if (!startUrl) throw new Error('test_website needs an http(s) page. Open the site first or pass url.');
  const origin = new URL(startUrl).origin;
  const maxPages = Math.min(Math.max(Math.round(Number(input.max_pages) || 8), 1), 40);
  const linkLimit = input.check_links === 0 ? 0 : Math.min(Math.max(Math.round(Number(input.check_links) || 60), 1), 300);
  const mobile = input.mobile !== false;
  const status = (t) => ctx.emit?.({ type: 'status', text: t });
  const startedAt = Date.now();
  const rec = input.record_gif === false ? null : { title: `Testing ${origin}`, frames: [], startedAt };
  const state = await cdp.attach(tabId);

  const queue = [startUrl];
  const queued = new Set(queue.map(pageKey));
  const pages = [];
  const issues = [];
  const allLinks = new Map(); // url -> { url, text, from }
  const pageStatus = new Map();

  while (queue.length && pages.length < maxPages) {
    if (ctx.running === false) throw new Error('Stopped by the user.');
    const url = queue.shift();
    status(`Testing page ${pages.length + 1}/${maxPages}: ${url}`);
    const t0 = Date.now();
    await helpers.open(url);
    const note = await helpers.botCheck();
    if (/BOT CHECK DETECTED/.test(note)) {
      issues.push({ severity: 'info', type: 'bot-check', page: url, detail: 'A verification page appeared; testing stopped here.' });
      break;
    }
    await sleep(1200); // late errors and lazy requests
    const audit = await inPage(tabId, auditPage);
    if (!audit) continue;
    const page = { url: audit.url, title: audit.title, loadMs: audit.loadMs, status: null };
    const doc = [...state.network.values()].filter((n) => n.ts >= t0 && n.type === 'Document').at(-1);
    page.status = doc?.status ?? null;
    pageStatus.set(url, page.status);
    pageStatus.set(audit.url, page.status);
    const pageIssues = exampleCounts(audit.issues, audit.counts).map((i) => ({ ...i, page: audit.url }));
    if (page.status >= 400) pageIssues.unshift({ severity: 'error', type: 'http-error', page: audit.url, detail: `The page returned HTTP ${page.status}` });
    for (const c of state.console.filter((m) => m.ts >= t0 && ['error', 'exception', 'assert'].includes(m.level)).slice(0, 10)) {
      pageIssues.push({ severity: 'error', type: c.level === 'exception' ? 'js-exception' : 'js-error', page: audit.url, detail: c.text.slice(0, 300) });
    }
    for (const n of [...state.network.values()].filter((x) => x.ts >= t0 && x.type !== 'Document' && ((x.status ?? 0) >= 400 || (x.error && !BENIGN_NET.test(x.error)))).slice(0, 10)) {
      pageIssues.push({ severity: 'error', type: 'failed-request', page: audit.url, detail: `${n.method} ${n.url.slice(0, 200)} → ${n.status ?? n.error}` });
    }
    if (audit.loadMs > SLOW_MS) pageIssues.push({ severity: 'warning', type: 'slow-page', page: audit.url, detail: `Loaded in ${(audit.loadMs / 1000).toFixed(1)} s` });

    await inPage(tabId, setHighlight, [true]);
    const desk = await helpers.shot({ fullPage: false });
    const full = await helpers.shot({ fullPage: true, maxHeight: 4000 });
    page.shot = full.data;
    if (rec) addFrame(rec, { jpeg: desk.data, cssW: desk.cssW, cssH: desk.cssH, action: `Page ${pages.length + 1}: ${audit.title || audit.url}`, note: `${pageIssues.filter((i) => i.severity === 'error').length} errors, ${pageIssues.filter((i) => i.severity === 'warning').length} warnings · ${audit.url}`, url: audit.url, delayMs: 2200 });
    await inPage(tabId, setHighlight, [false]);

    if (mobile) {
      await cdp.send(tabId, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      try {
        await sleep(700);
        const over = await inPage(tabId, mobileOverflow);
        if (over) pageIssues.push({ severity: 'warning', type: 'mobile-overflow', page: audit.url, detail: `At ${over.viewport}px wide the page is ${over.width}px wide`, element: over.element });
        await inPage(tabId, setHighlight, [true]);
        const mob = await helpers.shot({ fullPage: false });
        page.mobileShot = mob.data;
        if (rec) addFrame(rec, { jpeg: mob.data, cssW: mob.cssW, cssH: mob.cssH, action: `Page ${pages.length + 1} on a phone (390 px)`, note: over ? `Too wide: ${over.width}px ${over.element}` : 'Fits the screen', url: audit.url, delayMs: 1600, phone: true });
        await inPage(tabId, setHighlight, [false]);
      } finally {
        await cdp.send(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
    }
    // Phone-sized desktop "overflow" findings are noise once the phone check ran.
    issues.push(...pageIssues);
    pages.push(page);

    for (const l of audit.links) {
      if (!allLinks.has(l.url)) allLinks.set(l.url, { ...l, from: audit.url });
      if (crawlable(l.url, origin) && !queued.has(pageKey(l.url))) {
        queued.add(pageKey(l.url));
        queue.push(l.url);
      }
    }
  }

  let linkCheck = [];
  if (linkLimit) {
    status(`Checking up to ${linkLimit} links…`);
    const links = [...allLinks.values()].filter((l) => !SKIP_LINK.test(l.url));
    const res = await checkLinks(links, origin, linkLimit, pageStatus);
    linkCheck = res.checked;
    issues.push(...res.issues);
  }

  const report = { origin, startedAt, durationMs: Date.now() - startedAt, pages, issues: sortIssues(issues), linkCheck, version: chrome.runtime.getManifest().version };
  const name = `test-${safeFileName(new URL(origin).host)}-${stamp(new Date(startedAt))}`;
  let gifPath = null;
  if (rec?.frames.length) {
    status('Making the GIF…');
    const gif = await buildGif(rec, { width: 800 });
    report.gif = toBase64(gif);
    gifPath = (await saveDownload(gif, `${name}.gif`, 'image/gif')).path;
  }
  const html = reportHtml(report);
  const saved = await saveDownload(html, `${name}.html`, 'text/html');
  const copies = [];
  if (input.save_to?.root) {
    copies.push(await copyToRoot(ctx, saved.path, input.save_to, `${name}.html`));
    if (gifPath) copies.push(await copyToRoot(ctx, gifPath, input.save_to, `${name}.gif`));
  }
  if (input.open_report !== false && !ctx.mcp && html.length < 9 * 1024 * 1024) {
    await chrome.storage.local.set({ lastTestReport: { html, path: saved.path, at: Date.now() } });
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/report.html'), windowId: tab.windowId, index: tab.index + 1, active: false });
  }

  const c = countBy(report.issues);
  const top = report.issues.slice(0, 30).map((i) => `- [${i.severity}] ${ISSUE_HELP[i.type]?.[0] || i.type}${i.count > 1 ? ` (×${i.count})` : ''}: ${i.detail}${i.element ? ` ${i.element}` : ''} — ${i.page}`);
  return {
    report,
    text: [
      `Tested ${pages.length} page(s) on ${origin} in ${(report.durationMs / 1000).toFixed(0)} s and checked ${linkCheck.length} link(s): ${c.error} error(s), ${c.warning} warning(s), ${c.info} note(s).`,
      ...(top.length ? ['Problems (most serious first):', ...top] : ['No problems found.']),
      ...(report.issues.length > 30 ? [`…and ${report.issues.length - 30} more in the report.`] : []),
      `Report: ${saved.path}${gifPath ? `\nGIF: ${gifPath}` : ''}${copies.length ? `\nCopied to: ${copies.join(', ')}` : ''}`,
      input.open_report !== false && !ctx.mcp ? 'The report is open in a new tab.' : '',
    ].filter(Boolean).join('\n'),
  };
}
