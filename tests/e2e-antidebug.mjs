// Sites that react to the debugger reading their console: a page that reloads (or blanks)
// itself is detected, console capture is turned off for that site and remembered, and the
// page loads again and stays. Forgetting the site in storage turns capture back on.
//
// Playwright attaches to every page it sees and enables console capture itself, which would
// trip the trap on its own. So Chromium is started directly and only the extension's service
// worker is driven, over a raw DevTools WebSocket.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-antidebug-'));

// devtools-detector style check: console.table is slow only while a debugger serializes console calls.
const trap = (onCaught) => `<script>
const big = Array.from({ length: 500 }, (_, i) => ({ a: i, b: 'x'.repeat(20), c: [1, 2, 3] }));
setInterval(() => {
  let t = performance.now(); for (let i = 0; i < 20; i++) console.log(big); const log = performance.now() - t;
  t = performance.now(); for (let i = 0; i < 20; i++) console.table(big); const table = performance.now() - t;
  console.clear();
  if (table > Math.max(50, log * 10)) ${onCaught};
}, 500);
</script>`;
const loads = { '/trap': 0, '/blank': 0 };
const pages = {
  '/trap': `<title>Trap</title><h1>Reloading shop</h1>${trap('location.reload()')}`,
  '/blank': `<title>Blank</title><h1>Blanking shop</h1>${trap("location.replace('about:blank')")}`,
};
const server = http.createServer((req, res) => {
  if (req.url in loads) loads[req.url] += 1;
  res.writeHead(pages[req.url] ? 200 : 404, { 'content-type': 'text/html' });
  res.end(pages[req.url] || 'not found');
}).listen(0);
const port = server.address().port;

const debugPort = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(chromium.executablePath(), [
  ...(process.argv.includes('--headed') ? [] : ['--headless=new']),
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
  `--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', 'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let sw;
  for (let i = 0; i < 60 && !sw; i++) {
    await sleep(250);
    sw = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.url.endsWith('/src/background.js'))).catch(() => null);
  }
  assert.ok(sw, 'extension service worker found');
  ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d); waiting.delete(d.id); };
  // Runs an async function body in the service worker and returns its JSON result.
  const inSw = (body, arg, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    setTimeout(() => reject(new Error(`service worker call timed out: ${body.slice(0, 80)} ${JSON.stringify(arg)}`)), timeoutMs);
    waiting.set(id, (d) => (d.result?.exceptionDetails ? reject(new Error(d.result.exceptionDetails.exception?.description)) : resolve(d.result?.result?.value)));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async (arg) => { ${body} })(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true } }));
  });
  // A worker that is still starting may never answer the first call: ask until it does.
  for (let i = 0; ; i++) {
    const ready = await inSw('return typeof globalThis.__localPilotTest === "object";', undefined, 2000).catch(() => false);
    if (ready) break;
    assert.ok(i < 15, 'extension service worker ready');
  }
  await inSw('await globalThis.__localPilotTest.saveSettings({ permissionMode: "auto" });');
  const tool = (tabId, name, input = {}) => inSw('return globalThis.__localPilotTest.tool(arg.tabId, arg.name, arg.input).catch((e) => ({ ok: false, text: String(e.message) }));', { tabId, name, input });
  const quietHosts = () => inSw('return (await chrome.storage.local.get("quietHosts")).quietHosts || [];');
  const openTab = (url) => inSw('const t = await chrome.tabs.create({ url: arg }); await new Promise((r) => setTimeout(r, 1000)); return t.id;', url);
  const tabUrl = (tabId) => inSw('return (await chrome.tabs.get(arg)).url;', tabId);
  const waitFor = async (check, ms, what) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await check()) return;
    assert.fail(`timed out waiting for ${what}`);
  };

  // 1. A page that reloads itself once LocalPilot attaches: learned, and it stops reloading.
  const trapUrl = `http://127.0.0.1:${port}/trap`;
  const trapTab = await openTab(trapUrl);
  assert.equal(loads['/trap'], 1, 'no reloads before LocalPilot attaches');
  await tool(trapTab, 'get_page_text');
  await waitFor(async () => (await quietHosts()).includes('127.0.0.1'), 15000, '127.0.0.1 to be learned');
  await sleep(2500);
  const settled = loads['/trap'];
  await sleep(3000);
  assert.equal(loads['/trap'], settled, `page kept reloading (${settled} → ${loads['/trap']})`);
  const after = await tool(trapTab, 'get_page_text');
  assert.equal(after.ok, true, after.text);
  assert.match(after.text, /Reloading shop/);
  assert.match(after.text, /127\.0\.0\.1 reloads or blanks itself.*Console capture is now off/s);
  const again = await tool(trapTab, 'get_page_text');
  assert.doesNotMatch(again.text, /reloads or blanks itself/, 'notice is given once');
  console.log(`1. self-reloading page detected after ${settled - 1} reloads; it stopped`);

  // 2. A page that blanks itself: learned, and LocalPilot loads the page again.
  const blankUrl = `http://localhost:${port}/blank`;
  const blankTab = await openTab(blankUrl);
  await tool(blankTab, 'get_page_text');
  await waitFor(async () => (await quietHosts()).includes('localhost'), 15000, 'localhost to be learned');
  await sleep(3000);
  assert.equal(await tabUrl(blankTab), blankUrl, 'page loaded again after blanking');
  const blankText = await tool(blankTab, 'get_page_text');
  assert.match(blankText.text, /Blanking shop/);
  console.log('2. self-blanking page detected and loaded again');

  // 3. Remembered: a fresh attachment to a learned site starts without console capture.
  await inSw('await globalThis.__localPilotTest.detachTab(arg);', trapTab);
  const before = loads['/trap'];
  await tool(trapTab, 'navigate', { url: trapUrl });
  await sleep(4000);
  assert.equal(loads['/trap'], before + 1, 'learned site does not reload on a fresh attachment');
  console.log('3. learned site stays quiet after re-attaching');

  // 4. Forgetting the site (Settings → Forget) turns console capture back on there.
  await inSw('await chrome.storage.local.set({ quietHosts: ["localhost"] });');
  await inSw('await globalThis.__localPilotTest.detachTab(arg);', trapTab);
  const beforeForget = loads['/trap'];
  await tool(trapTab, 'get_page_text');
  await waitFor(async () => (await quietHosts()).includes('127.0.0.1'), 15000, '127.0.0.1 to be learned again');
  assert.ok(loads['/trap'] > beforeForget, 'console capture was back on until the site was learned again');
  console.log('4. forgotten site is watched again and re-learned');
  console.log('anti-debug e2e: all passed');
} finally {
  ws?.close();
  chrome.kill();
  server.close();
}
