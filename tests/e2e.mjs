// End-to-end: load the unpacked extension in Chromium, point it at the scripted
// mock model, run an agent task on a test page, and check the page changed.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');

const { server, requests, port } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port || port}`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-e2e-'));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !headed,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  // Keep the test host off the real MCP pipe and token file.
  env: { ...process.env, LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-test-${process.pid}`, LOCALPILOT_STATE_DIR: path.join(userDataDir, "state"), LOCALPILOT_LOG_DIR: path.join(userDataDir, "logs") },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  console.log('extension loaded:', extensionId);

  const page = await context.newPage();
  page.on('console', (m) => process.env.DEBUG && console.log('[page]', m.text()));
  await page.goto(`${base}/page`);

  await sw.evaluate(async (baseUrl) => {
    await globalThis.__localPilotTest.saveSettings({
      provider: 'openai',
      baseUrl: `${baseUrl}/v1`,
      model: 'mock-model',
      permissionMode: 'ask_site',
      approvedDomains: [],
    });
  }, base);

  const tabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url === url)?.id;
  }, `${base}/page`);
  assert.ok(tabId, 'test tab found');

  const events = await sw.evaluate(
    ({ tabId: id }) => globalThis.__localPilotTest.run({ tabId: id, prompt: 'Sign me up as Ada on the Pro plan.' }),
    { tabId },
  );

  for (const e of events) {
    if (e.type === 'tool_start') console.log(`→ ${e.name} ${JSON.stringify(e.input)}`);
    else if (e.type === 'tool_result') console.log(`  ${e.ok ? 'ok' : 'FAIL'}: ${e.content.map((c) => (c.type === 'image' ? `[image ${c.bytes}b64]` : c.text.split('\n').slice(0, 3).join(' | '))).join(' ')}`);
    else if (e.type === 'assistant') console.log(`assistant: ${e.text}`);
    else if (e.type === 'approval') console.log(`approval asked for ${e.host}`);
    else if (e.type === 'error') console.log(`ERROR: ${e.text}`);
  }

  const failed = events.filter((e) => e.type === 'tool_result' && !e.ok);
  assert.equal(failed.length, 0, `tool failures: ${JSON.stringify(failed)}`);
  assert.ok(events.some((e) => e.type === 'approval' && e.host === '127.0.0.1'), 'approval requested once for the site');
  assert.equal(events.filter((e) => e.type === 'approval').length, 1, 'approval asked only once per run');
  assert.equal(await page.textContent('#out'), 'Hello, Ada (pro)');
  const final = events.filter((e) => e.type === 'assistant').pop();
  assert.match(final.text, /Hello, Ada \(pro\)/);
  assert.deepEqual(events.filter((e) => e.type !== 'judge').at(-1), { type: 'done', reason: 'end_turn' }); // the check after the task reports last

  // The screenshot reached the model as an image part after the tool message.
  const imageSent = requests.some((r) => r.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,'))));
  assert.ok(imageSent, 'screenshot sent to model');
  // Console capture saw the page log? Capture starts at attach, so the earlier log is not required; just check the tool ran.
  assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'read_console_messages' && e.ok));

  // Permission modes: "auto" never asks; "ask_action" asks before every changing action.
  for (const [mode, expectApprovals] of [['auto', 0], ['ask_action', 3]]) {
    await page.reload();
    const modeEvents = await sw.evaluate(async ({ id, m }) => {
      globalThis.__localPilotTest.reset();
      await globalThis.__localPilotTest.saveSettings({ permissionMode: m, approvedDomains: [] });
      return globalThis.__localPilotTest.run({ tabId: id, prompt: 'Sign me up as Ada on the Pro plan.' });
    }, { id: tabId, m: mode });
    assert.equal(modeEvents.filter((e) => e.type === 'approval').length, expectApprovals, `${mode} approvals`);
    assert.equal(await page.textContent('#out'), 'Hello, Ada (pro)', `${mode} completed the task`);
    console.log(`mode ${mode}: ${expectApprovals} approvals, task done`);
  }
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ permissionMode: 'ask_site' }));

  // Real UI path: side panel page -> port -> agent, with the approval card clicked by a "user".
  await page.reload();
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ approvedDomains: [] }));
  const errors = [];
  const panel = await context.newPage();
  panel.on('pageerror', (err) => errors.push(err.message));
  await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html?tabId=${tabId}`);
  await panel.waitForSelector('#composer');
  await panel.fill('#prompt', 'Sign me up as Ada on the Pro plan.');
  await panel.press('#prompt', 'Enter');
  await panel.click('.approval button[data-decision="always"]', { timeout: 15000 });
  await panel.waitForFunction(() => [...document.querySelectorAll('.msg.assistant')].some((n) => /Hello, Ada/.test(n.textContent)), null, { timeout: 30000 });
  assert.equal(await panel.locator('details.tool').count(), 9);
  assert.equal(await panel.locator('details.tool .state.fail').count(), 0);
  assert.equal(await page.textContent('#out'), 'Hello, Ada (pro)');
  const saved = await sw.evaluate(() => globalThis.__localPilotTest.loadSettings());
  assert.deepEqual(saved.approvedDomains, ['127.0.0.1'], '"Always allow" persisted');
  await panel.locator('details.tool').nth(6).click(); // expand the screenshot card
  await panel.screenshot({ path: path.join(root, 'tests', 'sidepanel-run.png') });
  const options = await context.newPage();
  options.on('pageerror', (err) => errors.push(err.message));
  await options.goto(`chrome-extension://${extensionId}/src/ui/options.html`);
  await options.waitForFunction(() => document.getElementById('baseUrl').value.includes('/v1'));
  await options.click('#test');
  await options.waitForFunction(() => /Connected/.test(document.getElementById('test-result').textContent));
  await panel.screenshot({ path: path.join(root, 'tests', 'sidepanel.png') });

  // Per-tab conversations: a second tab gets its own empty chat, both run at the same time,
  // and reopening a tab's panel shows only that tab's history.
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ permissionMode: 'auto' }));
  const page2 = await context.newPage();
  await page2.goto(`${base}/page`);
  await page.reload();
  const tabId2 = await sw.evaluate(async () => (await chrome.tabs.query({})).filter((t) => t.url.endsWith('/page')).map((t) => t.id));
  const otherTab = tabId2.find((id) => id !== tabId);
  const panel2 = await context.newPage();
  panel2.on('pageerror', (err) => errors.push(err.message));
  await panel2.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html?tabId=${otherTab}`);
  await panel2.waitForSelector('#composer');
  assert.equal(await panel2.locator('.msg.user').count(), 0, 'second tab starts with an empty chat');
  await panel.click('#new-chat'); // the scripted mock counts steps per conversation
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 0);
  await panel.fill('#prompt', 'Sign me up as Ada on the Pro plan.');
  await panel2.fill('#prompt', 'Sign me up as Ada on the Pro plan.');
  await Promise.all([panel.press('#prompt', 'Enter'), panel2.press('#prompt', 'Enter')]);
  const finished = (p, n) => p.waitForFunction((k) => [...document.querySelectorAll('.msg.assistant')].filter((m) => /Hello, Ada/.test(m.textContent)).length >= k, n, { timeout: 60000 });
  await Promise.all([finished(panel, 1), finished(panel2, 1)]);
  assert.equal(await page.textContent('#out'), 'Hello, Ada (pro)');
  assert.equal(await page2.textContent('#out'), 'Hello, Ada (pro)');
  assert.equal(await panel.locator('.msg.user').count(), 1, 'tab 1 chat has its prompt');
  assert.equal(await panel2.locator('.msg.user').count(), 1, 'tab 2 chat has only its prompt');
  await panel2.reload();
  await panel2.waitForFunction(() => document.querySelectorAll('.msg.user').length === 1);
  assert.match(await panel2.textContent('#tab-label'), /Signup test/);
  console.log('per-tab chats: independent and concurrent');
  assert.deepEqual(errors, []);

  console.log(`\nE2E PASS: ${events.filter((e) => e.type === 'tool_start').length} tool calls, ${requests.length} model requests.`);
} finally {
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
