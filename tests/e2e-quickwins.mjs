// 0.8.0 quick wins: what changed after each action, forgiving select options, tool aliases,
// HTTP status on navigate, web_search (DuckDuckGo, Bing and Google markup, bot-check page),
// reconnecting after the debugger drops, pc_search, and in an agent run: notes on repeated
// calls and do-nothing clicks, and a progress note at the step limit.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-qw-'));
const jobsDir = path.join(tmp, 'Jobs');
fs.mkdirSync(path.join(jobsDir, 'Europe', 'Applications', 'Acme'), { recursive: true });
fs.writeFileSync(path.join(jobsDir, 'Europe', 'Applications', 'Acme', 'CV_Fawad.pdf'), '%PDF-1.4 fake');
fs.writeFileSync(path.join(jobsDir, 'Europe', 'notes.md'), '# Notes\nApplied to Acme on Monday.\nWaiting for the recruiter.\n');
fs.mkdirSync(path.join(jobsDir, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(jobsDir, 'node_modules', 'x', 'cv.txt'), 'skipped');
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({ roots: [{ name: 'jobs', path: jobsDir, writable: true }], scripts: [] }));

const { server, requests } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 1280, height: 800 },
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-qw-test-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
    LOCALPILOT_HOST_CONFIG: configFile,
  },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const T = (fn, arg) => sw.evaluate(fn, arg);
  const settings = (patch) => T((p) => globalThis.__localPilotTest.saveSettings(p), patch);
  const tool = (tabId, name, input) => T(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const tabIdOf = (u) => T(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, u);
  const refIn = (txt, pattern) => txt.split('\n').find((l) => pattern.test(l))?.match(/\[(ref_\d+)\]/)?.[1];

  await settings({ provider: 'openai', baseUrl: `${base}/v1`, model: 'mock-model', apiKey: '', permissionMode: 'auto', maxSteps: 6, streaming: false, summarizeAfterTokens: 0, recordRuns: false });
  const page = await context.newPage();
  await page.goto(`${base}/qw/form`);
  const tabId = await tabIdOf(`${base}/qw/form`);
  const outline = (await tool(tabId, 'read_page', { filter: 'interactive' })).text;

  // 1. What changed after actions.
  const opened = await tool(tabId, 'computer', { action: 'left_click', ref: refIn(outline, /button "Open dialog"/) });
  assert.match(opened.text, /Page changes:\nAppeared \(\d+\):[\s\S]*button "Close"/, opened.text);
  const nothing = await tool(tabId, 'computer', { action: 'left_click', ref: refIn(outline, /button "Does nothing"/) });
  assert.match(nothing.text, /No visible change on the page\./);
  await page.keyboard.press('Escape');
  const typed = await tool(tabId, 'computer', { action: 'type', ref: refIn(outline, /textbox "Search"/), text: 'shoes' });
  assert.match(typed.text, /Appeared[\s\S]*link "shoes suggestion"/, typed.text);
  const popped = await tool(tabId, 'computer', { action: 'left_click', ref: refIn(outline, /link "Pop out"/) });
  assert.match(popped.text, /A new tab opened: \d+ .*\/qw\/next\?popped\. Use switch_tab/, popped.text);
  const moved = await tool(tabId, 'computer', { action: 'left_click', ref: refIn(outline, /link "Next page"/) });
  assert.match(moved.text, /Now on a new page: "Next" .*\/qw\/next\nVisible controls:\n.*link "Back to form"/, moved.text);
  console.log('1. change reports: dialog appeared, "no visible change", typed suggestion, new tab, new page');

  // 2. Forgiving select options; an ambiguous one is refused with the candidates.
  await page.goto(`${base}/qw/form`);
  const form = (await tool(tabId, 'read_page', { filter: 'interactive' })).text;
  const fill = (label, value) => tool(tabId, 'form_input', { ref: refIn(form, new RegExp(`combobox "${label}`)), value });
  assert.match((await fill('Phone type', 'Mobile')).text, /Set ref_\d+ to "Mobile Phone" \(the closest option to "Mobile"\)/);
  assert.match((await fill('Nationality', 'pakistan')).text, /"Pakistani"/);
  assert.match((await fill('Region', 'Guangdong')).text, /"Guangdong Sheng"/);
  const ambiguous = await fill('Contact by', 'Work');
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.text, /"Work" fits several options .*Work Email, Work Phone/);
  assert.deepEqual(await page.evaluate(() => ['ptype', 'nat', 'region'].map((id) => document.getElementById(id).value)), ['mobile', 'Pakistani', 'Guangdong Sheng']);
  console.log('2. form_input: Mobile → Mobile Phone, pakistan → Pakistani, Guangdong → Guangdong Sheng; "Work" refused as ambiguous');

  // 3. Aliases models use, and the page's HTTP status on navigate.
  const found = await tool(tabId, 'computer', { action: 'find', query: 'Open dialog' });
  assert.match(found.text, /button "Open dialog" \[ref_\d+\]/);
  const scrolled = await tool(tabId, 'down', {});
  assert.match(scrolled.text, /Scrolled down/);
  const missing = await tool(tabId, 'navigate', { url: `${base}/qw/no-such-page` });
  assert.match(missing.text, /HTTP 404 \(not found\): this address does not exist\. Do not guess addresses/);
  const fine = await tool(tabId, 'goto', { url: `${base}/qw/form` });
  assert.doesNotMatch(fine.text, /HTTP/);
  console.log('3. aliases: computer "find", "down", "goto"; navigate reports HTTP 404');

  // 4. web_search in each engine's markup; a bot-check page is reported, not returned as results.
  await settings({ searchUrl: `${base}/qw/search?q={q}` });
  const ddg = await tool(tabId, 'search', { q: 'Dr Aleem FAST email' });
  assert.match(ddg.text, /Web results for "Dr Aleem FAST email" \(custom\):\n1\. Dr\. Muhammad Aleem - FAST\n {3}https:\/\/example\.org\/muhammad-aleem\n {3}Associate Professor, email m\.aleem@example\.org/, ddg.text);
  assert.doesNotMatch(ddg.text, /Sponsored/);
  assert.match(ddg.text, /2\. Faculty list/);
  await settings({ searchUrl: `${base}/qw/search-bing?q={q}` });
  const bing = await tool(tabId, 'web_search', { query: 'x' });
  assert.match(bing.text, /1\. Bing result one\n {3}https:\/\/example\.net\/bing-one\n {3}Snippet for the first Bing result\./, bing.text);
  await settings({ searchUrl: `${base}/qw/search-google?q={q}` });
  const google = await tool(tabId, 'web_search', { query: 'x', max_results: 1 });
  assert.match(google.text, /1\. Google result one\n {3}https:\/\/example\.com\/google-one\n {3}This is the snippet text/, google.text);
  assert.doesNotMatch(google.text, /2\. /, 'max_results respected');
  const redirected = await tool(tabId, 'web_search', { query: 'x' });
  assert.match(redirected.text, /3\. Google result three\n {3}https:\/\/example\.edu › people\n {3}\(link through custom: http:\/\/127\.0\.0\.1:\d+\/goto\?url=CAESabc123\)/, redirected.text);
  await settings({ searchUrl: `${base}/qw/search-blocked?q={q}` });
  const blocked = await tool(tabId, 'web_search', { query: 'x' });
  assert.match(blocked.text, /No web results for "x" \(custom: showed a bot check on "x - search" http:\/\/127\.0\.0\.1:\d+\/qw\/search-blocked\?q=x\)/);
  const leftOpen = await T(async () => (await chrome.tabs.query({})).filter((t) => /\/qw\/search/.test(t.url)).length);
  assert.equal(leftOpen, 0, 'search tabs are closed');
  await settings({ searchUrl: '' });
  console.log('4. web_search: DuckDuckGo, Bing and Google markup parsed (ads and engine links dropped), bot check reported, tabs closed');

  // 5. The debugger drops (as when Chrome detaches it): read actions reconnect and retry; a click does not.
  await T((t) => chrome.debugger.detach({ tabId: t }), tabId);
  const shot = await tool(tabId, 'computer', { action: 'screenshot', marks: false });
  assert.equal(shot.ok, true, shot.text);
  assert.equal(shot.images, 1);
  await T((t) => chrome.debugger.detach({ tabId: t }), tabId);
  const click = await tool(tabId, 'computer', { action: 'left_click', coordinate: [5, 5] });
  assert.equal(click.ok, false);
  assert.match(click.text, /connection to the tab dropped during this action and has been restored/);
  assert.equal((await tool(tabId, 'computer', { action: 'screenshot', marks: false })).ok, true, 'connected again');
  console.log('5. reconnect: screenshot retried after the debugger dropped; a click is not repeated');

  // 6. pc_search: by name pattern and by text, skipping node_modules.
  const byName = await tool(tabId, 'pc_search', { root: 'jobs', name: 'cv*' });
  assert.equal(byName.ok, true, byName.text);
  assert.match(byName.text, /^1 match\(es\) in .*Jobs/);
  assert.match(byName.text, /Europe[\\/]Applications[\\/]Acme[\\/]CV_Fawad\.pdf {2}\(13 B, \d{4}-\d\d-\d\d\)/);
  const byText = await tool(tabId, 'pc_search', { root: 'jobs', text: 'recruiter' });
  assert.match(byText.text, /Europe[\\/]notes\.md .*\n {4}line 3: Waiting for the recruiter\./);
  const none = await tool(tabId, 'pc_search', { root: 'jobs', name: '*.docx' });
  assert.match(none.text, /^0 match\(es\)[\s\S]*Nothing found/);
  console.log('6. pc_search: cv* found the PDF, "recruiter" found line 3 of notes.md, node_modules skipped');

  // 7. Agent run: repeated address, do-nothing click twice, then the step limit's progress note.
  const before = requests.length;
  const events = await T(async (o) => {
    globalThis.__localPilotTest.reset();
    return globalThis.__localPilotTest.run(o);
  }, { tabId, prompt: 'LOOP-FLOW find the form' });
  const results = events.filter((e) => e.type === 'tool_result').map((e) => e.content.map((b) => b.text || '').join(''));
  assert.equal(results.length, 6, results.join('\n---\n'));
  assert.match(results[0], /HTTP 404/);
  assert.doesNotMatch(results[0], /already opened/);
  assert.match(results[1], /Note: you already opened this address once in this conversation/);
  assert.match(results[4], /No visible change on the page\./);
  assert.doesNotMatch(results[4], /changed nothing/);
  assert.match(results[5], /This left click has now changed nothing 2 times\. Do not repeat it/);
  const progressReq = requests.slice(before).find((q) => /STEP LIMIT REACHED/.test(q.messages[0].content));
  assert.ok(progressReq && !progressReq.tools?.length, 'progress note asked for without tools');
  assert.ok(events.some((e) => e.type === 'assistant' && /^Progress note:\nPROGRESS: \/qw\/missing is a 404/.test(e.text)));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.reason, 'max_steps');
  // "continue" sends the note back to the model as part of the history.
  const beforeContinue = requests.length;
  await T((o) => globalThis.__localPilotTest.run(o), { tabId, prompt: 'continue' });
  const continued = requests.slice(beforeContinue).find((q) => q.tools?.length);
  assert.ok(continued.messages.some((m) => m.role === 'assistant' && String(m.content).includes('Progress note (step limit reached):\nPROGRESS:')), 'note is in the history');
  console.log('7. agent run: repeat noted, second do-nothing click noted, progress note written at the step limit');
  console.log('quick wins e2e: all passed');
} finally {
  await context.close();
  server.close();
}
