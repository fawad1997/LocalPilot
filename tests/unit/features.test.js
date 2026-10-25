import { test } from 'node:test';
import assert from 'node:assert/strict';

// Modules register chrome.* listeners at load (via cdp.js): stub them, with a working storage.local.
const store = {};
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => Promise.resolve({}) });
globalThis.chrome = new Proxy({}, {
  get: (t, k) => (k === 'storage'
    ? new Proxy({ local: { get: async (key) => ({ [key]: store[key] }), set: async (obj) => Object.assign(store, obj) } }, { get: (s, key) => s[key] ?? stub })
    : stub),
});
const q = await import('../../src/quantara.js');
const tasks = await import('../../src/tasks.js');
const ff = await import('../../src/recipes/forexfactory.js');
const news = await import('../../src/recipes/news.js');
const notes = await import('../../src/sitenotes.js');
const { mergeRows, listColumns } = await import('../../src/tools.js');

// --- Quantara -------------------------------------------------------------------------

test('quantara: localhost only, tools only when enabled, halt only with a token', () => {
  assert.equal(q.quantaraBaseUrl({ quantaraUrl: 'http://127.0.0.1:8787/x' }), 'http://127.0.0.1:8787');
  assert.equal(q.quantaraBaseUrl({ quantaraUrl: 'http://localhost:9000' }), 'http://localhost:9000');
  assert.throws(() => q.quantaraBaseUrl({ quantaraUrl: 'http://192.168.1.5:8787' }), /must be on this PC/);
  assert.throws(() => q.quantaraBaseUrl({ quantaraUrl: 'file:///C:/x' }), /must be on this PC/);
  assert.deepEqual(q.quantaraToolDefinitions({ quantaraEnabled: false }), []);
  const names = (s) => q.quantaraToolDefinitions(s).map((d) => d.name);
  assert.deepEqual(names({ quantaraEnabled: true }), ['quantara_status', 'quantara_trades', 'quantara_analysis', 'quantara_research']);
  assert.ok(names({ quantaraEnabled: true, quantaraToken: 't' }).includes('quantara_halt'));
  assert.deepEqual(q.ALWAYS_ASK_TOOLS, ['quantara_halt']);
  assert.deepEqual(q.quantaraPromptLines({ quantaraEnabled: false }), []);
  assert.ok(q.quantaraPromptLines({ quantaraEnabled: true }).some((l) => /fewer than 30 trades/.test(l)));
});

test('quantara: glossary labels and trimmed state without account identifiers', () => {
  const g = q.parseGlossary('const GLOSSARY = {\n  SYSTEM_READY:   {say: "Ready and watching", tone: "good"},\n  X_Y: {say: "Say \\"hi\\"", mean: "m"},\n};');
  assert.deepEqual(g, { SYSTEM_READY: 'Ready and watching', X_Y: 'Say "hi"' });
  assert.equal(q.humanise('SPREAD_TOO_LARGE'), 'Spread too large');
  const s = q.summarizeState({
    system_status: 'HALTED', status_reasons: [{ code: 'SYSTEM_READY', message: 'm' }], account: { login: 123456, server: 'srv', equity: 10.123456, currency: 'USD' },
    risk: { state: 'REDUCED', multiplier: 0.5 }, positions: [{ symbol: 'XAUUSDm', side: 'SELL', sl: 1, tp: 2, floating_pnl: -1 }],
    symbols: ['A', 'B', 'C'], symbol_trading: { B: { enabled: false, reason: 'r' } }, market: { regime_detail: { big: 1 } }, microstructure: { A: 1 },
  }, g);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('123456') && !json.includes('srv') && !json.includes('microstructure') && !json.includes('regime_detail'));
  assert.equal(s.why[0].says, 'Ready and watching');
  assert.equal(s.system_status_says, 'Halted');
  assert.equal(s.account.equity, 10.1235);
  assert.equal(s.symbols_running, 2);
  assert.deepEqual(s.open_positions[0], { symbol: 'XAUUSDm', side: 'SELL', stop: 1, target: 2, floating_pnl: -1 });
  const c = q.compact({ a: Array.from({ length: 20 }, (_, i) => i), id: 'x', signal: {} }, 0, 5);
  assert.deepEqual(c, { a: [0, 1, 2, 3, 4, '… 15 more'] });
});

// --- schedules ---------------------------------------------------------------------------

test('schedules: legacy daily, weekdays, intervals, validation', () => {
  assert.deepEqual(tasks.normalizeSchedule({ daily: '07:30' }), { kind: 'daily', time: '07:30' });
  assert.equal(tasks.normalizeSchedule({ schedule: { kind: 'off' } }), null);
  assert.deepEqual(tasks.normalizeSchedule({ schedule: { kind: 'interval', minutes: '30' } }), { kind: 'interval', minutes: 30 });
  assert.throws(() => tasks.normalizeSchedule({ schedule: { kind: 'interval', minutes: 5 } }), /every 15 minutes/);
  assert.throws(() => tasks.normalizeSchedule({ schedule: { kind: 'weekdays', time: '25:00' } }), /HH:MM/);
  assert.deepEqual(tasks.migrate({ id: 'a', daily: '08:00' }).schedule, { kind: 'daily', time: '08:00' });
  assert.equal(tasks.migrate({ id: 'a', daily: '' }).schedule, null);
  assert.equal(tasks.describeSchedule({ kind: 'interval', minutes: 120 }), 'every 2 h');
  assert.equal(tasks.describeSchedule({ kind: 'weekdays', time: '07:45' }), 'weekdays 07:45');
  // Friday 2026-10-23 09:00 local -> weekday 07:45 runs next on Monday the 26th.
  const fri = new Date(2026, 9, 23, 9, 0);
  const next = new Date(tasks.nextRun({ kind: 'weekdays', time: '07:45' }, fri));
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [26, 7, 45]);
  assert.equal(tasks.nextRun({ kind: 'interval', minutes: 15 }, fri), fri.getTime() + 15 * 60000);
  assert.equal(tasks.isDue({ kind: 'weekdays', time: '07:45' }, new Date(2026, 9, 24)), false);
  assert.equal(tasks.isDue({ kind: 'daily', time: '07:45' }, new Date(2026, 9, 24)), true);
});

test('schedules: change detection and notify modes', () => {
  assert.equal(tasks.hashText('a  b\n c'), tasks.hashText('a b c'));
  assert.notEqual(tasks.hashText('price 1'), tasks.hashText('price 2'));
  assert.deepEqual(tasks.newLines('Price: 100\nFooter', 'Price: 250\nFooter\nNew line'), ['Price: 250', 'New line']);
  const run = (text, ok = true) => ({ ok, text, hash: tasks.hashText(text) });
  assert.equal(tasks.shouldNotify({ notifyOn: 'change' }, run('a'), null), true);
  assert.equal(tasks.shouldNotify({ notifyOn: 'change' }, run('a'), run('a')), false);
  assert.equal(tasks.shouldNotify({ notifyOn: 'change' }, run('a', false), run('a')), true, 'failures always notify');
  assert.equal(tasks.shouldNotify({ notifyOn: 'keyword', keyword: 'Halted' }, run('bot halted'), run('ok')), true);
  assert.equal(tasks.shouldNotify({ notifyOn: 'keyword', keyword: 'Halted' }, run('bot halted'), run('bot halted')), false);
  assert.equal(tasks.shouldNotify({ notifyOn: 'keyword', keyword: 'x' }, run('nothing'), null), false);
  assert.equal(tasks.shouldNotify({}, run('a'), run('a')), true);
});

// --- economic calendar -------------------------------------------------------------------

test('calendar: weeks, New York times across DST, table offset inference, self-check', () => {
  const weeks = ff.weekStarts(ff.parseDay('2026-12-30'), ff.parseDay('2027-01-05'));
  assert.deepEqual(weeks.map(ff.weekParam), ['dec27.2026', 'jan3.2027']);
  assert.throws(() => ff.weekStarts(ff.parseDay('2024-01-01'), ff.parseDay('2026-06-01')), /at most two years/);
  assert.throws(() => ff.parseDay('2026-02-30'), /not a real date/);
  assert.equal(ff.formatUtc(ff.nyToUtc(ff.parseDay('2026-07-02'), 8, 30)), '2026-07-02 12:30');
  assert.equal(ff.formatUtc(ff.nyToUtc(ff.parseDay('2026-12-04'), 8, 30)), '2026-12-04 13:30');
  assert.equal(ff.formatUtc(ff.nyToUtc(ff.parseDay('2026-03-18'), 14, 0)), '2026-03-18 18:00', 'after the US DST switch (8 Mar 2026)');
  assert.deepEqual(ff.parseClock('12:15am'), { h: 0, m: 15 });
  assert.deepEqual(ff.parseClock('1:05pm'), { h: 13, m: 5 });
  assert.equal(ff.parseClock('Tentative'), null);
  assert.equal(ff.dayFromLabel('Fri Jan 1', ff.parseDay('2026-12-27')), Date.UTC(2027, 0, 1));
  assert.equal(ff.normImpact('icon icon--ff-impact-ora'), 'MEDIUM');
  // A table shown in Tokyo time (UTC+9): NFP 8:30 New York (EST) = 13:30 UTC = 22:30 local.
  const rows = [
    { dateLabel: 'Fri Dec 4', timeLabel: '10:30pm', currency: 'USD', impact: 'icon--ff-impact-red', title: 'Non-Farm Employment Change' },
    { timeLabel: '', currency: 'USD', impact: 'icon--ff-impact-red', title: 'Average Hourly Earnings m/m' },
    { dateLabel: 'Sat Dec 5', timeLabel: 'All Day', currency: 'JPY', impact: 'icon--ff-impact-gra', title: 'Holiday' },
  ];
  const ev = ff.fromDom(rows, ff.parseDay('2026-11-29'), 'nov29.2026');
  assert.equal(ff.inferOffset(ev), 540);
  for (const e of ev) if (e.local != null) e.utc = e.local - 540 * 60000;
  assert.deepEqual(ff.selfCheck(ev), { checked: 2, wrong: [] });
  assert.deepEqual(ff.toImportRows(ev).map((r) => r.datetime_utc), ['2026-12-04 13:30', '2026-12-04 13:30']);
  assert.equal(ff.toDetailedRows(ev).at(-1).flags, 'All Day');
  const bad = ff.fromState([{ name: 'FOMC Statement', currency: 'USD', impactName: 'high', dateline: Date.UTC(2026, 6, 29, 19, 0) / 1000, timeLabel: '3:00pm' }], 'w');
  assert.equal(ff.selfCheck(bad).wrong.length, 1);
  const filt = { fromMs: ff.parseDay('2026-12-01'), toMs: ff.parseDay('2026-12-04'), currencies: ['USD'], impacts: ['HIGH'] };
  assert.equal(ff.keep(ev[0], filt), true);
  assert.equal(ff.keep({ ...ev[0], utc: Date.UTC(2026, 11, 5, 0, 0) }, filt), false, 'the day after "to" is out');
});

// --- news ----------------------------------------------------------------------------------

test('news: RSS and Atom parsing, zone-less dates, tags with word boundaries, CSV reader', () => {
  const rss = '<rss><channel><item><title><![CDATA[Gold &amp; silver rally]]></title><link>https://n.test/1</link><pubDate>Tue, 20 Oct 2026 04:16:42 GMT</pubDate><description><![CDATA[<p>Bullion up</p>]]></description></item>'
    + '<item><title>No link</title><guid>abc</guid><pubDate>2026-10-19 20:51:26</pubDate></item></channel></rss>';
  const items = news.parseFeed(rss, 'n.test');
  assert.deepEqual(items.map((i) => [i.headline, i.url, new Date(i.published).toISOString()]), [
    ['Gold & silver rally', 'https://n.test/1', '2026-10-20T04:16:42.000Z'],
    ['No link', '', '2026-10-19T20:51:26.000Z'],
  ]);
  assert.equal(items[0].summary, 'Bullion up');
  const atom = news.parseFeed('<feed><entry><title>ECB holds</title><link href="https://e.test/x"/><updated>2026-10-19T08:00:00+02:00</updated></entry></feed>', 'e');
  assert.equal(atom[0].url, 'https://e.test/x');
  assert.equal(new Date(atom[0].published).toISOString(), '2026-10-19T06:00:00.000Z');
  const tag = (h) => news.tagItem({ headline: h }, ['XAUUSD', 'USD', 'EURUSD']);
  assert.deepEqual(tag('Fed holds rates; gold steady'), ['XAUUSD', 'USD']);
  assert.deepEqual(tag('Federation council meets'), []);
  assert.deepEqual(tag('EUR/USD slips as ECB speaks'), ['USD', 'EURUSD']);
  assert.equal(news.baseSymbol('XAUUSDm'), 'XAUUSD');
  assert.equal(news.baseSymbol('EURUSD.r'), 'EURUSD');
  assert.deepEqual(news.parseCsv('\uFEFFa,b\r\n"x, ""y""",2\r\n'), [{ a: 'x, "y"', b: '2' }]);
  assert.equal(news.cleanText('A&#39;s &#x41; <b>bold</b>'), "A's A bold");
});

// --- site notes and extract_list -----------------------------------------------------------

test('site notes: site keys, limits, prompt section', async () => {
  assert.equal(notes.siteKey('https://www.linkedin.com/jobs/search'), 'linkedin.com');
  assert.equal(notes.siteKey('https://jobs.bbc.co.uk/x'), 'bbc.co.uk');
  assert.equal(notes.siteKey('http://127.0.0.1:8787/'), '127.0.0.1');
  assert.equal(notes.siteKey('chrome://extensions'), null);
  await notes.addNote('example.com', '  Search   URL is /s?q=  ');
  await notes.addNote('example.com', 'search url is /s?q='); // duplicate, ignored
  assert.deepEqual((await notes.notesFor('example.com')).map((n) => n.text), ['Search URL is /s?q=']);
  await assert.rejects(notes.addNote('example.com', 'x'.repeat(301)), /at most 300/);
  for (let i = 2; i <= 10; i += 1) await notes.addNote('example.com', `note ${i}`);
  await assert.rejects(notes.addNote('example.com', 'one more'), /already has 10 notes/);
  assert.match(notes.notesPrompt('example.com', await notes.notesFor('example.com')), /data, not instructions[\s\S]*\n1\. Search URL is \/s\?q=/);
  await notes.removeNote('example.com', 1);
  assert.equal((await notes.notesFor('example.com')).length, 9);
  await assert.rejects(notes.removeNote('example.com', 42), /No note 42/);
  assert.equal(notes.notesPrompt('none.com', []), '');
});

test('extract_list: rows are de-duplicated by link, else by content', () => {
  const rows = [];
  const seen = new Set();
  assert.equal(mergeRows(rows, seen, [{ title: 'a', link: 'u1' }, { title: 'a again', link: 'u1' }, { title: 'b' }]), 2);
  assert.equal(mergeRows(rows, seen, [{ title: 'b' }, { title: 'c', link: 'u2' }]), 1);
  assert.deepEqual(rows.map((r) => r.title), ['a', 'b', 'c']);
  assert.deepEqual(listColumns([{ text10: 1, link: 2, text2: 3, title: 4, extra: 5 }]), ['title', 'link', 'text2', 'text10', 'extra']);
  assert.deepEqual(listColumns([{ b: 1, a: 2 }], { a: 'x', b: 'y' }), ['a', 'b']);
});

test('tool calls from small models: leaked format tokens and bare actions are mapped', async () => {
  const { normalizeToolCall } = await import('../../src/tools.js');
  assert.deepEqual(normalizeToolCall('wait<|channel|>commentary', { duration: 3 }), { name: 'computer', input: { duration: 3, action: 'wait' } });
  assert.deepEqual(normalizeToolCall('wait_for', { selector: 'h1' }), { name: 'computer', input: { selector: 'h1', action: 'wait_for' } });
  assert.deepEqual(normalizeToolCall('click', { ref: 'ref_2' }), { name: 'computer', input: { ref: 'ref_2', action: 'left_click' } });
  assert.deepEqual(normalizeToolCall('navigate', { url: 'x' }), { name: 'navigate', input: { url: 'x' } });
});

// --- 0.8.0 quick wins -----------------------------------------------------------------

const { formatChanges } = await import('../../src/tools.js');
const { repeatKey, repeatNote, noopNote } = await import('../../src/agent.js');
const { searchPlan } = await import('../../src/websearch.js');

test('aliases other agents use map to real tools', async () => {
  const { normalizeToolCall } = await import('../../src/tools.js');
  assert.deepEqual(normalizeToolCall('search', { q: 'cats' }), { name: 'web_search', input: { q: 'cats', query: 'cats' } });
  assert.deepEqual(normalizeToolCall('Google', { query: 'dogs' }), { name: 'web_search', input: { query: 'dogs' } });
  assert.deepEqual(normalizeToolCall('computer', { action: 'find', query: 'Submit' }), { name: 'find', input: { query: 'Submit' } });
  assert.deepEqual(normalizeToolCall('computer', { action: 'down' }), { name: 'computer', input: { action: 'scroll', scroll_direction: 'down' } });
  assert.deepEqual(normalizeToolCall('scroll_up', {}), { name: 'computer', input: { action: 'scroll', scroll_direction: 'up' } });
  assert.deepEqual(normalizeToolCall('goto', { url: 'a.com' }), { name: 'navigate', input: { url: 'a.com' } });
  assert.deepEqual(normalizeToolCall('computer', { action: 'press', text: 'Enter' }), { name: 'computer', input: { action: 'key', text: 'Enter' } });
});

test('repeated calls are recognised across spelling differences', () => {
  assert.equal(repeatKey('navigate', { url: 'https://www.a.com/x/' }), repeatKey('goto', { url: 'http://a.com/x#top' }));
  assert.equal(repeatKey('navigate', { url: 'back' }), null);
  assert.equal(repeatKey('search', { q: 'Dr  Aleem' }), repeatKey('web_search', { query: 'dr aleem' }));
  assert.equal(repeatKey('read_page', {}), null);
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'navigate', input: { url: 'a.com/faculty' } }] },
    { role: 'user', content: [] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'navigate', input: { url: 'https://a.com/faculty/' } }] },
  ];
  assert.match(repeatNote(messages, { id: 'b', name: 'navigate', input: { url: 'https://a.com/faculty/' } }), /already opened this address once/);
  assert.equal(repeatNote(messages, { id: 'c', name: 'navigate', input: { url: 'a.com/people' } }), '');
});

test('a click that changes nothing twice gets a nudge', () => {
  const noops = new Map();
  const nothing = 'left_click at (1, 2) CSS px.\nNo visible change on the page.';
  assert.equal(noopNote(noops, 'computer', { action: 'left_click', ref: 'ref_3' }, nothing), '');
  assert.equal(noopNote(noops, 'computer', { action: 'left_click', ref: 'ref_4' }, nothing), '');
  assert.match(noopNote(noops, 'click', { ref: 'ref_3' }, nothing), /left click has now changed nothing 2 times/);
  assert.equal(noopNote(noops, 'computer', { action: 'left_click', ref: 'ref_3' }, 'left_click.\nPage changes:\nAppeared (1):\n- button "x" [ref_9]'), '');
});

test('change reports read well', () => {
  assert.equal(formatChanges(null), '');
  assert.equal(formatChanges({ newPage: false, added: [], addedTotal: 0, removed: [], removedTotal: 0 }), '\nNo visible change on the page.');
  const many = formatChanges({ newPage: false, urlChanged: true, url: 'https://a/b', added: ['- button "Close" [ref_2]'], addedTotal: 40, removed: ['- link "Sign in" [ref_1]'], removedTotal: 1 });
  assert.match(many, /^\nPage changes:\nURL is now https:\/\/a\/b\nAppeared \(40\):\n- button "Close" \[ref_2\]\n… and 39 more \(read_page shows all\)\nGone \(1\):\n- link "Sign in" \[ref_1\]$/);
  assert.match(formatChanges({ newPage: true, title: 'Next', url: 'https://a/n', outline: '- link "Home" [ref_1]' }), /^\nNow on a new page: "Next" https:\/\/a\/n\nVisible controls:\n- link "Home"/);
});

test('web_search tries the chosen engine first, then the others; an own search page replaces them', () => {
  assert.deepEqual(searchPlan({}, 'a b').map((e) => e.name), ['duckduckgo', 'bing', 'google']);
  assert.deepEqual(searchPlan({ searchEngine: 'bing' }, 'x').map((e) => e.name), ['bing', 'duckduckgo', 'google']);
  assert.deepEqual(searchPlan({ searchEngine: 'bing' }, 'x', 'google').map((e) => e.name), ['google', 'duckduckgo', 'bing']);
  assert.equal(searchPlan({}, 'a b')[0].url, 'https://html.duckduckgo.com/html/?q=a%20b');
  assert.deepEqual(searchPlan({ searchUrl: 'http://localhost:8888/search?q={q}' }, 'a&b'), [{ name: 'custom', url: 'http://localhost:8888/search?q=a%26b' }]);
});

// --- 0.9.0 agent quality ---------------------------------------------------------------

const jm = await import('../../src/jsonmode.js');
const ex = await import('../../src/extract.js');
const sv = await import('../../src/savedvalues.js');
const ag = await import('../../src/agent.js');
const { parseDomains } = await import('../../src/tasks.js');

test('JSON steps: lenient parsing, actions become tool calls, done ends', () => {
  const a = jm.parseStep('```json\n{"evaluation_previous_goal":"ok","memory":"m1","next_goal":"click","actions":[{"tool":"computer","input":{"action":"left_click","ref":"ref_2"}},{"name":"find","args":{"query":"x"}}]}\n```');
  assert.equal(a.step.memory, 'm1');
  assert.deepEqual(a.uses.map((u) => [u.name, u.input]), [['computer', { action: 'left_click', ref: 'ref_2' }], ['find', { query: 'x' }]]);
  assert.equal(a.done, null);
  const d = jm.parseStep('Sure! {"memory":"","next_goal":"finish","action":{"tool":"done","input":{"success":false,"text":"Not found"}}}');
  assert.deepEqual(d.done, { success: false, text: 'Not found' });
  assert.equal(d.uses.length, 0);
  assert.throws(() => jm.parseStep('I will click the button'), /no JSON object/);
  assert.throws(() => jm.parseStep('{"actions": []}'), /empty/);
  const many = jm.parseStep(JSON.stringify({ actions: Array.from({ length: 8 }, () => ({ tool: 'find', input: {} })) }));
  assert.equal(many.uses.length, jm.MAX_JSON_ACTIONS);
});

test('JSON steps: the schema enumerates tool names; history becomes text', () => {
  const schema = jm.stepSchema(['navigate', 'find']);
  assert.deepEqual(schema.properties.actions.items.properties.tool.enum, ['navigate', 'find', 'done']);
  const transcript = jm.toTextTranscript([
    { role: 'user', content: [{ type: 'text', text: 'Do it' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'goal', step: { memory: 'm', actions: [{ tool: 'find', input: {} }] } }, { type: 'tool_use', id: 'a', name: 'find', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', isError: true, content: [{ type: 'text', text: 'boom' }] }, { type: 'image', mediaType: 'image/png', data: 'x' }] },
  ]);
  assert.equal(transcript[1].content[0].text, JSON.stringify({ memory: 'm', actions: [{ tool: 'find', input: {} }] }));
  assert.equal(transcript[2].content[0].text, 'Results of your actions:\n1. ERROR: boom');
  assert.equal(transcript[2].content[1].type, 'image');
});

test('extract helpers: chunks split at lines, parts merge without repeats', () => {
  const chunks = ex.chunkText(`${'a'.repeat(80)}\n`.repeat(30), 1000);
  assert.ok(chunks.length >= 3 && chunks.every((c) => c.length <= 1000));
  assert.deepEqual(ex.mergeParts([[{ a: 1 }, { a: 2 }], [{ a: 2 }, { a: 3 }]]), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.deepEqual(ex.mergeParts([{ items: [1], title: '' }, { items: [2], title: 'T' }]), { items: [1, 2], title: 'T' });
  const page = { url: 'u', text: 'one\nContact: a@b.org\nthree\nPrice 4' };
  assert.match(ex.searchPage(page, { pattern: 'contact', context: 0 })[0].text, /^1 match\(es\) for "contact" on u:\n> 2: Contact: a@b\.org$/);
  assert.match(ex.searchPage(page, { pattern: '[0-9]$', regex: true, context: 0 })[0].text, /4: Price 4/);
  assert.match(ex.searchPage(page, { pattern: 'zzz' })[0].text, /^No match/);
  assert.throws(() => ex.searchPage(page, { pattern: '(', regex: true }), /Bad regex/);
});

test('saved values: filled by name on allowed sites, masked back', () => {
  const values = [{ name: 'email', value: 'me@x.org', sites: '' }, { name: 'phone', value: '0612', sites: 'shop.com' }];
  assert.equal(sv.fillSavedValues('to {{email}}', values, 'a.com'), 'to me@x.org');
  assert.equal(sv.fillSavedValues('{{phone}}', values, 'www.shop.com'), '0612');
  assert.equal(sv.fillSavedValues('{{phone}}', values, 'eu.shop.com'), '0612');
  assert.throws(() => sv.fillSavedValues('{{phone}}', values, 'evil.com'), /only be used on shop\.com/);
  assert.throws(() => sv.fillSavedValues('{{iban}}', values, 'a.com'), /no saved value called \{\{iban\}\}/);
  assert.equal(sv.maskSavedValues('Set ref_1 to "me@x.org"; tel 0612', values), 'Set ref_1 to "{{email}}"; tel {{phone}}');
  assert.deepEqual(sv.savedValueNames(values), ['{{email}}', '{{phone}} (on shop.com)']);
  assert.deepEqual(parseDomains('https://www.Example.com/x, shop.org  shop.org'), ['example.com', 'shop.org']);
});

test('plan items, memory and the page-state copy of the history', () => {
  assert.deepEqual(ag.planItems('Plan\n1. Open\n2) Read it\nnotes').map((p) => [p.n, p.text]), [[1, 'Open'], [2, 'Read it']]);
  const history = [
    { role: 'assistant', content: [{ type: 'text', text: 'x', step: { memory: 'old' } }] },
    { role: 'user', content: [{ type: 'text', text: 'r' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'y', step: { memory: 'new' } }] },
  ];
  assert.equal(ag.latestMemory(history), 'new');
  assert.equal(ag.latestMemory([]), '');
  const withState = ag.withPageState(history, 'STATE');
  assert.equal(withState.length, 4);
  assert.equal(history.length, 3, 'the history itself is unchanged');
  assert.deepEqual(ag.withPageState(withState.slice(0, 2), 'S2')[1].content.map((b) => b.text), ['r', 'S2']);
});
