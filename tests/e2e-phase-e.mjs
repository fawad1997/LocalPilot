// Phase E: testing mode and GIF recording. test_website on a deliberately buggy mock shop
// (console error, JS exception, 404 image and page, "undefined" on screen, unlabeled field,
// icon-only button, too wide for phones, a logout link that must never be opened), the HTML report
// and GIF it saves, gif_recorder start/export, "record every run", and the /test and /record commands.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';
import { decodeGif } from './gif-decode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-e-'));
const dlDir = path.join(tmp, 'downloads');
const jobsDir = path.join(tmp, 'Jobs');
fs.mkdirSync(jobsDir, { recursive: true });
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({ roots: [{ name: 'jobs', path: jobsDir, writable: true }], scripts: [], downloadsDir: dlDir }));

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const hits = [];
let ext;
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.push(url.pathname);
  const html = (status, body) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  if (url.pathname === '/shop') {
    return html(200, page('Buggy Shop', `<h1>Buggy Shop</h1>
<p class="price">Price: undefined</p><p>Total: <span class="total">€NaN</span></p>
<img src="/img/ok.png" width="40" height="40">
<img src="/img/missing.png" alt="Product photo" width="40" height="40">
<form><input name="email" placeholder="Your email"> <button type="button"><svg width="16" height="16"><rect width="16" height="16"/></svg></button></form>
<div style="width:1100px;height:20px;background:#eee">wide banner</div>
<nav><a href="/about">About us</a> <a href="/missing">Old offers</a> <a href="/logout">Log out</a> <a href="${ext}/gone">Partner site</a></nav>`, '<script>console.error("Cart failed to load")</script>'));
  }
  if (url.pathname === '/about') {
    return html(200, page('About', '<h1>About</h1><p>We sell things.</p><a href="/shop">Shop</a>', '<script>setTimeout(() => { throw new Error("boom on about"); }, 10)</script>'));
  }
  if (url.pathname === '/img/ok.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  if (url.pathname === '/logout') return html(200, page('Logged out', '<h1>You are logged out</h1>'));
  return html(404, page('Not found', '<h1>404</h1>'));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteBase = `http://127.0.0.1:${site.address().port}`;
// A second origin, as the "external" partner site.
const other = http.createServer((req, res) => res.writeHead(404, { 'content-type': 'text/plain' }).end('gone'));
await new Promise((r) => other.listen(0, 'localhost', r));
ext = `http://localhost:${other.address().port}`;

const { server, requests } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  downloadsPath: dlDir,
  viewport: { width: 1280, height: 800 },
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-e-test-${process.pid}`,
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
  const pathAfter = (text, label) => text.match(new RegExp(`${label}: (.+)`))?.[1].trim();

  await settings({ provider: 'openai', baseUrl: `${base}/v1`, model: 'mock-model', apiKey: '', permissionMode: 'auto', maxSteps: 6, streaming: false, summarizeAfterTokens: 0, recordRuns: false });
  const tab = await context.newPage();
  tab.on('dialog', () => {});
  await tab.goto(`${siteBase}/shop`);
  const tabId = await tabIdOf(`${siteBase}/shop`);

  // 1. Testing mode on the buggy shop.
  const r = await tool(tabId, 'test_website', { max_pages: 5, check_links: 20 });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /^Tested 3 page\(s\) on http:\/\/127\.0\.0\.1:\d+/);
  for (const expected of [
    /Console error: Cart failed to load/,
    /Uncaught JavaScript exception: .*boom on about/,
    /Broken image: Image did not load: .*\/img\/missing\.png/,
    /Failed request: GET .*\/img\/missing\.png → 404/,
    /"undefined" \/ "NaN" \/ template text on screen: Visible "undefined"/,
    /"undefined" \/ "NaN" \/ template text on screen: Visible "NaN" in: "€NaN"/,
    /Form field without a label: input name="email" placeholder="Your email"/,
    /Button without a name/,
    /Image without alt text: .*\/img\/ok\.png/,
    /Page is wider than a phone screen: At 390px wide the page is \d+px wide/,
    /Page returned an error status: The page returned HTTP 404/,
    /Broken link: .*\/missing → 404 \(link text "Old offers"\)/,
    /Broken external link: http:\/\/localhost:\d+\/gone → 404/,
  ]) assert.match(r.text, expected);
  assert.ok(!hits.includes('/logout'), 'the logout link was never opened or checked');
  assert.ok(!/Image without alt text: .*missing\.png/.test(r.text), 'a broken image is reported once, as broken');

  const reportPath = pathAfter(r.text, 'Report');
  const gifPath = pathAfter(r.text, 'GIF');
  const html = fs.readFileSync(reportPath, 'utf8');
  assert.match(html, /<h1>Website test: http:\/\/127\.0\.0\.1:\d+<\/h1>/);
  assert.match(html, /data:image\/gif;base64,R0lGODlh/, 'the GIF is embedded');
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 6, 'desktop + phone screenshot for each of 3 pages');
  const gif = decodeGif(fs.readFileSync(gifPath));
  assert.equal(gif.width, 800);
  assert.equal(gif.frames.length, 1 + 3 * 2, 'title + desktop and phone frame per page');
  assert.equal(gif.frames.at(-1).delay, 3000);
  // The report opened in a tab next to the tested one.
  let reportTab;
  for (let i = 0; i < 50 && !reportTab; i += 1) {
    reportTab = context.pages().find((p) => p.url().endsWith('/src/ui/report.html'));
    if (!reportTab) await new Promise((res) => setTimeout(res, 100));
  }
  if (!reportTab) console.log('open tabs:', await T(async () => (await chrome.tabs.query({})).map((t) => t.url)));
  assert.ok(reportTab, 'report tab opened');
  await reportTab.locator('#path').waitFor();
  assert.equal(await reportTab.locator('#path').textContent(), reportPath);
  const frame = reportTab.frameLocator('#frame');
  await frame.locator('h1', { hasText: 'Website test' }).waitFor({ timeout: 5000 });
  assert.match(await frame.locator('.card.error').textContent(), /^\d+errors$/);
  await reportTab.close();
  console.log(`1. test_website: 3 pages, ${r.text.match(/(\d+) error/)[1]} errors incl. console, exception, 404s, "undefined", a11y, mobile overflow; logout skipped; report + ${gif.frames.length}-frame GIF saved and opened`);

  // 2. gif_recorder: start, act, export.
  await tab.goto(`${siteBase}/shop`);
  let g = await tool(tabId, 'gif_recorder', { action: 'start', title: 'Open the About page' });
  assert.ok(g.ok, g.text);
  const found = await tool(tabId, 'find', { query: 'About us' });
  const ref = found.text.match(/\[(ref_\d+)\]/)[1];
  await tool(tabId, 'computer', { action: 'left_click', ref });
  await tool(tabId, 'computer', { action: 'scroll', scroll_direction: 'down' });
  await tool(tabId, 'read_page', {}); // reading is not recorded
  g = await tool(tabId, 'gif_recorder', { action: 'status' });
  assert.match(g.text, /Recording: 3 frame\(s\)/);
  g = await tool(tabId, 'gif_recorder', { action: 'export', filename: 'about flow' });
  assert.ok(g.ok && /Saved a GIF of 3 step\(s\)/.test(g.text), g.text);
  const recPath = g.text.match(/ to (.+?\.gif|\S+)(?: and |\.$)/)?.[1] || g.text.match(/to (\S+)/)[1];
  const recGif = decodeGif(fs.readFileSync(recPath.replace(/\.$/, '')));
  assert.equal(recGif.frames.length, 4, 'title + start + click + scroll');
  g = await tool(tabId, 'gif_recorder', { action: 'export' });
  assert.ok(!g.ok && /Nothing is being recorded/.test(g.text));
  console.log(`2. gif_recorder: start -> click -> scroll -> export: ${recGif.frames.length} frames, ${recGif.width}x${recGif.height}`);

  // 3. "Record every run as a GIF": a navigation run is saved and announced.
  await settings({ recordRuns: true });
  const events = await run({ tabId, prompt: 'NAV-FLOW open the page' });
  const note = events.find((e) => e.type === 'notice' && /Recording: Saved a GIF of 2 step\(s\)/.test(e.text));
  assert.ok(note, JSON.stringify(events.filter((e) => e.type === 'notice')));
  await settings({ recordRuns: false });
  console.log('3. record every run: start + navigation frames saved, notice shown in the panel');

  // 4. Panel: /test and /record are offered and send the right prompts.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html?tabId=${tabId}`);
  await panel.fill('#prompt', '/');
  await panel.locator('#slash-menu').waitFor({ state: 'visible', timeout: 5000 });
  const menu = await panel.locator('#slash-menu .slash-name').allTextContents();
  assert.ok(menu.includes('/test') && menu.includes('/record'), `menu: ${menu}`);
  const before = requests.length;
  await panel.fill('#prompt', '/test at most 2 pages');
  await panel.press('#prompt', 'Enter');
  await panel.locator('.msg.user', { hasText: 'test_website (at most 2 pages)' }).waitFor({ timeout: 5000 });
  await panel.locator('#send.stop').click(); // stop the mock run
  await panel.locator('#send:not(.stop)').waitFor({ timeout: 10000 });
  await panel.fill('#prompt', '/record');
  await panel.press('#prompt', 'Enter');
  await panel.locator('.msg.error', { hasText: 'Type what to record after /record' }).waitFor({ timeout: 5000 });
  const userMsgs = requests.slice(before).map((q) => q.messages.find((m) => m.role === 'user')?.content).filter(Boolean);
  assert.ok(userMsgs.some((c) => JSON.stringify(c).includes('test_website')), 'the /test prompt reached the model');
  await panel.close();
  console.log('4. panel: /test sends the testing prompt, /record without a task explains itself');

  console.log('\nPHASE E E2E PASS');
} finally {
  await context.close().catch(() => {});
  server.close();
  site.close();
  other.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
