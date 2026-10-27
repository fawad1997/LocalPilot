// Bot-check detection from page text: a long page that only mentions "verify you are human"
// (a guide, a README, LocalPilot's own site) is not a check; the same words in a popup over
// the page, or on a short page, are. Real checks found by title or widget still count.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-botcheck-'));
const { server } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: { ...process.env, LOCALPILOT_NO_RELAY: '1', LOCALPILOT_STATE_DIR: path.join(tmp, 'state'), LOCALPILOT_LOG_DIR: path.join(tmp, 'logs') },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  // Report checks in the tool result instead of pausing for the user.
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ pauseOnBotCheck: false, captchaSolver: false }));
  const page = await context.newPage();
  await page.goto(`${base}/page`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/page`);
  const navigate = (p) => sw.evaluate(([t, u]) => globalThis.__localPilotTest.tool(t, 'navigate', { url: u }), [tabId, `${base}${p}`]);

  const cases = [
    ['/mentions', null, 'long page quoting the words (one copy in a hidden popup)'],
    ['/mentions-popup', 'human-verification', 'the words in a popup over a long page'],
    ['/short-check', 'human-verification', 'a short page asking to verify'],
    ['/widget', 'recaptcha', 'a reCAPTCHA widget'],
    ['/page', null, 'an ordinary page'],
  ];
  for (const [p, kind, label] of cases) {
    const res = await navigate(p);
    assert.equal(res.ok, true, res.text);
    const found = /BOT CHECK DETECTED \(([\w-]+)\)/.exec(res.text)?.[1] || null;
    assert.equal(found, kind, `${p} (${label}): ${res.text}`);
    console.log(`${kind ? 'check   ' : 'no check'} ${p.padEnd(16)} ${label}`);
  }
  console.log('\nBOT CHECK E2E PASS');
} finally {
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
