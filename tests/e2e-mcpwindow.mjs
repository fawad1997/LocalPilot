// End-to-end for phase 2: an MCP client (standing in for Claude Code) launches
// host/mcp-server.mjs over stdio and drives the browser through the extension.
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

// Minimal MCP client over stdio.
const child = spawn(process.execPath, [path.join(root, 'host', 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
const notifications = [];
let nextId = 1;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  } else notifications.push(msg);
});
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}
async function callTool(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  return res.result;
}
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'localpilot');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // The host starts when the extension connects; wait for the relay.
  let status;
  const t0 = Date.now();
  for (let i = 0; i < 120; i += 1) {
    status = await callTool('localpilot_status');
    if (!status.isError) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(!status.isError, `status: ${textOf(status)}`);
  const info = () => sw.evaluate(async () => {
    const groups = await chrome.tabGroups.query({ title: 'LocalPilot MCP' });
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return { groups: groups.map((g) => g.windowId), windows: wins.length };
  });

  const page = await context.newPage();
  await page.goto(`${base}/page`);
  const userWindow = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).windowId, `${base}/page`);

  // 1. First call creates the shared window.
  await callTool('navigate', { url: `${base}/page` });
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
  await callTool('navigate', { url: `${base}/page` });
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
  await callTool('navigate', { url: `${base}/page` });
  const c = await info();
  assert.deepEqual(c.groups, [winId]);
  assert.equal(c.windows, a.windows);
  console.log('3. window found again via its tab group');

  // 4. 'current' mode: background tab in the user's window.
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ mcpWindowMode: 'current' }));
  await sw.evaluate(async (w) => {
    const g = (await chrome.tabGroups.query({ title: 'LocalPilot MCP' }))[0];
    for (const t of await chrome.tabs.query({ groupId: g.id })) await chrome.tabs.remove(t.id).catch(() => {});
  }, winId);
  await page.bringToFront();
  await callTool('navigate', { url: `${base}/page` });
  const d = await sw.evaluate(async () => {
    const g = (await chrome.tabGroups.query({ title: 'LocalPilot MCP' }));
    return g.map((x) => x.windowId);
  });
  assert.ok(d.includes(userWindow), `tab group in the user window: ${d} vs ${userWindow}`);
  const active = await sw.evaluate(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].url, userWindow);
  assert.equal(active, `${base}/page`, 'the tab you were on stays active');
  console.log("4. 'current' mode opens a background tab in the user's window");

  console.log('\nMCP WINDOW E2E PASS');
} finally {
  child?.kill();
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
