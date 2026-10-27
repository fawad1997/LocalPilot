// MCP window and sessions: MCP clients (standing in for Claude Code sessions) share one
// "LocalPilot MCP" window, found again after the MCP tab or session storage is lost. Each session
// gets its own tab, cannot use the others', brings its tab to the front for its calls, and frees
// it when it ends. The user's own window is never used.
// Requires the native host to be registered (node host/install.mjs).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-w-'));
const env = {
  ...process.env,
  LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-w-test-${process.pid}`,
  LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
  LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
};

const { server } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env,
});

// Minimal MCP client over stdio: one per Claude Code session.
const clients = [];
async function startClient() {
  const child = spawn(process.execPath, [path.join(root, 'host', 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  clients.push(child);
  const waiting = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const rpc = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => waiting.set(id, resolve));
  };
  const call = async (name, args = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    if (res.error) throw new Error(res.error.message);
    return res.result;
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'localpilot');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  // The host starts when the extension connects; wait for the relay.
  let status;
  for (let i = 0; i < 120; i += 1) {
    status = await call('localpilot_status');
    if (!status.isError) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(!status.isError, `status: ${textOf(status)}`);
  // A call that must succeed; returns its text.
  const ok = async (name, args = {}) => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}: ${textOf(r)}`);
    return textOf(r);
  };
  const ownTab = async () => Number(/^\* (\d+):/m.exec(await ok('tabs_context'))[1]);
  return { child, call, ok, ownTab };
}
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const A = await startClient();
  const info = () => sw.evaluate(async () => {
    const groups = await chrome.tabGroups.query({ title: 'LocalPilot MCP' });
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return { groups: groups.map((g) => g.windowId), windows: wins.length };
  });
  const tab = (id) => sw.evaluate((t) => chrome.tabs.get(t), id);

  const page = await context.newPage();
  await page.goto(`${base}/page`);
  const userWindow = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).windowId, `${base}/page`);

  // 1. First call creates the shared window.
  await A.ok('navigate', { url: `${base}/page` });
  const a = await info();
  assert.equal(a.groups.length, 1);
  assert.notEqual(a.groups[0], userWindow);
  console.log('1. MCP call opened one shared window');

  // 2. The MCP tab dies (as after a restart); the next call reuses the same window.
  const winId = a.groups[0];
  await sw.evaluate(async () => {
    const g = (await chrome.tabGroups.query({ title: 'LocalPilot MCP' }))[0];
    const [t] = await chrome.tabs.query({ groupId: g.id });
    await chrome.tabs.create({ windowId: g.windowId, url: 'about:blank', active: false }); // keeps the window alive
    await chrome.tabs.remove(t.id);
  });
  await A.ok('navigate', { url: `${base}/page` });
  const b = await info();
  assert.deepEqual(b.groups, [winId]);
  assert.equal(b.windows, a.windows, 'no extra window');
  console.log('2. window reused after the MCP tab was lost');

  // 3. Lost session storage: the window is found again by its tab group.
  await sw.evaluate(async () => {
    await chrome.storage.session.clear();
    const g = (await chrome.tabGroups.query({ title: 'LocalPilot MCP' }))[0];
    const [t] = await chrome.tabs.query({ groupId: g.id });
    const extra = await chrome.tabs.create({ windowId: g.windowId, url: 'about:blank', active: false });
    await chrome.tabs.group({ tabIds: [extra.id], groupId: g.id }); // the group outlives the MCP tab
    await chrome.tabs.remove(t.id);
  });
  await A.ok('navigate', { url: `${base}/page` });
  const c = await info();
  assert.deepEqual(c.groups, [winId]);
  assert.equal(c.windows, a.windows);
  console.log('3. window found again via its tab group');

  // 4. A second session gets its own tab in the same window and leaves the first one alone.
  await A.ok('navigate', { url: `${base}/page?session=a` });
  const tabA = await A.ownTab();
  const B = await startClient();
  await B.ok('navigate', { url: `${base}/page?session=b` });
  const tabB = await B.ownTab();
  assert.notEqual(tabA, tabB, 'each session has its own tab');
  assert.equal((await tab(tabA)).url, `${base}/page?session=a`, "B's navigate did not move A's tab");
  assert.equal((await tab(tabA)).windowId, winId);
  assert.equal((await tab(tabB)).windowId, winId, 'both tabs live in the shared window');
  assert.equal((await info()).windows, a.windows, 'no window per session');
  console.log(`4. two sessions, two tabs (${tabA}, ${tabB}) in one window`);

  // 5. The other session's tab is marked and off limits.
  const ctxA = await A.ok('tabs_context');
  assert.match(ctxA, new RegExp(`^\\* ${tabA}:`, 'm'));
  assert.match(ctxA, new RegExp(`^  ${tabB}: .*another Claude Code session`, 'm'));
  for (const [name, args] of [['switch_tab', { tab_id: tabB }], ['tabs_close', { tab_id: tabB }], ['get_page_text', { tab_id: tabB }]]) {
    const r = await A.call(name, args);
    assert.ok(r.isError && /belongs to another Claude Code session/.test(textOf(r)), `${name}: ${textOf(r)}`);
  }
  assert.equal((await tab(tabB)).url, `${base}/page?session=b`);
  console.log("5. a session cannot switch to, close or read another session's tab");

  // 6. Sessions take turns at the front of the window, so every screenshot is drawn.
  for (const [S, id, other] of [[A, tabA, tabB], [B, tabB, tabA], [A, tabA, tabB]]) {
    const r = await S.call('computer', { action: 'screenshot' });
    assert.ok(!r.isError && r.content.some((x) => x.type === 'image'), textOf(r));
    assert.equal((await tab(id)).active, true, 'the calling session’s tab is in front');
    assert.equal((await tab(other)).active, false);
  }
  console.log('6. each call brings its own tab to the front; screenshots work for both sessions');

  // 7. When a session ends its tab is freed, and the next session reuses it.
  const saved = () => sw.evaluate(async () => Object.keys((await chrome.storage.session.get('mcpSessions')).mcpSessions || {}).length);
  assert.equal(await saved(), 2);
  B.child.kill();
  for (let i = 0; i < 40 && (await saved()) !== 1; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await saved(), 1, 'the ended session was dropped');
  const groupTabs = () => sw.evaluate(async () => (await chrome.tabs.query({ groupId: (await chrome.tabGroups.query({ title: 'LocalPilot MCP' }))[0].id })).length);
  const before = await groupTabs();
  const C = await startClient();
  await C.ok('navigate', { url: `${base}/page?session=c` });
  assert.notEqual(await C.ownTab(), tabA, "a new session never takes a live session's tab");
  assert.equal(await groupTabs(), before, 'no new tab: the freed one was reused');
  assert.equal((await tab(tabA)).url, `${base}/page?session=a`);
  console.log("7. an ended session's tab is reused by the next session");

  // 8. The short-lived "My current window" setting is ignored if it is still saved.
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ mcpWindowMode: 'current' }));
  await page.bringToFront();
  const D = await startClient();
  await D.ok('navigate', { url: `${base}/page?session=d` });
  assert.equal((await tab(await D.ownTab())).windowId, winId, 'still the shared window');
  const active = await sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, userWindow);
  assert.equal(active, `${base}/page`, "the user's window is untouched");
  console.log("8. an old 'current window' setting is ignored: the shared window is used");

  console.log('\nMCP WINDOW E2E PASS');
} finally {
  for (const child of clients) child.kill();
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
