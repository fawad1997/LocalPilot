// Dialogs LocalPilot did not see open: a confirm() shown before the agent attached must not
// hang the tools, handle_dialog frees the tab, and a tab opened by a controlled tab is
// attached at once, so its load-time alert is caught.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-dialogs-'));
const pages = {
  '/cookies': '<title>Cookies</title><h1>Shop</h1><script>setTimeout(() => { document.title = confirm("Accept cookies?") ? "accepted" : "declined"; }, 50)</script>',
  '/opener': '<title>Opener</title><h1>Start</h1><a href="/welcome" target="_blank">Open welcome</a>',
  '/welcome': '<title>Welcome</title><h1>Welcome page</h1><script>alert("Hello there!")</script>',
};
const server = http.createServer((req, res) => {
  res.writeHead(pages[req.url] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[req.url] || 'not found');
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
context.on('page', (p) => p.on('dialog', () => {})); // leave dialogs to LocalPilot

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ permissionMode: 'auto' }));
  const tool = (tabId, name, input) => sw.evaluate(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const tabIdOf = (u) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, u);

  // 1. A confirm() open before LocalPilot attached: tools answer at once instead of hanging.
  const page = await context.newPage();
  page.goto(`${base}/cookies`).catch(() => {});
  await page.waitForTimeout(1000);
  const tabId = await tabIdOf(`${base}/cookies`);
  const t0 = Date.now();
  const stuck = await tool(tabId, 'read_page', {});
  assert.equal(stuck.ok, false);
  assert.match(stuck.text, /opened before LocalPilot connected/);
  assert.ok(Date.now() - t0 < 5000, `answered in ${Date.now() - t0} ms`);
  const shot = await tool(tabId, 'computer', { action: 'screenshot' });
  assert.equal(shot.ok, false, 'screenshot refused while blocked');
  console.log(`1. blocked page reported in ${Date.now() - t0} ms`);

  // 2. handle_dialog reloads the page; the reloaded page's confirm is now seen and answered.
  const freed = await tool(tabId, 'handle_dialog', { accept: false });
  assert.equal(freed.ok, true, freed.text);
  assert.match(freed.text, /reloaded the page/);
  assert.match(freed.text, /A confirm dialog is open: "Accept cookies\?"/, freed.text);
  const accepted = await tool(tabId, 'handle_dialog', { accept: true });
  assert.match(accepted.text, /Accepted the confirm dialog "Accept cookies\?"/);
  assert.equal(await page.title(), 'accepted');
  const text = await tool(tabId, 'get_page_text', {});
  assert.match(text.text, /Shop/);
  console.log('2. reload freed the tab; the new confirm was answered');

  // 3. A tab opened by the controlled tab is attached at once: its load-time alert is caught.
  const opener = await context.newPage();
  await opener.goto(`${base}/opener`);
  const openerId = await tabIdOf(`${base}/opener`);
  await sw.evaluate((t) => globalThis.__localPilotTest.retain(t), openerId);
  const ref = (await tool(openerId, 'find', { query: 'Open welcome' })).text.match(/\[(ref_\d+)\]/)[1];
  await tool(openerId, 'computer', { action: 'left_click', ref });
  await opener.waitForTimeout(1500);
  const welcomeId = await tabIdOf(`${base}/welcome`);
  assert.ok(welcomeId, 'welcome tab opened');
  const nav = await tool(welcomeId, 'get_page_text', {});
  assert.equal(nav.ok, true, nav.text);
  assert.match(nav.text, /Welcome page/);
  const seen = await tool(welcomeId, 'navigate', { url: `${base}/opener` });
  assert.equal(seen.ok, true, seen.text);
  console.log('3. new tab attached at once; its alert did not block it');
  console.log('dialog e2e: all passed');
} finally {
  await context.close();
  server.close();
}
