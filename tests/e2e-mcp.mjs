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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-mcp-'));
const env = {
  ...process.env,
  LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-mcp-test-${process.pid}`,
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
  console.log(`${textOf(status)} (after ${Date.now() - t0} ms)`);

  const { result: list } = await rpc('tools/list', {});
  const names = list.tools.map((t) => t.name);
  for (const n of ['navigate', 'computer', 'read_page', 'find', 'form_input', 'get_page_text', 'capture_start', 'capture_read', 'boss_collect_jobs']) {
    assert.ok(names.includes(n), `tool ${n} listed`);
  }
  assert.ok(!names.includes('pc_write_file'), 'pc_* tools are not exposed over MCP');
  assert.ok(list.tools.every((t) => t.inputSchema?.type === 'object'));

  // Drive a full task.
  await callTool('navigate', { url: `${base}/page` });
  await callTool('capture_start', { url_pattern: '/page' });
  const tree = textOf(await callTool('read_page', { filter: 'interactive' }));
  const ref = (re) => tree.split('\n').find((l) => re.test(l))?.match(/\[(ref_\d+)\]/)[1];
  await callTool('form_input', { ref: ref(/textbox "Name"/), value: 'Grace' });
  await callTool('form_input', { ref: ref(/combobox/), value: 'Pro' });
  await callTool('computer', { action: 'left_click', ref: ref(/button "Submit"/) });
  const text = textOf(await callTool('get_page_text'));
  assert.match(text, /Hello, Grace \(pro\)/);
  const shot = await callTool('computer', { action: 'screenshot' });
  const img = shot.content.find((c) => c.type === 'image');
  assert.ok(img && img.mimeType === 'image/jpeg' && img.data.length > 1000, 'screenshot returned as MCP image');
  const bad = await callTool('form_input', { ref: 'ref_9999', value: 'x' });
  assert.equal(bad.isError, true, 'tool errors come back as isError');

  // Calls ran in a dedicated tab inside the "LocalPilot MCP" group.
  const grouped = await sw.evaluate(async () => {
    const groups = await chrome.tabGroups.query({ title: 'LocalPilot MCP' });
    if (!groups.length) return [];
    return (await chrome.tabs.query({ groupId: groups[0].id })).map((t) => t.url);
  });
  assert.ok(grouped.some((u) => u.endsWith('/page')), `MCP tab grouped: ${grouped}`);

  // A wrong token is rejected by the relay.
  const bridge = JSON.parse(fs.readFileSync(path.join(env.LOCALPILOT_STATE_DIR, 'bridge.json'), 'utf8'));
  const net = await import('node:net');
  const rejected = await new Promise((resolve) => {
    const s = net.connect(bridge.pipe, () => s.write(`${JSON.stringify({ type: 'auth', token: 'nope' })}\n`));
    s.setEncoding('utf8');
    s.on('data', (d) => resolve(JSON.parse(d.split('\n')[0]).ok === false));
    s.on('error', () => resolve(true));
  });
  assert.ok(rejected, 'bad token rejected');

  console.log(`\nMCP E2E PASS: ${names.length} tools listed, form submitted via MCP, screenshot ${img.data.length} b64 chars.`);
} finally {
  child.kill();
  await context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
