// Phase D: Quantara tools (read-only + emergency stop that always asks), repeating schedules with
// "notify on change" and no-AI page watches, extract_list (any page -> CSV, with paging), the
// economic-calendar recipe (page data and table paths, UTC self-check), news_collect (RSS + Atom,
// tags, de-duplication) and per-site notes in the system prompt. Needs host:install.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-d-'));
const jobsDir = path.join(tmp, 'Jobs');
const tradingDir = path.join(tmp, 'research');
fs.mkdirSync(jobsDir, { recursive: true });
fs.mkdirSync(tradingDir, { recursive: true });
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  roots: [{ name: 'jobs', path: jobsDir, writable: true }, { name: 'trading', path: tradingDir, writable: true }],
  scripts: [],
}));
const today = new Date().toISOString().slice(0, 10);

// ---- fake Quantara dashboard (its own origin, like http://127.0.0.1:8787) ----
const halts = [];
const qtState = {
  environment: 'DEMO', symbol: 'XAUUSDm', startup_state: 'ACTIVE', system_status: 'TRADING',
  status_reasons: [{ code: 'SYSTEM_READY', severity: 'INFO', message: 'System ready; awaiting a strategy signal' }],
  components: { mt5: 'HEALTHY', database: 'HEALTHY' }, blockers: [],
  kill_switch: { engaged: false, reason: '', by: '', at: null, volatile: [] },
  risk: { state: 'NORMAL', multiplier: 1, equity: 1012.5, daily_pnl: 12.5, daily_loss_remaining: 40, drawdown: 0.01, reason: '' },
  account: { balance: 1000, equity: 1012.5, currency: 'USD', login: 87654321, server: 'Exness-MT5Trial7', today_pnl: 12.5, margin_level: 900, floating_pnl: 2.5 },
  positions: [{ ticket: 1, symbol: 'XAUUSDm', side: 'BUY', volume: 0.01, entry: 4100, current: 4102.5, floating_pnl: 2.5, sl: 4090, tp: 4120, managed: true, strategy: 'micro_scalper' }],
  symbols: ['XAUUSDm', 'EURUSDm'],
  symbol_trading: { XAUUSDm: { enabled: true }, EURUSDm: { enabled: false, reason: 'testing', by: 'dashboard' } },
  market: { session: 'LONDON', spread_points: 120, spread_limit_points: 300, event_state: 'CLEAR', next_event: { time: '2026-10-28T18:00:00+00:00', title: 'FOMC statement' }, regime: 'TREND', regime_detail: { huge: 'x'.repeat(5000) } },
  microstructure: { XAUUSDm: { vpin: 0.3, blob: 'y'.repeat(5000) } },
  pending_signals: [], server_time_utc: '2026-10-20T10:00:00+00:00',
};
const GLOSSARY_JS = `const GLOSSARY = {
  SYSTEM_READY:            {say: "Ready and watching", mean: "Every check passed.", tone: "good"},
  TRADING:                 {say: "Trading", tone: "good"},
  SPREAD_TOO_LARGE_VS_STOP: {say: "The broker's gap would eat the trade", tone: "good"},
};`;
const qt = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/api/state') return json(200, qtState);
  if (url.pathname === '/static/glossary.js') return res.writeHead(200, { 'content-type': 'application/javascript' }).end(GLOSSARY_JS);
  if (url.pathname === '/api/trades/today') return json(200, [{ id: 'u1', client_order_id: 'c1', closed_at: '2026-10-20T09:00:00Z', symbol: 'XAUUSDm', direction: 'BUY', strategy_id: 'micro_scalper', net_pnl: 5.5, r_multiple: 0.5, exit_reason: 'TP' }]);
  if (url.pathname === '/api/candidates/summary') return json(200, { days: Number(url.searchParams.get('days')), evaluations: 40, groups: [{ symbol: 'XAUUSDm', strategy_id: 'micro_scalper', stage: 'cost', gate: 'COST', reason: 'SPREAD_TOO_LARGE_VS_STOP', count: 25, outcomes: { REJECTED: 25 } }] });
  if (url.pathname === '/api/analysis/sessions') return json(200, { verdict: 'Not enough finished trades to judge any session yet', sessions: [{ session: 'LONDON', trades: 8, expectancy_r: 0.046 }], hours: url.searchParams.get('hours') });
  if (url.pathname === '/api/research/lab') return json(200, { latest: { created_at: '2026-10-20T06:00:00Z' }, live_gate: { XAUUSDm: { blocked: false } }, gate_strategies: ['micro_scalper'], verdict_counts: { PASS: 1 }, per_strategy: {}, history: [1, 2, 3] });
  if (url.pathname === '/api/control/halt' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers['x-dashboard-token'] !== 'tok123') return json(403, { ok: false, error: 'invalid or missing dashboard token' });
      halts.push(JSON.parse(body || '{}'));
      return json(200, { ok: true, kill_switch: { engaged: true } });
    });
    return undefined;
  }
  return json(404, { error: 'not found' });
});
await new Promise((r) => qt.listen(0, '127.0.0.1', r));
const qtBase = `http://127.0.0.1:${qt.address().port}`;

// ---- fake sites: ForexFactory weeks, a paged list, a watched page, news feeds ----
let watchValue = '100';
const sec = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const stateWeek = (events) => `<!doctype html><html><head><title>Forex Factory</title><script>window.calendarComponentStates = {1: {days: [{events: ${JSON.stringify(events)}}]}};</script></head><body><table class="calendar__table"></table></body></html>`;
const FF = {
  // Page data with epoch times (week of Sun 27 Sep 2026).
  'sep27.2026': stateWeek([
    { name: 'Weekend Event', currency: 'USD', impactName: 'high', dateline: sec(2026, 9, 27, 22, 0), timeLabel: '6:00pm' },
    { name: 'German Prelim CPI m/m', currency: 'EUR', impactName: 'high', dateline: sec(2026, 9, 30, 12, 0), timeLabel: '8:00am' },
    { name: 'Bank Holiday', currency: 'USD', impactName: 'holiday', dateline: sec(2026, 10, 1, 4, 0), timeLabel: 'All Day' },
    { name: 'Non-Farm Employment Change', currency: 'USD', impactName: 'high', dateline: sec(2026, 10, 2, 12, 30), timeLabel: '8:30am', actual: '150K', forecast: '140K', previous: '130K' },
    { name: 'Unemployment Rate', currency: 'USD', impactName: 'high', dateline: sec(2026, 10, 2, 12, 30), timeLabel: '8:30am', actual: '4.1%' },
  ]),
  // Table only, times shown in UTC+2 (week of Sun 4 Oct 2026).
  'oct4.2026': `<!doctype html><html><head><title>Forex Factory</title></head><body><table class="calendar__table">
    <tr class="calendar__row"><td class="calendar__date">Thu Oct 8</td><td class="calendar__time">2:30pm</td><td class="calendar__currency">USD</td><td class="calendar__impact"><span class="icon icon--ff-impact-red"></span></td><td class="calendar__event"><span class="calendar__event-title">Unemployment Claims</span></td><td class="calendar__actual">210K</td><td class="calendar__forecast">215K</td><td class="calendar__previous">220K</td></tr>
    <tr class="calendar__row"><td class="calendar__date"></td><td class="calendar__time"></td><td class="calendar__currency">USD</td><td class="calendar__impact"><span class="icon icon--ff-impact-red"></span></td><td class="calendar__event"><span class="calendar__event-title">Continuing Claims</span></td><td class="calendar__actual"></td><td class="calendar__forecast"></td><td class="calendar__previous"></td></tr>
    <tr class="calendar__row"><td class="calendar__date"></td><td class="calendar__time">4:00pm</td><td class="calendar__currency">USD</td><td class="calendar__impact"><span class="icon icon--ff-impact-red"></span></td><td class="calendar__event"><span class="calendar__event-title">ISM Services PMI</span></td><td class="calendar__actual"></td><td class="calendar__forecast"></td><td class="calendar__previous"></td></tr>
    <tr class="calendar__row"><td class="calendar__date">Fri Oct 9</td><td class="calendar__time">All Day</td><td class="calendar__currency">EUR</td><td class="calendar__impact"><span class="icon icon--ff-impact-gra"></span></td><td class="calendar__event"><span class="calendar__event-title">Bank Holiday</span></td><td class="calendar__actual"></td><td class="calendar__forecast"></td><td class="calendar__previous"></td></tr>
    <tr class="calendar__row"><td class="calendar__date"></td><td class="calendar__time">10:00am</td><td class="calendar__currency">USD</td><td class="calendar__impact"><span class="icon icon--ff-impact-ora"></span></td><td class="calendar__event"><span class="calendar__event-title">Wholesale Inventories m/m</span></td><td class="calendar__actual"></td><td class="calendar__forecast"></td><td class="calendar__previous"></td></tr>
  </table></body></html>`,
  // Wrong times: CPI at 13:30 UTC in October (New York summer time is 12:30 UTC).
  'oct11.2026': stateWeek([
    { name: 'CPI m/m', currency: 'USD', impactName: 'high', dateline: sec(2026, 10, 14, 13, 30), timeLabel: '9:30am' },
    { name: 'Core CPI m/m', currency: 'USD', impactName: 'high', dateline: sec(2026, 10, 14, 13, 30), timeLabel: '9:30am' },
  ]),
};
const card = (n) => `<li class="card"><h3>Full Stack Engineer ${n}</h3><a href="/job/${n}">Open posting</a><span class="price">EUR ${n}000</span><span class="loc">Amsterdam, Netherlands</span></li>`;
const listPage = (page) => `<!doctype html><html><head><title>List ${page}</title></head><body>
  <nav><a href="/">Home</a><a href="/a">About</a><a href="/j">Jobs</a><a href="/b">Blog</a><a href="/c">Contact</a></nav>
  <main><ul class="results">${[1, 2, 3, 4, 5].map((i) => card((page - 1) * 5 + i)).join('')}</ul>
  ${page < 2 ? `<a href="/list?page=${page + 1}">Next</a>` : ''}</main></body></html>`;
const now = Date.now();
const RSS = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Test news</title>
  <item><title><![CDATA[Gold climbs as dollar slips]]></title><link>https://news.test/gold-1</link><pubDate>${new Date(now - 3600e3).toUTCString()}</pubDate><description>Bullion &amp; more</description></item>
  <item><title>Russian federation news</title><link>https://news.test/other</link><pubDate>${new Date(now - 3600e3).toUTCString()}</pubDate></item>
  <item><title>Old gold story</title><link>https://news.test/old</link><pubDate>${new Date(now - 10 * 86400e3).toUTCString()}</pubDate></item>
</channel></rss>`;
const ATOM = () => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
  <entry><title>Powell speaks on inflation</title><link href="https://news.test/powell"/><updated>${new Date(now - 2 * 3600e3).toISOString()}</updated><summary>Fed chair remarks</summary></entry>
</feed>`;
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const html = (body) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  if (url.pathname === '/ff/calendar') return html(FF[url.searchParams.get('week')] || '<!doctype html><title>Forex Factory</title><p>No events</p>');
  if (url.pathname === '/list') return html(listPage(Number(url.searchParams.get('page') || 1)));
  if (url.pathname.startsWith('/job/')) return html(`<h1>Job ${url.pathname.slice(5)}</h1>`);
  if (url.pathname === '/watch') return html(`<!doctype html><title>Watch</title><main><div id="price">Price: ${watchValue}</div><p>Static footer text</p></main>`);
  if (url.pathname === '/rss.xml') return res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(RSS());
  if (url.pathname === '/atom.xml') return res.writeHead(200, { 'content-type': 'application/atom+xml' }).end(ATOM());
  return html('<!doctype html><title>Site</title><main><p>Plain page for notes.</p></main>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteBase = `http://127.0.0.1:${site.address().port}`;

const { server, requests } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-d-test-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
    LOCALPILOT_HOST_CONFIG: configFile,
  },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const T = (fn, arg) => sw.evaluate(fn, arg);
  const tool = (tabId, name, input) => T(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const run = (opts) => T(async (o) => {
    globalThis.__localPilotTest.reset();
    return globalThis.__localPilotTest.run(o);
  }, opts);
  const settings = (patch) => T((p) => globalThis.__localPilotTest.saveSettings(p), patch);
  const tabIdOf = (u) => T(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, u);
  const readFile = (rel) => fs.readFileSync(path.join(tradingDir, rel), 'utf8');

  await settings({
    provider: 'openai', baseUrl: `${base}/v1`, model: 'mock-model', apiKey: '', permissionMode: 'auto', approvedDomains: ['127.0.0.1'], maxSteps: 8,
    streaming: false, summarizeAfterTokens: 0, recipeDelayScale: 0.01, forexfactoryBaseUrl: `${siteBase}/ff`,
    quantaraEnabled: true, quantaraUrl: qtBase, quantaraToken: '',
  });

  const page = await context.newPage();
  page.on('dialog', () => {});
  await page.goto(`${base}/page`);
  const tabId = await tabIdOf(`${base}/page`);

  // 1. Quantara: read tools with plain-language labels and private fields dropped; halt only with a token,
  //    and it asks even in "Act without asking" mode.
  let r = await tool(tabId, 'quantara_status', {});
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Ready and watching/);
  assert.match(r.text, /EURUSDm/);
  assert.match(r.text, /micro_scalper/);
  assert.ok(!r.text.includes('87654321') && !r.text.includes('Exness-MT5Trial7'), 'account login and server are not passed to the model');
  assert.ok(!r.text.includes('yyyyy') && !r.text.includes('xxxxx') && r.text.length < 7000, `trimmed (${r.text.length} chars)`);
  r = await tool(tabId, 'quantara_analysis', { kind: 'why_not_trading', hours: 24 });
  assert.ok(r.ok && /The broker's gap would eat the trade/.test(r.text) && /"chances_evaluated":40/.test(r.text), r.text);
  r = await tool(tabId, 'quantara_analysis', { kind: 'sessions', hours: 72 });
  assert.ok(r.ok && /Not enough finished trades/.test(r.text), r.text);
  r = await tool(tabId, 'quantara_trades', {});
  assert.ok(r.ok && /closed today \(UTC\): 1, net 5\.5/.test(r.text) && !r.text.includes('c1'), r.text);
  r = await tool(tabId, 'quantara_research', {});
  assert.ok(r.ok && /micro_scalper/.test(r.text), r.text);

  let events = await run({ tabId, prompt: 'QUANTARA-FLOW how is the bot doing?' });
  let last = requests.at(-1);
  let names = last.tools.map((t) => t.function.name);
  assert.ok(names.includes('quantara_status') && !names.includes('quantara_halt'), 'no halt tool without a token');
  assert.match(last.messages[0].content, /Do not give trading or investment advice/);
  assert.match(events.filter((e) => e.type === 'assistant').at(-1).text, /Ready and watching/);

  await settings({ quantaraToken: 'tok123' });
  r = await tool(tabId, 'quantara_halt', { reason: 'x' }); // the test hook's approval answers "deny"
  assert.ok(!r.ok && /declined/.test(r.text) && halts.length === 0, `auto mode still asks: ${r.text}`);
  events = await run({ tabId, prompt: 'HALT-FLOW stop the bot', approval: 'once' });
  const asked = events.filter((e) => e.type === 'approval');
  assert.equal(asked.length, 1);
  assert.ok(asked[0].onceOnly && /Quantara: emergency stop/.test(asked[0].host), JSON.stringify(asked[0]));
  assert.equal(halts.length, 1);
  assert.match(halts[0].reason, /^LocalPilot: test halt/);
  await settings({ quantaraToken: 'wrong' });
  events = await run({ tabId, prompt: 'HALT-FLOW again', approval: 'once' });
  assert.ok(events.some((e) => e.type === 'tool_result' && !e.ok && /refused the halt.*NOT halted/.test(e.content[0].text)), 'a wrong token is reported, not hidden');
  assert.equal(halts.length, 1);
  await settings({ quantaraUrl: 'http://127.0.0.1:9' });
  r = await tool(tabId, 'quantara_status', {});
  assert.ok(!r.ok && /not reachable/.test(r.text), r.text);
  await settings({ quantaraUrl: 'http://example.com:8787' });
  r = await tool(tabId, 'quantara_status', {});
  assert.ok(!r.ok && /must be on this PC/.test(r.text), r.text);
  await settings({ quantaraUrl: qtBase, quantaraToken: '' });
  console.log('1. Quantara: status/analysis/trades/research with glossary labels, private fields dropped; halt asks every time (even in auto), wrong token and offline reported');

  // 2. Schedules: interval / weekdays alarms, page watch without the model, notify only on change or keyword.
  const watch = await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'price-watch', url: `${siteBase}/watch`, watch: { selector: '#price' }, schedule: { kind: 'interval', minutes: 15 }, notifyOn: 'change' });
  let alarm = await T((n) => globalThis.__localPilotTest.getAlarm(n), `task:${watch.id}`);
  assert.equal(alarm.periodInMinutes, 15);
  const before = requests.length;
  let fired = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${watch.id}`);
  assert.ok(fired.ok && fired.notified && /Watching started/.test(fired.text), JSON.stringify(fired));
  fired = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${watch.id}`);
  assert.ok(fired.ok && !fired.notified && fired.text === 'No change.', JSON.stringify(fired));
  watchValue = '250';
  fired = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${watch.id}`);
  assert.ok(fired.ok && fired.notified && /Changed: Price: 250/.test(fired.text), JSON.stringify(fired));
  assert.equal(requests.length, before, 'page watches never call the model');
  let notes = await T(() => globalThis.__localPilotTest.notifications());
  assert.match(notes.at(-1).title, /price-watch changed/);
  const runs = await T(() => globalThis.__localPilotTest.lastRuns());
  assert.ok(runs[watch.id].hash && runs[watch.id].snapshot.includes('250'));

  const weekdays = await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'morning-check', prompt: 'QUANTARA-FLOW morning check', schedule: { kind: 'weekdays', time: '07:45' } });
  alarm = await T((n) => globalThis.__localPilotTest.getAlarm(n), `task:${weekdays.id}`);
  const at = new Date(alarm.scheduledTime);
  assert.ok(alarm.periodInMinutes === 1440 && at.getHours() === 7 && at.getMinutes() === 45 && at.getDay() !== 0 && at.getDay() !== 6, `weekday alarm ${at}`);
  const tooOften = await T((t) => globalThis.__localPilotTest.saveTask(t).then(() => 'saved', (e) => e.message), { name: 'spam', prompt: 'x', schedule: { kind: 'interval', minutes: 5 } });
  assert.match(tooOften, /every 15 minutes/);
  const kw = await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'kw', prompt: 'SCHEDULED-FLOW keyword', url: `${base}/page`, notifyOn: 'keyword', keyword: 'zzz-not-there' });
  fired = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${kw.id}`);
  assert.ok(fired.ok && !fired.notified, JSON.stringify(fired));
  await T((t) => globalThis.__localPilotTest.saveTask(t), { id: kw.id, name: 'kw', prompt: 'SCHEDULED-FLOW keyword two', url: `${base}/page`, notifyOn: 'keyword', keyword: 'club' });
  fired = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${kw.id}`);
  assert.ok(fired.ok && fired.notified, JSON.stringify(fired));
  notes = await T(() => globalThis.__localPilotTest.notifications());
  assert.match(notes.at(-1).title, /kw found "club"/);

  // The saved-task editor in the panel: schedule / notify / watch controls.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html?tabId=${tabId}`);
  await panel.click('#toggle-tasks');
  await panel.fill('#task-name', 'ui-watch');
  await panel.fill('#task-url', `${siteBase}/watch`);
  await panel.check('#task-watch-on');
  assert.ok(await panel.locator('#task-watch-selector').isVisible(), 'selector input shown for watches');
  await panel.fill('#task-watch-selector', '#price');
  await panel.selectOption('#task-schedule', 'interval');
  assert.ok(await panel.locator('#task-interval').isVisible() && !(await panel.locator('#task-daily').isVisible()));
  await panel.fill('#task-interval', '30');
  await panel.selectOption('#task-notify', 'change');
  await panel.click('#task-form button[type=submit]');
  await panel.locator('.task-list li', { hasText: '/ui-watch' }).waitFor({ timeout: 5000 });
  assert.match(await panel.locator('.task-list li', { hasText: '/ui-watch' }).textContent(), /every 30 min · page watch · notify on change/);
  const saved = (await T(() => globalThis.__localPilotTest.listTasks())).find((t) => t.name === 'ui-watch');
  assert.deepEqual([saved.schedule, saved.watch, saved.notifyOn], [{ kind: 'interval', minutes: 30 }, { selector: '#price' }, 'change']);
  await panel.close();
  console.log('2. schedules: 15-min watch alarm (no model; notifies on first run and on change only), weekday alarm, 5-min refused, keyword notify, panel editor');

  // 3. extract_list on any page: detect, then extract with "Next" paging and save to CSV.
  await page.goto(`${siteBase}/list?page=1`);
  const listTab = await tabIdOf(`${siteBase}/list?page=1`);
  r = await tool(listTab, 'extract_list', { action: 'detect' });
  assert.ok(r.ok && /list1: 5 items, selector ul\.results > li\.card/.test(r.text) && /Full Stack Engineer 1/.test(r.text), r.text);
  assert.ok(!/list2/.test(r.text), `the menu is not a list: ${r.text}`);
  r = await tool(listTab, 'extract_list', { action: 'extract', list: 'list1', pages: 3, next: 'Next', save: { root: 'trading', path: 'datasets/list.csv' } });
  assert.ok(r.ok && /Saved 10 rows from 2 page\(s\)/.test(r.text) && /no "Next" control after page 2/.test(r.text), r.text);
  const csv = readFile('datasets/list.csv').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.equal(csv.length, 11);
  assert.match(csv[0], /^title,link,text1,text2,text3/);
  assert.match(csv[10], new RegExp(`^Full Stack Engineer 10,${siteBase.replace(/[.]/g, '\\.')}/job/10,Open posting,EUR 10000,"Amsterdam, Netherlands"`));
  await page.goto(`${siteBase}/list?page=1`);
  r = await tool(listTab, 'extract_list', { action: 'extract', list: 'ul.results > li.card', fields: { name: 'h3', price: '.price', url: 'a@href' }, max_rows: 3 });
  const rows = JSON.parse(r.text.slice(r.text.indexOf('\n') + 1));
  assert.deepEqual(rows[2], { name: 'Full Stack Engineer 3', price: 'EUR 3000', url: `${siteBase}/job/3` });
  assert.equal(rows.length, 3);
  console.log('3. extract_list: menu ignored, 5-card list detected; 2 pages via "Next" -> 10 rows CSV; custom fields with @href');

  // 4. Economic calendar: page data + table (UTC+2) weeks -> import CSV (no BOM) + detailed CSV; bad times refused.
  r = await tool(listTab, 'econ_calendar_collect', { from: '2026-09-28', to: '2026-10-09' });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Self-check: 3 of 3 fixed-time releases/);
  assert.match(r.text, /import-events research\/datasets\/calendar_2026-09-28_2026-10-09\.csv/);
  const cal = readFile('datasets/calendar_2026-09-28_2026-10-09.csv');
  assert.ok(!cal.startsWith('\uFEFF'), 'no BOM: Quantara reads the file as plain UTF-8');
  assert.deepEqual(cal.trim().split(/\r?\n/), [
    'datetime_utc,currency,impact,title',
    '2026-10-02 12:30,USD,HIGH,Non-Farm Employment Change',
    '2026-10-02 12:30,USD,HIGH,Unemployment Rate',
    '2026-10-08 12:30,USD,HIGH,Unemployment Claims',
    '2026-10-08 12:30,USD,HIGH,Continuing Claims',
    '2026-10-08 14:00,USD,HIGH,ISM Services PMI',
  ]);
  const detailedCal = readFile('datasets/calendar_2026-09-28_2026-10-09_detailed.csv');
  assert.match(detailedCal, /2026-10-02 12:30,USD,HIGH,Non-Farm Employment Change,150K,140K,130K,8:30am,,sep27\.2026/);
  assert.match(detailedCal, /2026-10-08 12:30,USD,HIGH,Unemployment Claims,210K,215K,220K,2:30pm,,oct4\.2026/);
  r = await tool(listTab, 'econ_calendar_collect', { from: '2026-10-12', to: '2026-10-16' });
  assert.ok(!r.ok && /self-check failed \(2 of 2/.test(r.text), r.text);
  assert.ok(!fs.existsSync(path.join(tradingDir, 'datasets', 'calendar_2026-10-12_2026-10-16.csv')), 'nothing written when times are wrong');
  console.log('4. calendar: epoch page data + UTC+2 table converted to UTC, EUR/medium/holiday/out-of-range dropped, no BOM; wrong times refused');

  // 5. News: RSS + Atom, symbol tags (broker suffix ok), old and untagged dropped, de-duplicated on the next run.
  r = await tool(listTab, 'news_collect', { symbols: ['XAUUSDm', 'USD'], feeds: [`${siteBase}/rss.xml`, `${siteBase}/atom.xml`], hours: 48 });
  assert.ok(r.ok && /Added 2 new row\(s\)/.test(r.text), r.text);
  const newsRows = readFile(`datasets/news_${today}.csv`).trim().split(/\r?\n/);
  assert.equal(newsRows[0], 'published_utc,source,symbol_tags,headline,url,summary');
  assert.equal(newsRows.length, 3);
  assert.match(newsRows[1], /,127\.0\.0\.1,USD,Powell speaks on inflation,https:\/\/news\.test\/powell,Fed chair remarks$/); // oldest first
  assert.match(newsRows[2], /,127\.0\.0\.1,XAUUSD USD,Gold climbs as dollar slips,https:\/\/news\.test\/gold-1,Bullion & more$/);
  r = await tool(listTab, 'news_collect', { symbols: ['XAUUSD', 'USD'], feeds: [`${siteBase}/rss.xml`, `${siteBase}/atom.xml`], hours: 48 });
  assert.ok(r.ok && /Added 0 new row\(s\).*\(2 today in total\)/.test(r.text), r.text);
  console.log('5. news: 2 tagged headlines from RSS + Atom ("federation" is not "Fed", 10-day-old dropped); second run adds 0');

  // 6. Site notes: saved by the model, shown in the next system prompt for that site, removable, limited.
  await page.goto(`${siteBase}/notes`);
  const noteTab = await tabIdOf(`${siteBase}/notes`);
  events = await run({ tabId: noteTab, prompt: 'NOTE-FLOW remember the search URL' });
  assert.ok(events.some((e) => e.type === 'tool_result' && e.ok && /Saved\. Notes for 127\.0\.0\.1/.test(e.content[0].text)), 'note saved');
  await run({ tabId: noteTab, prompt: 'SCHEDULED-FLOW next visit' });
  last = requests.at(-1);
  assert.match(last.messages[0].content, /Notes you saved earlier about 127\.0\.0\.1[^\n]*\n1\. Search URL is \/list\?page=N/);
  r = await tool(noteTab, 'site_note', { action: 'add', text: 'x'.repeat(301) });
  assert.ok(!r.ok && /at most 300 characters/.test(r.text), r.text);
  r = await tool(noteTab, 'site_note', { action: 'remove', index: 1 });
  assert.ok(r.ok && /No notes saved for 127\.0\.0\.1/.test(r.text), r.text);
  await run({ tabId: noteTab, prompt: 'SCHEDULED-FLOW after removal' });
  assert.ok(!/Notes you saved earlier/.test(requests.at(-1).messages[0].content));
  console.log('6. site notes: added by the model, in the next prompt for 127.0.0.1, 300-char limit, removed');

  console.log('\nPHASE D E2E PASS');
} finally {
  await context.close().catch(() => {});
  server.close();
  qt.close();
  site.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
