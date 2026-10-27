// CAPTCHA solving end to end: a Turnstile-shaped widget whose checkbox lives in a real
// cross-origin iframe is clicked with CDP input, its token is set, and the agent continues
// without pausing. Also checks the captcha_solve tool (detect + solve) on its own.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-captcha-'));
const { server } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-captcha-test-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A stuck step should fail the test, not hang it.
const watchdog = setTimeout(async () => {
  console.error('CAPTCHA E2E: timed out after 90 s');
  await context.close().catch(() => {});
  process.exit(2);
}, 90000);
watchdog.unref?.();

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  console.log('extension loaded');
  const page = await context.newPage();
  await page.goto(`${base}/page`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/page`);
  const settings = (patch) => sw.evaluate((p) => globalThis.__localPilotTest.saveSettings(p), patch);
  const tool = (id, name, input = {}) => sw.evaluate((a) => globalThis.__localPilotTest.tool(a.tabId, a.name, a.input), { tabId: id, name, input });
  await settings({ provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'test-key', model: 'mock-model', permissionMode: 'auto', judgeRuns: false, captchaSolver: true });

  // 1. The agent navigates to a Turnstile page; the check is solved for it, with no pause.
  console.log('1. running the agent on the turnstile page…');
  const events = await sw.evaluate((a) => globalThis.__localPilotTest.run(a), { tabId, prompt: 'CAPTCHA-SOLVE-FLOW: open the site' });
  console.log('   run finished');
  assert.equal(events.filter((e) => e.type === 'verification').length, 0, 'no hand-over was needed');
  const nav = events.find((e) => e.type === 'tool_result' && e.name === 'navigate');
  assert.match(nav.content[0].text, /solved it automatically/, nav.content[0].text);
  const text = events.find((e) => e.type === 'tool_result' && e.name === 'get_page_text');
  assert.match(text.content[0].text, /Welcome to the real site/, 'the page was read after the check passed');
  assert.equal(await page.evaluate(() => window.__solved), true, 'the checkbox was really clicked');
  assert.equal(await page.evaluate(() => document.title), 'Real site');
  assert.ok((await page.evaluate(() => document.querySelector('input[name="cf-turnstile-response"]')?.value || '')).length > 20, 'success token was set');
  console.log('1. Turnstile-shaped check solved in a cross-origin iframe; run continued without pausing');

  // 2. The captcha_solve tool: detect on a fresh tab, then solve it.
  console.log('2. opening a fresh tab…');
  const fresh = await sw.evaluate(async (u) => {
    const t = await chrome.tabs.create({ url: u });
    await new Promise((r) => setTimeout(r, 1200));
    return t.id;
  }, `${base}/turnstile`);
  console.log('   tab', fresh, 'detecting…');
  const detect = await tool(fresh, 'captcha_solve', { action: 'detect' });
  console.log('   detect:', detect.text);
  assert.equal(detect.ok, true, detect.text);
  assert.match(detect.text, /Cloudflare Turnstile|Cloudflare challenge/, detect.text);
  console.log('   solving…');
  const solved = await tool(fresh, 'captcha_solve', {});
  console.log('   solve:', solved.text);
  const token = await sw.evaluate(async (id) => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => document.querySelector('input[name="cf-turnstile-response"]')?.value || '',
    });
    return result;
  }, fresh);
  assert.ok(token.length > 20, 'captcha_solve set the token');
  await sw.evaluate((id) => chrome.tabs.remove(id), fresh);
  console.log('2. captcha_solve: detect named the check, solve passed it');

  // 3. With solving off, the same page is treated as a hand-over, not clicked.
  await settings({ captchaSolver: false });
  const fresh2 = await sw.evaluate(async (u) => {
    const t = await chrome.tabs.create({ url: u });
    await new Promise((r) => setTimeout(r, 1200));
    return t.id;
  }, `${base}/turnstile`);
  const blocked = await tool(fresh2, 'read_page', {});
  assert.equal(blocked.ok, false, blocked.text);
  assert.match(blocked.text, /Stopped at a .* check|BOT CHECK DETECTED/, blocked.text);
  await sw.evaluate((id) => chrome.tabs.remove(id), fresh2);
  await settings({ captchaSolver: true });
  console.log('3. solving off: never clicks, hands the check over as before');

  console.log('\nCAPTCHA E2E PASS');
} finally {
  await sleep(200);
  await context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
