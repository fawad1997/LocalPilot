// Phase A reliability/safety: captures survive detach, chats survive a SW restart,
// confirm() is not auto-accepted, shadow-DOM find + custom-element values, MCP
// cancel / progress / unfocused window, bridge.json cleanup. Needs host:install.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-a-'));
const jobsDir = path.join(tmp, 'Jobs');
fs.mkdirSync(path.join(jobsDir, 'China'), { recursive: true });
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({ roots: [{ name: 'jobs', path: jobsDir, writable: true }], scripts: [] }));
const env = {
  ...process.env,
  LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-a-test-${process.pid}`,
  LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
  LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
  LOCALPILOT_HOST_CONFIG: configFile,
};

const { server } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env,
});

let child;
try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const tool = (tabId, name, input) => sw.evaluate(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const tabIdOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  await sw.evaluate((b) => globalThis.__localPilotTest.saveSettings({ provider: 'openai', baseUrl: `${b}/v1`, model: 'mock-model', apiKey: '', permissionMode: 'auto', bossBaseUrl: b, recipeDelayScale: 0.01 }), base);

  // 1. Captures and console survive a debugger detach.
  const page = await context.newPage();
  page.on('dialog', () => {}); // stop Playwright auto-dismissing dialogs; LocalPilot must handle them
  await page.goto(`${base}/page`);
  const tabId = await tabIdOf(`${base}/page`);
  await tool(tabId, 'capture_start', { url_pattern: '/page' });
  await tool(tabId, 'navigate', { url: `${base}/page` });
  await sw.evaluate((t) => globalThis.__localPilotTest.detachTab(t), tabId);
  assert.equal(await sw.evaluate((t) => globalThis.__localPilotTest.isAttached(t), tabId), false);
  const cap = await tool(tabId, 'capture_read', { url_pattern: '/page' });
  assert.match(cap.text, /Join the club/, 'captured body still there after detach');
  const cons = await tool(tabId, 'read_console_messages', {});
  assert.match(cons.text, /page ready/, 'console history still there after detach');
  console.log('1. captures + console survive detach');

  // 2. A side-panel chat survives a service-worker restart (memory dropped, storage kept).
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html?tabId=${tabId}`);
  await panel.waitForSelector('#composer');
  await panel.fill('#prompt', 'Sign me up as Ada on the Pro plan.');
  await panel.press('#prompt', 'Enter');
  await panel.waitForFunction(() => [...document.querySelectorAll('.msg.assistant')].some((n) => /Hello, Ada/.test(n.textContent)), null, { timeout: 60000 });
  await panel.waitForTimeout(800); // debounced save
  await sw.evaluate(() => globalThis.__localPilotTest.dropMemory());
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('details.tool').length === 9, null, { timeout: 10000 });
  assert.equal(await panel.locator('.msg.user').count(), 1);
  console.log('2. chat restored after SW memory loss');

  // 3. confirm() stays open for the model; alert() is accepted and reported.
  await page.goto(`${base}/confirm`);
  const found = await tool(tabId, 'find', { query: 'Delete account' });
  const delRef = found.text.match(/\[(ref_\d+)\]/)[1];
  const click = await tool(tabId, 'computer', { action: 'left_click', ref: delRef });
  assert.match(click.text, /A confirm dialog is open: "Delete everything\?"/);
  const blocked = await tool(tabId, 'read_page', {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /handle_dialog/);
  const answered = await tool(tabId, 'handle_dialog', { accept: false });
  assert.match(answered.text, /Dismissed the confirm dialog/);
  assert.equal(await page.textContent('#out'), 'kept', 'confirm was NOT auto-accepted');
  const saveRef = (await tool(tabId, 'find', { query: 'Save' })).text.match(/\[(ref_\d+)\]/)[1];
  const alerted = await tool(tabId, 'computer', { action: 'left_click', ref: saveRef });
  assert.match(alerted.text, /alert: "Saved!"/);
  assert.equal(await page.textContent('#out'), 'alerted');
  console.log('3. confirm left to the model (dismissed -> "kept"), alert auto-accepted');

  // 4. find pierces shadow DOM; form_input works on custom elements.
  await page.goto(`${base}/components`);
  const email = await tool(tabId, 'find', { query: 'email' });
  assert.match(email.text, /textbox "Email.*\[ref_\d+\]/, `found inside shadow root: ${email.text}`);
  const emailRef = email.text.split('\n').find((l) => /textbox/.test(l)).match(/\[(ref_\d+)\]/)[1];
  const filled = await tool(tabId, 'form_input', { ref: emailRef, value: 'ada@example.com' });
  assert.equal(filled.ok, true, filled.text);
  assert.equal(await page.evaluate(() => document.querySelector('shadow-field').shadowRoot.querySelector('input').value), 'ada@example.com');
  const nick = await tool(tabId, 'find', { query: 'Nickname' });
  const set = await tool(tabId, 'form_input', { ref: nick.text.match(/\[(ref_\d+)\]/)[1], value: 'Ada' });
  assert.equal(set.ok, true, set.text);
  assert.equal(await page.textContent('#custom'), 'nick:Ada');
  console.log('4. shadow-DOM find + custom element value');

  // 5. MCP: unfocused dedicated window, cancellation, progress.
  child = spawn(process.execPath, [path.join(root, 'host', 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  const notes = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else notes.push(msg);
  });
  let nextId = 1;
  const send = (obj) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  const rpc = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return { id, done: new Promise((resolve) => waiting.set(id, resolve)) };
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }).done;
  const userWindow = await sw.evaluate(async (t) => (await chrome.tabs.get(t)).windowId, tabId);
  const nav = await rpc('tools/call', { name: 'navigate', arguments: { url: `${base}/page` } }).done;
  assert.ok(!nav.result.isError, JSON.stringify(nav));
  const mcpWin = await sw.evaluate(async () => {
    const [g] = await chrome.tabGroups.query({ title: 'LocalPilot MCP' });
    const [t] = await chrome.tabs.query({ groupId: g.id });
    const w = await chrome.windows.get(t.windowId);
    return { id: w.id, focused: w.focused, state: w.state };
  });
  assert.notEqual(mcpWin.id, userWindow, 'MCP works in its own window');
  assert.equal(mcpWin.focused, false, 'MCP window does not take focus');

  const t0 = Date.now();
  const slow = rpc('tools/call', { name: 'computer', arguments: { action: 'wait', duration: 10 } });
  await new Promise((r) => setTimeout(r, 600));
  send({ method: 'notifications/cancelled', params: { requestId: slow.id, reason: 'user pressed Ctrl+C' } });
  const tc = Date.now();
  const after = await rpc('tools/call', { name: 'tabs_context', arguments: {} }).done;
  const cancelMs = Date.now() - tc;
  assert.ok(Date.now() - t0 < 5000, `queue freed quickly after cancel (${Date.now() - t0} ms)`);
  assert.match(after.result.content[0].text, /Tabs in this window/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(waiting.has(slow.id), 'no response is sent for a cancelled request');
  waiting.delete(slow.id);

  const boss = await rpc('tools/call', { name: 'boss_collect_jobs', arguments: { query: 'Python', city: 'Wuhan', max_jobs: 15, details: 0, run_import: false }, _meta: { progressToken: 'tok1' } }).done;
  assert.ok(!boss.result.isError, boss.result.content[0].text);
  const progress = notes.filter((n) => n.method === 'notifications/progress' && n.params.progressToken === 'tok1');
  assert.ok(progress.length >= 2, `progress notifications: ${progress.length}`);
  assert.ok(progress.some((p) => /jobs collected/.test(p.params.message)));
  console.log(`5. MCP: own unfocused window, cancel frees the queue (next call answered in ${cancelMs} ms), ${progress.length} progress updates`);

  child.kill();
  child = null;
  const bridgeFile = path.join(env.LOCALPILOT_STATE_DIR, 'bridge.json');
  assert.ok(fs.existsSync(bridgeFile));
  await context.close();
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!fs.existsSync(bridgeFile), 'bridge.json removed when the host exits');
  console.log('6. bridge.json cleaned up on host exit');

  console.log('\nPHASE A E2E PASS');
} finally {
  child?.kill();
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
