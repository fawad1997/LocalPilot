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
