// Builds examples/demo/: test_website on a deliberately buggy shop served on this PC, so every
// check in the testing mode fires. Runs offline, with no AI model (the tool is called directly).
// The real-website demos are in examples/real (recorded in Chrome) and examples/demo-ai
// (LocalPilot's own agent with your model: npm run demo:ai). Run: npm run demo
import { chromium } from 'playwright-core';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'examples', 'demo');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-demo-'));

// --- the buggy shop ---
const page = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1e293b}header{background:#0f766e;color:#fff;padding:14px 24px}main{padding:24px;max-width:900px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{border:1px solid #e2e8f0;border-radius:10px;padding:12px}.card img{width:100%;height:120px;object-fit:cover;background:#f1f5f9}
.price{color:#b91c1c;font-weight:600}nav a{margin-right:16px;color:#0f766e}.promo{width:1100px;background:#fef3c7;padding:10px}</style>${head}</head><body>${body}</body></html>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const shop = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const html = (status, body) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  const nav = '<nav><a href="/">Home</a><a href="/about">About</a><a href="/sale">Sale</a><a href="/logout">Log out</a></nav>';
  if (url.pathname === '/') {
    return html(200, page('Demo Shop', `<header><b>Demo Shop</b></header><main>${nav}<h1>Spring collection</h1>
<div class="promo">Free shipping on orders over €50, this banner is too wide for phones</div>
<div class="grid">
<div class="card"><img src="/img/1.png" alt="Linen shirt"><h3>Linen shirt</h3><p class="price">€39.00</p></div>
<div class="card"><img src="/img/2.png"><h3>Canvas bag</h3><p class="price">€NaN</p></div>
<div class="card"><img src="/img/missing.png" alt="Sun hat"><h3>Sun hat</h3><p class="price">Price: undefined</p></div>
</div>
<h2>Newsletter</h2><form><input name="email" placeholder="you@example.com"> <button type="button"><svg width="16" height="16"><path d="M2 8h12" stroke="#000"/></svg></button></form></main>`,
    '<script>fetch("/api/cart").then(r => { if (!r.ok) console.error("Cart failed to load: HTTP " + r.status); })</script>'));
  }
  if (url.pathname === '/about') return html(200, page('About', `<header><b>Demo Shop</b></header><main>${nav}<h1>About us</h1><p>Small shop, big ideas.</p></main>`, '<script>setTimeout(() => { window.user.name.toUpperCase(); }, 20)</script>'));
  if (url.pathname === '/sale') return html(500, page('Server error', `<header><b>Demo Shop</b></header><main>${nav}<h1>Something went wrong</h1></main>`));
  if (/^\/img\/[12]\.png$/.test(url.pathname)) return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
  if (url.pathname === '/api/cart') return res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
  return html(404, page('Not found', '<h1>404</h1>'));
});
// Port 8080 keeps the demo files tidy; any free port works.
await new Promise((r) => shop.once('error', () => shop.listen(0, '127.0.0.1', r)).listen(8080, '127.0.0.1', r));
const shopUrl = `http://127.0.0.1:${shop.address().port}/`;

const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  // A real 1280x900 window and no Playwright viewport emulation: test_website's phone check
  // clears its emulation afterwards, which must return to this same size.
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--window-size=1280,900'],
  downloadsPath: path.join(tmp, 'downloads'),
  viewport: null,
});

const copy = (from, name) => {
  fs.copyFileSync(from, path.join(out, name));
  console.log(`  wrote examples/demo/${name} (${Math.round(fs.statSync(from).size / 1024)} KB)`);
};
const after = (text, label) => text.match(new RegExp(`${label}: (.+)`))?.[1].trim();

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const T = (fn, arg) => sw.evaluate(fn, arg);
  const tool = async (tabId, name, input) => {
    const r = await T(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
    if (!r.ok) throw new Error(`${name}: ${r.text}`);
    return r.text;
  };
  await T((p) => globalThis.__localPilotTest.saveSettings(p), { permissionMode: 'auto', recipeDelayScale: 1 });
  const tab = await context.newPage();
  const tabIdOf = async (u) => T(async (url) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(url)).id, u);

  // Screenshot of the saved report file (not the viewer tab, whose header shows the local path).
  const shootReport = async (htmlFile, name) => {
    for (let i = 0; i < 30; i += 1) {
      const viewer = context.pages().find((x) => x.url().endsWith('/src/ui/report.html'));
      if (viewer) {
        await viewer.close();
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const p = await context.newPage();
    await p.setViewportSize({ width: 1100, height: 1400 });
    await p.goto(pathToFileURL(htmlFile).href);
    await p.waitForTimeout(800);
    await p.screenshot({ path: path.join(out, name) });
    await p.close();
    console.log(`  wrote examples/demo/${name}`);
  };
  console.log('1. Testing the buggy demo shop…');
  await tab.goto(shopUrl);
  let text = await tool(await tabIdOf(shopUrl), 'test_website', { max_pages: 5, check_links: 20 });
  fs.writeFileSync(path.join(out, 'buggy-shop-result.txt'), `${text.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://localhost:8080').replace(/\n(Report|GIF): .*/g, '').replace(/\nThe report is open in a new tab\./, '')}\n`);
  copy(after(text, 'Report'), 'buggy-shop-report.html');
  copy(after(text, 'GIF'), 'buggy-shop-test.gif');
  await shootReport(path.join(out, 'buggy-shop-report.html'), 'buggy-shop-report.png');

  console.log('Done.');
} finally {
  await context.close().catch(() => {});
  shop.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
