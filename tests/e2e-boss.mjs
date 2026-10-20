// End-to-end for the PC bridge + BOSS flow against a mock BOSS site.
// Requires the native host to be registered (node host/install.mjs).
// The host is pointed at a temporary jobs folder via LOCALPILOT_HOST_CONFIG,
// which Chromium passes on to the host process.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_IMPORT = 'D:\\Personal Projects\\Jobs\\import-manual-jobs.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-boss-'));
const jobsDir = path.join(tmp, 'Jobs');
fs.mkdirSync(path.join(jobsDir, 'China'), { recursive: true });
if (fs.existsSync(REAL_IMPORT)) fs.copyFileSync(REAL_IMPORT, path.join(jobsDir, 'import-manual-jobs.mjs'));
else fs.copyFileSync(path.join(root, 'tests', 'fixtures', 'import-manual-jobs.mjs'), path.join(jobsDir, 'import-manual-jobs.mjs'));
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  roots: [{ name: 'jobs', path: jobsDir, writable: true }],
  scripts: [{ name: 'import-manual-jobs', root: 'jobs', file: 'import-manual-jobs.mjs', description: 'build drafts' }],
}));

const { server } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: { ...process.env, LOCALPILOT_HOST_CONFIG: configFile, LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-test-${process.pid}`, LOCALPILOT_STATE_DIR: path.join(tmp, "state"), LOCALPILOT_LOG_DIR: path.join(tmp, "logs") },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;

  const page = await context.newPage();
  await page.goto(`${base}/page`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/page`);
  await sw.evaluate((b) => globalThis.__localPilotTest.saveSettings({
    provider: 'openai', baseUrl: `${b}/v1`, model: 'mock-model', permissionMode: 'ask_site', approvedDomains: [],
    bossBaseUrl: b, recipeDelayScale: 0.01, maxSteps: 5,
  }), base);

  const events = await sw.evaluate((id) => globalThis.__localPilotTest.run({ tabId: id, prompt: 'Find BOSS jobs for 全栈工程师 in Wuhan and save a CSV.' }), tabId);
  for (const e of events) {
    if (e.type === 'tool_start') console.log(`→ ${e.name} ${JSON.stringify(e.input)}`);
    else if (e.type === 'tool_result') console.log(`  ${e.ok ? 'ok' : 'FAIL'}: ${e.content[0]?.text}`);
    else if (['notice', 'assistant', 'error', 'approval'].includes(e.type)) console.log(`${e.type}: ${e.text || e.host}`);
  }

  assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'boss_collect_jobs' && e.ok), 'boss tool succeeded');
  assert.equal(events.filter((e) => e.type === 'approval').length, 1, 'one approval for zhipin + PC files');
  assert.ok(events.some((e) => e.type === 'notice' && /code 37/.test(e.text)), 'paused on code 37 and told the user');

  const today = new Date().toISOString().slice(0, 10);
  const stem = `boss-全栈工程师-武汉-${today}`;
  const csv = fs.readFileSync(path.join(jobsDir, 'China', `${stem}.csv`), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV has BOM');
  assert.ok(csv.includes('job040~~') && !csv.includes('job041~~'), 'exactly 40 jobs');
  assert.ok(csv.startsWith('\uFEFFtitle,company,salary,city'), 'CSV header');

  const draft = JSON.parse(fs.readFileSync(path.join(jobsDir, 'China', `${stem}-draft.json`), 'utf8'));
  assert.equal(draft.length, 40);
  assert.match(draft[0].descriptionText, /岗位职责/, 'detail description fetched');
  assert.match(draft[5].descriptionText, /^\[Summary/, 'summary used beyond details limit');
  assert.equal(draft[0].location, '武汉 洪山区 光谷, China');

  const imported = fs.readdirSync(path.join(jobsDir, 'China')).filter((f) => /-china-manual-/.test(f));
  assert.equal(imported.length, 1, `import-manual-jobs produced output: ${imported}`);
  const importedJobs = JSON.parse(fs.readFileSync(path.join(jobsDir, 'China', imported[0]), 'utf8'));
  assert.equal(importedJobs.length, 40);
  assert.equal(importedJobs[0].source, 'BOSS Zhipin');

  // Side panel shows the PC bridge as connected.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html`);
  await panel.waitForFunction(() => document.getElementById('pc-badge').textContent === 'PC: on', null, { timeout: 10000 });

  console.log(`\nBOSS E2E PASS: ${importedJobs.length} jobs -> ${imported[0]}`);
} finally {
  await context.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
