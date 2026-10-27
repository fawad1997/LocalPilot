// Market-news headlines -> a research CSV for Quantara (D:\AI\Trading), tagged by symbol:
//   datasets/news_<YYYY-MM-DD>.csv   published_utc, source, symbol_tags, headline, url, summary
// Research only: it records what was published and when, for later comparison with trades.
// It never gates, suggests or places a trade.
// Sources: RSS/Atom feeds fetched directly (no tab), and optionally news-list pages read in the tab.
import * as pc from '../pcbridge.js';
import { jitter, openUrl, guardPage, requireRoot } from './common.js';
import { handleBotCheck } from '../botcheck.js';
import { log } from '../logger.js';

// Checked on 2026-10-20: each returned a valid feed with items.
export const DEFAULT_FEEDS = [
  'https://www.federalreserve.gov/feeds/press_all.xml',
  'https://www.ecb.europa.eu/rss/press.html',
  'https://www.fxstreet.com/rss/news',
  'https://www.investing.com/rss/news_1.rss',
];

export const DEFAULT_KEYWORDS = {
  XAUUSD: ['gold', 'xau', 'bullion', 'precious metals'],
  XAGUSD: ['silver', 'xag'],
  USD: ['fed', 'fomc', 'powell', 'dollar', 'usd', 'cpi', 'inflation', 'payrolls', 'nfp', 'jobs report', 'treasury', 'treasuries', 'yields'],
  EURUSD: ['eur/usd', 'eurusd', 'euro', 'ecb', 'lagarde'],
  GBPUSD: ['gbp/usd', 'gbpusd', 'pound', 'sterling', 'boe', 'bank of england'],
  USDJPY: ['usd/jpy', 'usdjpy', 'yen', 'boj', 'bank of japan'],
  BTCUSD: ['bitcoin', 'btc', 'crypto'],
  USOIL: ['oil', 'crude', 'wti', 'brent', 'opec'],
};

export const NEWS_COLUMNS = ['published_utc', 'source', 'symbol_tags', 'headline', 'url', 'summary'];

// --- parsing (regex: DOMParser does not exist in a service worker) ------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function cleanText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : '';
}

// RFC 822 / ISO dates; "2026-10-19 20:51:26" without a zone is taken as UTC.
export function parseFeedDate(s) {
  let t = cleanText(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(t)) t = `${t.replace(' ', 'T')}Z`;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

export function parseFeed(xml, source) {
  const text = String(xml || '');
  const blocks = text.match(/<item\b[\s\S]*?<\/item>/gi) || text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let link = cleanText(tag(b, 'link'));
    if (!link) link = /<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1] || '';
    if (!/^https?:/i.test(link)) link = cleanText(tag(b, 'guid'));
    return {
      published: parseFeedDate(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
      source,
      headline: cleanText(tag(b, 'title')),
      url: /^https?:/i.test(link) ? link : '',
      summary: cleanText(tag(b, 'description') || tag(b, 'summary')).slice(0, 300),
    };
  }).filter((it) => it.headline);
}

// "XAUUSDm" (broker suffix) -> "XAUUSD"
export const baseSymbol = (s) => String(s || '').trim().replace(/[a-z.]+$/, '').toUpperCase();

function keywordRegex(words) {
  const alts = words.map((w) => String(w).trim().toLowerCase()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return alts.length ? new RegExp(`(^|[^a-z0-9])(${alts.join('|')})(?=$|[^a-z0-9])`, 'i') : null;
}

// Which of `symbols` a headline is about, from the keyword lists.
export function tagItem(item, symbols, keywords = DEFAULT_KEYWORDS) {
  const hay = `${item.headline} ${item.summary || ''}`;
  return symbols.filter((sym) => {
    const re = keywordRegex(keywords[sym] || [sym.toLowerCase()]);
    return re ? re.test(hay) : false;
  });
}

// Minimal CSV reader for the file this recipe wrote earlier today (quoted cells, "" escapes).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
}

const formatUtc = (t) => (t == null ? '' : new Date(t).toISOString().slice(0, 16).replace('T', ' '));

// --- sources -----------------------------------------------------------------------------

async function fetchFeed(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// A news-list page in the tab, read with the same list detection as extract_list.
async function readListPage(ctx, url) {
  await openUrl(ctx, url);
  await guardPage(ctx, new URL(url).hostname, { loginText: '(?!)', loginUrl: '^/login' }, new URL(url).hostname);
  const bot = await handleBotCheck(ctx, 'news_collect');
  if (/BOT CHECK DETECTED/.test(bot)) throw new Error(bot.trim());
  await chrome.scripting.executeScript({ target: { tabId: ctx.tabId }, files: ['src/content/page-agent.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: ctx.tabId },
    func: () => {
      const [list] = window.__lpAgent.detectLists(1);
      return list ? window.__lpAgent.extractList(list.selector, null, 100) : [];
    },
  });
  return (res?.result || []).map((r) => ({ published: null, source: new URL(url).hostname, headline: r.title, url: r.link || '', summary: '' })).filter((r) => r.headline);
}

// --- the recipe ------------------------------------------------------------------------------

async function run(ctx, input) {
  const { root } = requireRoot(ctx, 'trading', '{"name": "trading", "path": "<your Quantara research folder>", "writable": true}');
  const symbols = [...new Set((input.symbols?.length ? input.symbols : ['XAUUSD', 'USD']).map(baseSymbol).filter(Boolean))];
  const keywords = { ...DEFAULT_KEYWORDS, ...Object.fromEntries(Object.entries(input.keywords || {}).map(([k, v]) => [baseSymbol(k), Array.isArray(v) ? v : String(v).split(',')])) };
  const hours = Math.min(Math.max(Number(input.hours) || 24, 1), 24 * 14);
  const since = Date.now() - hours * 3600000;
  const configured = String(ctx.settings.newsFeeds || '').split(/[\s,]+/).filter((u) => /^https?:\/\//i.test(u));
  const feeds = input.feeds?.length ? input.feeds : configured.length ? configured : DEFAULT_FEEDS;
  const status = (t) => ctx.emit?.({ type: 'status', text: t });
  const items = [];
  const notes = [];

  for (const [i, url] of feeds.entries()) {
    status(`News feed ${i + 1}/${feeds.length}…`);
    try {
      const got = parseFeed(await fetchFeed(url), new URL(url).hostname);
      if (!got.length) notes.push(`${url}: no items`);
      items.push(...got);
    } catch (err) {
      notes.push(`${url}: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    }
  }
  for (const [i, url] of (input.pages || []).entries()) {
    status(`News page ${i + 1}/${input.pages.length}…`);
    try {
      items.push(...(await readListPage(ctx, url)));
    } catch (err) {
      notes.push(`${url}: ${err.message}`);
    }
    if (i < input.pages.length - 1) await jitter(ctx, 2, 4);
  }
  if (!items.length) throw new Error(`No headlines could be read (${notes.join('; ') || 'no sources'}). Nothing was written; do not write headlines by hand.`);

  const fresh = items.filter((it) => it.published == null || it.published >= since);
  const tagged = fresh.map((it) => ({ ...it, tags: tagItem(it, symbols, keywords) })).filter((it) => input.all || it.tags.length);
  const date = new Date().toISOString().slice(0, 10);
  const path = `datasets/news_${date}.csv`;
  let existing = [];
  try {
    existing = parseCsv((await pc.call('read_file', { root, path, maxBytes: 1000000 })).content);
  } catch {
    // first run today
  }
  const seen = new Set(existing.map((r) => r.url || r.headline));
  const added = [];
  for (const it of tagged.sort((a, b) => (a.published ?? 0) - (b.published ?? 0))) {
    const key = it.url || it.headline;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ published_utc: formatUtc(it.published), source: it.source, symbol_tags: it.tags.join(' '), headline: it.headline, url: it.url, summary: it.summary });
  }
  const rows = [...existing, ...added];
  const res = await pc.call('write_csv', { root, path, columns: NEWS_COLUMNS, rows, overwrite: true, bom: false });
  log('recipe_progress', { runId: ctx.runId, recipe: 'news_collect', read: items.length, added: added.length });
  const sample = added.slice(-5).map((r) => `- ${r.published_utc || 'time unknown'} [${r.symbol_tags || '-'}] ${r.headline} (${r.source})`);
  return [{
    type: 'text',
    text: [
      `Read ${items.length} headlines from ${feeds.length} feed(s)${input.pages?.length ? ` and ${input.pages.length} page(s)` : ''}; ${fresh.length} from the last ${hours} h, ${tagged.length} about ${symbols.join(', ')}${input.all ? ' or kept with all: true' : ''}.`,
      `Added ${added.length} new row(s) to ${res.path} (${rows.length} today in total).`,
      ...(sample.length ? ['Latest added:', ...sample] : []),
      ...(notes.length ? [`Notes: ${notes.join(' | ')}`] : []),
      'Research data only: report what was published; do not turn it into trading advice.',
    ].join('\n'),
  }];
}

export default {
  definition: {
    name: 'news_collect',
    description:
      'Collect recent market-news headlines (Fed, ECB, FXStreet, Investing.com feeds by default) tagged by symbol (XAUUSD, USD, EURUSD…), and add the new ones to datasets/news_<date>.csv in the PC root "trading" for Quantara research. ' +
      'Research only: it never gates or suggests trades. Optional `pages` reads news-list pages in this tab.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: `Default ["XAUUSD", "USD"]. Known: ${Object.keys(DEFAULT_KEYWORDS).join(', ')}; broker suffixes like XAUUSDm are fine.` },
        hours: { type: 'number', description: 'Only headlines from the last N hours (default 24, max 336).' },
        keywords: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Extra or replacement keyword lists per symbol, e.g. {"XAUUSD": ["gold", "bullion"]}' },
        feeds: { type: 'array', items: { type: 'string' }, description: 'RSS/Atom URLs instead of the configured ones.' },
        pages: { type: 'array', items: { type: 'string' }, description: 'Optional news-list page URLs to read in this tab (headline + link; no time).' },
        all: { type: 'boolean', description: 'Keep headlines that match no symbol too.' },
      },
      required: ['symbols'],
    },
  },
  domains: [],
  approval: async (ctx, input) => (input.pages?.length ? `${[...new Set(input.pages.map((u) => { try { return new URL(u).hostname; } catch { return u; } }))].join(', ')} + PC files (trading)` : 'PC files (trading)'),
  promptHint: 'For market-news headlines about Quantara\'s symbols (research data), use news_collect. It records headlines; it never trades or advises.',
  run,
};
