// Retries, fallback models, resume after failure, bot-check handoff, CAPTCHA click
// guard, and the JSONL diagnostics log. Requires node host/install.mjs (for logs).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-res-'));
const logDir = path.join(tmp, 'logs');
const { server, stats } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-res-test-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: logDir,
  },
});

const types = (events) => events.map((e) => e.type);

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`${base}/page`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/page`);
  const settings = (patch) => sw.evaluate((p) => globalThis.__localPilotTest.saveSettings(p), patch);
  const run = (prompt, extra = {}) => sw.evaluate((a) => globalThis.__localPilotTest.run(a), { tabId, prompt, ...extra });
  const reset = () => sw.evaluate(() => globalThis.__localPilotTest.reset());
  await settings({ provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'secret-key-123', permissionMode: 'auto', maxRetries: 3, fallbackModels: '' });

  // 1. Transient 503s are retried (Retry-After honoured) and the task completes.
  await settings({ model: 'flaky-model' });
  let ev = await run('Sign me up as Ada on the Pro plan.');
  assert.ok(ev.some((e) => e.type === 'status' && /Retrying in 1s \(1\/3\)/.test(e.text)), 'retry status shown');
  assert.deepEqual(ev.at(-1), { type: 'done', reason: 'end_turn' });
  assert.equal(await page.textContent('#out'), 'Hello, Ada (pro)');
  console.log('1. flaky model: retried twice, task done');

  // 2. A dead model falls back to the next model.
  await reset();
  await page.reload();
  await settings({ model: 'dead-model', maxRetries: 1, fallbackModels: 'mock-model' });
  ev = await run('Sign me up as Ada on the Pro plan.');
  assert.ok(ev.some((e) => e.type === 'notice' && /fallback model "mock-model"/.test(e.text)));
  assert.deepEqual(ev.at(-1), { type: 'done', reason: 'end_turn' });
  console.log('2. dead model: fell back to mock-model, task done');

  // 3. All attempts fail: error says so, offers Retry, and resuming keeps the conversation.
  await reset();
  await page.reload();
  await settings({ model: 'dead-model', maxRetries: 1, fallbackModels: '' });
  ev = await run('Sign me up as Ada on the Pro plan.');
  const err = ev.find((e) => e.type === 'error');
  assert.match(err.text, /HTTP 502[\s\S]*Gave up after 2 attempt\(s\)/);
  assert.deepEqual(ev.at(-1), { type: 'done', reason: 'error', canRetry: true });
  await settings({ model: 'mock-model' });
  ev = await run(null); // what the Retry button sends
  assert.deepEqual(ev.at(-1), { type: 'done', reason: 'end_turn' });
  assert.equal(await page.textContent('#out'), 'Hello, Ada (pro)');
  console.log('3. exhausted: Retry offered, resumed run finished the task');

  // 4. Bot check: the agent pauses, the user solves it, the agent continues.
  await reset();
  ev = await run('CAPTCHA-FLOW: open the site');
  const ver = ev.find((e) => e.type === 'verification');
  assert.ok(ver, 'verification requested');
  assert.match(ver.kind, /cloudflare|human/);
  assert.match(ev.find((e) => e.type === 'assistant').text, /the user completed it/);
  console.log(`4. bot check (${ver.kind}): paused, user continued, run resumed`);

  // 4b. The user declines: the tool fails with a clear message.
  await reset();
  ev = await run('CAPTCHA-FLOW: open the site', { verification: 'deny' });
  assert.match(ev.find((e) => e.type === 'tool_result').content[0].text, /Stopped at a .* check/);
  console.log('4b. bot check declined: stopped cleanly');

  // 5. CAPTCHA widgets are never clicked (pause disabled so the model reaches the click).
  await reset();
  await settings({ pauseOnBotCheck: false });
  ev = await run('CLICK-FLOW: send the form');
  const results = ev.filter((e) => e.type === 'tool_result');
  assert.match(results[0].content[0].text, /BOT CHECK DETECTED/);
  assert.equal(results[2].ok, false);
  assert.match(results[2].content[0].text, /Refusing to click a CAPTCHA/);
  await settings({ pauseOnBotCheck: true });
  console.log('5. click on CAPTCHA widget refused');

  // 6. Diagnostics log: JSONL in the logs folder, no secrets, no image data.
  await sw.evaluate(() => globalThis.__localPilotTest.flushLogs());
  await new Promise((r) => setTimeout(r, 2500));
  await sw.evaluate(() => globalThis.__localPilotTest.flushLogs());
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(logDir, files[0]), 'utf8');
  const entries = raw.trim().split('\n').map((l) => JSON.parse(l));
  const seen = new Set(entries.map((e) => e.type));
  for (const t of ['sw_start', 'run_start', 'model_request', 'model_retry', 'model_fallback', 'tool_call', 'run_error', 'run_end', 'bot_check', 'bot_check_decision', 'bot_check_click_refused']) {
    assert.ok(seen.has(t), `log has ${t}`);
  }
  assert.ok(!raw.includes('secret-key-123'), 'API key never logged');
  assert.ok(!/"data":"\/9j\//.test(raw), 'screenshot pixels never logged');
  const failed = entries.filter((e) => e.type === 'model_request' && !e.ok);
  assert.ok(failed.some((e) => e.status === 502 && /routed attempt/.test(e.error)));
  console.log(`6. log: ${entries.length} events, types: ${[...seen].join(', ')}`);

  console.log(`\nRESILIENCE E2E PASS (${stats.failures} simulated model failures)`);
} finally {
  await context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
