// web_search: results from a search engine as a clean list (title, link, snippet), read in a
// background tab of the user's own browser (their cookies and consent choices apply), which is
// closed afterwards. If an engine fails or shows a bot check, the next one is tried.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ type: 'text', text: t });

export const SEARCH_ENGINES = {
  duckduckgo: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  // form=QBLH is what Bing's own search box sends; without it a fresh browser gets results for the first word only.
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`,
};

// What the user approves in "ask" modes: one entry covers every engine.
export const SEARCH_APPROVAL = 'web search';

export const WEB_SEARCH_DEF = {
  name: 'web_search',
  description:
    'Search the web and get a list of results (title, link, snippet). Use it instead of opening search-engine pages, and instead of guessing URLs. ' +
    'Then open a result with navigate. Tips: add site:example.com to search one site, put exact names in quotes.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      engine: { type: 'string', enum: Object.keys(SEARCH_ENGINES), description: 'Default: the one chosen in Settings (DuckDuckGo).' },
      max_results: { type: 'number', description: 'Default 8, at most 20.' },
    },
    required: ['query'],
  },
};

// Engines to try, in order: the requested (or configured) one first, then the others.
// settings.searchUrl ("https://example/search?q={q}") replaces the built-in list.
export function searchPlan(settings, query, engine) {
  if (settings.searchUrl && settings.searchUrl.includes('{q}')) {
    return [{ name: 'custom', url: settings.searchUrl.replace('{q}', encodeURIComponent(query)) }];
  }
  const first = SEARCH_ENGINES[engine] ? engine : SEARCH_ENGINES[settings.searchEngine] ? settings.searchEngine : 'duckduckgo';
  return [first, ...Object.keys(SEARCH_ENGINES).filter((e) => e !== first)].map((name) => ({ name, url: SEARCH_ENGINES[name](query) }));
}

// Runs in the results page. Knows DuckDuckGo (html), Bing and Google markup, then falls back
// to "links that contain a heading", which most result pages use.
const EXTRACT_RESULTS = (max) => {
  const out = [];
  const seen = new Set();
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const realUrl = (href) => {
    try {
      const u = new URL(href, location.href);
      if (/duckduckgo\.com$/.test(u.hostname) && u.pathname.startsWith('/l/')) return u.searchParams.get('uddg');
      if (u.pathname === '/url' && /^https?:/.test(u.searchParams.get('q') || u.searchParams.get('url') || '')) return u.searchParams.get('q') || u.searchParams.get('url'); // Google
      if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/a')) {
        const enc = u.searchParams.get('u') || '';
        if (enc.startsWith('a1')) return atob(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
      }
      return u.href;
    } catch {
      return null;
    }
  };
  // site: for results whose link is the engine's own redirect (Google's /goto?url=<token>), the
  // address the engine prints under the title; the redirect link itself still opens the page.
  const add = (a, titleEl, snippet, site = null) => {
    const url = a && realUrl(a.getAttribute('href'));
    if (!url || !/^https?:/.test(url) || seen.has(url)) return;
    let engineLink;
    try {
      engineLink = new URL(url).hostname === location.hostname;
    } catch {
      return;
    }
    if (engineLink && !site) return; // the engine's own pages (next page, settings…)
    seen.add(url);
    const title = clean(titleEl?.textContent || a.textContent).slice(0, 150);
    out.push({ title, url, snippet: clean(snippet).replace(title, '').trim().slice(0, 300), ...(engineLink ? { site: clean(site) } : {}) });
  };
  for (const r of document.querySelectorAll('.result:not(.result--ad)')) {
    const a = r.querySelector('a.result__a');
    if (a) add(a, a, r.querySelector('.result__snippet')?.textContent);
  }
  for (const r of document.querySelectorAll('#b_results > li.b_algo')) {
    const a = r.querySelector('h2 a');
    if (a) add(a, a, r.querySelector('.b_caption p, p')?.textContent);
  }
  for (const h of document.querySelectorAll('#search a h3, #rso a h3')) {
    const a = h.closest('a');
    const box = a.closest('div.g, div[data-snc], div[data-hveid]');
    const cites = [...a.querySelectorAll('cite'), ...(box?.querySelectorAll('cite') || [])].map((c) => c.textContent);
    const site = cites.find((t) => /[a-z0-9-]+\.[a-z]{2,}/i.test(t)) || null; // the address, not "2.4K+ followers"
    add(a, h, box ? box.innerText.split('\n').filter((l) => l.length > 40).join(' ') : '', site);
  }
  if (!out.length) {
    for (const h of document.querySelectorAll('a h2, a h3')) {
      const a = h.closest('a');
      add(a, h, a.parentElement?.parentElement?.innerText || '');
    }
  }
  const head = document.body?.innerText.slice(0, 3000) || '';
  const blocked = /unusual traffic|captcha|are you a robot|not a robot|anomaly|made by a human|bots use duckduckgo/i.test(head);
  return { results: out.slice(0, max), blocked: !out.length && blocked, page: `"${document.title.slice(0, 80)}" ${location.href.slice(0, 120)}` };
};

const SEARCH_WAIT_MS = 12000;

// Results pages can take seconds to appear (Google redirects google.com -> google.com.hk first)
// and keep rendering after "load". So: read the page every 700 ms once the new address has
// committed, until there are results, a bot check, or the page is fully loaded and still empty.
async function searchIn(tabId, url, max) {
  await chrome.tabs.update(tabId, { url });
  const deadline = Date.now() + SEARCH_WAIT_MS;
  let last = { results: [], failed: 'the page did not load in time' };
  let emptyAfterLoad = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { results: [], failed: 'the search tab was closed' };
    if (tab.pendingUrl || tab.url === 'about:blank') continue; // still on the way
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: EXTRACT_RESULTS, args: [max] });
      if (!res?.result) continue;
      last = res.result;
      if (last.results.length || last.blocked) return last;
      if (tab.status === 'complete' && ++emptyAfterLoad >= 2) return last;
    } catch (err) {
      if (/error page/.test(err.message)) return { results: [], failed: 'the page did not load' };
    }
  }
  return last;
}

export async function webSearch(ctx, input) {
  const query = String(input.query || '').trim();
  if (!query) throw new Error('web_search needs a query.');
  const max = Math.min(Math.max(Math.round(Number(input.max_results) || 8), 1), 20);
  const windowId = ctx.windowId ?? (await chrome.tabs.get(ctx.tabId).catch(() => null))?.windowId;
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false, ...(windowId ? { windowId } : {}) });
  const problems = [];
  try {
    for (const engine of searchPlan(ctx.settings, query, input.engine)) {
      const res = await searchIn(tab.id, engine.url, max);
      if (res.results.length) {
        const where = (r) => (r.site ? `${r.site}\n   (link through ${engine.name}: ${r.url})` : r.url);
        const lines = res.results.map((r, i) => `${i + 1}. ${r.title || '(no title)'}\n   ${where(r)}${r.snippet ? `\n   ${r.snippet}` : ''}`);
        const tried = problems.length ? `\n(${problems.join('; ')})` : '';
        return [text(`Web results for "${query}" (${engine.name}):${tried}\n${lines.join('\n')}\nOpen one with navigate.`)];
      }
      problems.push(`${engine.name}: ${res.failed || (res.blocked ? 'showed a bot check' : 'no results')}${res.page ? ` on ${res.page}` : ''}`);
    }
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  return [text(`No web results for "${query}" (${problems.join('; ')}). Try other words, or fewer of them.`)];
}
