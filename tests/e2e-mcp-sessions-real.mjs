// Two MCP sessions in a real (headed) Chromium, which only draws the front tab of each window.
// Headless Chromium and Playwright-driven pages draw every tab, so they cannot show this.
// The browser is started directly, off-screen; only the extension's service worker gets a
// debugger (to set the test up). Each session navigates and takes a screenshot in turn, and
// the debugger is let go of the tabs behind the front one between turns (as after an idle
// release). Without bringing the caller's tab to the front, those screenshots fail.
// Requires the native host to be registered (node host/install.mjs).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const EXTENSION_ID = 'eaopjpgoeolndjijbelfidajiciihllh'; // from the manifest key
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-real-'));
const env = {
  ...process.env,
  LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-real-test-${process.pid}`,
  LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
  LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
};
const { server } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(chromium.executablePath(), [`--user-data-dir=${path.join(tmp, 'profile')}`, `--disable-extensions-except=${root}`, `--load-extension=${root}`,
  '--remote-debugging-port=0', '--window-position=-2600,-2600', '--window-size=1000,760', '--no-first-run', '--no-default-browser-check', 'about:blank'], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = [];
let ws;

// Minimal MCP client over stdio: one per Claude Code session.
function startClient() {
  const child = spawn(process.execPath, [path.join(root, 'host', 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  clients.push(child);
  const waiting = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  // Resolves to null when the browser does not answer within ms.
  const call = (name, args = {}, ms = 30000) => Promise.race([rpc('tools/call', { name, arguments: args }).then((r) => r.result), sleep(ms).then(() => null)]);
  return { rpc, call };
}

try {
  // A debugger on the extension's service worker only, not on any page.
  let port;
  for (let i = 0; i < 100 && !port; i += 1) {
    try {
      port = fs.readFileSync(path.join(tmp, 'profile', 'DevToolsActivePort'), 'utf8').split('\n');
    } catch {
      await sleep(100);
    }
  }
  ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
  await new Promise((r) => ws.addEventListener('open', r));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const n = ++seq;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    target = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`));
    if (!target) await sleep(150);
  }
  assert.ok(target, 'extension service worker');
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  const sw = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value;
  for (let i = 0; i < 100 && (await sw('typeof chrome.windows')) !== 'object'; i += 1) await sleep(100);

  // The off-screen start window becomes the LocalPilot MCP window.
  const win = await sw(`(async () => {
    const [w] = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
    await chrome.storage.session.set({ mcpWindowId: w.id });
    const g = await chrome.tabs.group({ tabIds: [w.tabs[0].id], createProperties: { windowId: w.id } });
    await chrome.tabGroups.update(g, { title: 'LocalPilot MCP' });
    return w.id;
  })()`);

  const A = startClient();
  const B = startClient();
  for (const c of [A, B]) await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    const status = await A.call('localpilot_status', {}, 5000);
    up = !!status && !status.isError;
    if (!up) await sleep(250);
  }
  assert.ok(up, 'bridge connected');

  const pages = ['/page', '/confirm', '/components', '/long'];
  const own = {};
  for (let round = 0; round < 4; round += 1) {
    for (const [name, S] of [['A', A], ['B', B]]) {
      // As after an idle release: the debugger lets go of the tabs behind the front one.
      await sw(`(async () => { for (const t of await chrome.tabs.query({ windowId: ${win}, active: false })) await chrome.debugger.detach({ tabId: t.id }).catch(() => {}); })()`);
      const nav = await S.call('navigate', { url: `${base}${pages[(round + (name === 'B' ? 2 : 0)) % pages.length]}?${name}${round}` });
      assert.ok(nav && !nav.isError, `${name} navigate: ${JSON.stringify(nav)}`);
      const t0 = Date.now();
      const shot = await S.call('computer', { action: 'screenshot' });
      assert.ok(shot && !shot.isError && shot.content.some((c) => c.type === 'image'), `round ${round} ${name}: ${shot ? shot.content[0].text : 'no answer within 30 s'}`);
      own[name] = await sw(`(async () => (await chrome.tabs.query({ windowId: ${win}, active: true }))[0].id)()`);
      console.log(`round ${round} ${name}: screenshot in ${Date.now() - t0} ms (tab ${own[name]} in front)`);
    }
    assert.notEqual(own.A, own.B, 'each session has its own tab');
  }
  console.log('\nMCP SESSIONS (REAL BROWSER) E2E PASS');
} finally {
  try {
    ws?.close();
  } catch {
    // already closed
  }
  for (const child of clients) child.kill();
  browser.kill();
  await sleep(1000);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
