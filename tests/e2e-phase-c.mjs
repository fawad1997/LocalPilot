// Phase C: recipe registry, job-board recipes on mock Liepin / 51job / Zhaopin / LinkedIn sites,
// de-duplication, saved tasks + schedule (alarm fired by the test), apply_assist (fills, uploads,
// never submits, logs only after the user confirms), plan-first mode, context summarization,
// and streaming replies. Needs host:install.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional: a local jobs folder with your own scripts. The fixtures keep this suite runnable
// on a fresh clone (set LOCALPILOT_JOBS_DIR to use your own).
const REAL_JOBS = process.env.LOCALPILOT_JOBS_DIR || path.join(os.homedir(), 'LocalPilot', 'Jobs');
const FIXTURES = path.join(root, 'tests', 'fixtures');
const jobsTool = (rel) => {
  const local = path.join(REAL_JOBS, rel);
  return fs.existsSync(local) ? local : path.join(FIXTURES, path.basename(rel));
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-c-'));
const jobsDir = path.join(tmp, 'Jobs');
const today = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.join(jobsDir, 'China', 'Applications', 'Acme'), { recursive: true });
fs.mkdirSync(path.join(jobsDir, 'lib'), { recursive: true });
fs.copyFileSync(jobsTool('import-manual-jobs.mjs'), path.join(jobsDir, 'import-manual-jobs.mjs'));
fs.copyFileSync(jobsTool('lib/tracker-utils.mjs'), path.join(jobsDir, 'lib', 'tracker-utils.mjs'));
fs.copyFileSync(path.join(root, 'host', 'jobs-scripts', 'log-application.mjs'), path.join(jobsDir, 'log-application.mjs'));
fs.writeFileSync(path.join(jobsDir, 'China', 'Applications', 'Acme', 'CV_Fawad.pdf'), Buffer.alloc(2048, 1));
fs.writeFileSync(path.join(jobsDir, 'cv_data.json'), JSON.stringify({
  personal: { name: 'Test Person', email: 'test@example.com', phone: '+31 600000000', location: '1000 AA, Amsterdam, Netherlands', linkedin: 'testperson', github: 'testgh' },
  summary: 'Full stack engineer, Python and React.',
}));
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({
  roots: [{ name: 'jobs', path: jobsDir, writable: true }],
  scripts: [
    { name: 'import-manual-jobs', root: 'jobs', file: 'import-manual-jobs.mjs', description: 'build drafts' },
    { name: 'log-application', root: 'jobs', file: 'log-application.mjs', internal: true, description: 'log a submitted application' },
  ],
}));

const { server, requests, stats } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;

// Already-known jobs: a ledger and an earlier China import.
fs.writeFileSync(path.join(jobsDir, 'processed-jobs.json'), JSON.stringify({
  version: 1,
  jobs: {
    4000000003: { company: 'LI Company 3', title: 'Full Stack Engineer', source: 'linkedin' },
    'some-url-key': { company: 'LI Company 5', title: 'Full Stack Engineer', source: 'linkedin' },
  },
}));
fs.writeFileSync(path.join(jobsDir, 'China', `old-china-manual-2026-01-01.json`), JSON.stringify([
  { id: 'liepin-1002', title: '全栈工程师 L2', companyName: '猎聘公司2', location: '武汉 洪山区, China', link: '' },
  { id: 'abc', title: 'x', companyName: 'y', location: 'z', link: `${base}/51/51005.html` },
  { id: 'def', title: '前端工程师 Z3', companyName: '智联公司3', location: '武汉 江夏区, China', link: '' },
]));

const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-c-test-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
    LOCALPILOT_HOST_CONFIG: configFile,
  },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  const T = (fn, arg) => sw.evaluate(fn, arg);
  const tool = (tabId, name, input) => T(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const run = (opts) => T(async (o) => {
    globalThis.__localPilotTest.reset();
    return globalThis.__localPilotTest.run(o);
  }, opts);
  const settings = (patch) => T((p) => globalThis.__localPilotTest.saveSettings(p), patch);
  const tabIdOf = (u) => T(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, u);
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(jobsDir, rel), 'utf8').replace(/^\uFEFF/, ''));

  await settings({
    provider: 'openai', baseUrl: `${base}/v1`, model: 'mock-model', apiKey: '', permissionMode: 'auto', maxSteps: 12, streaming: true, summarizeAfterTokens: 0,
    recipeDelayScale: 0.01, liepinBaseUrl: base, job51BaseUrl: base, zhaopinBaseUrl: `${base}/zp`, linkedinBaseUrl: base,
  });

  const page = await context.newPage();
  page.on('dialog', () => {});
  await page.goto(`${base}/page`);
  const tabId = await tabIdOf(`${base}/page`);

  // 1. Registry + streaming: every recipe is offered to the model and named in the system prompt; replies stream.
  let events = await run({ tabId, prompt: 'SCHEDULED-FLOW registry check' });
  assert.ok(events.some((e) => e.type === 'done' && e.reason === 'end_turn'), 'run finished');
  const last = requests.at(-1);
  const names = last.tools.map((t) => t.function.name);
  for (const n of ['boss_collect_jobs', 'liepin_collect_jobs', 'job51_collect_jobs', 'zhaopin_collect_jobs', 'linkedin_collect_jobs', 'apply_assist']) {
    assert.ok(names.includes(n), `tool ${n} offered`);
    assert.ok(last.messages[0].content.includes(n), `system prompt names ${n}`);
  }
  assert.ok(!last.tools.find((t) => t.function.name === 'pc_run_script').function.parameters.properties.name.enum.includes('log-application'), 'internal script hidden from the model');
  assert.ok(last.stream === true && stats.streamed > 0, 'requests stream');
  const deltas = events.filter((e) => e.type === 'assistant_delta' && e.text);
  assert.ok(deltas.length >= 2, `streamed deltas: ${deltas.length}`);
  assert.equal(deltas.map((d) => d.text).join('').trim(), events.filter((e) => e.type === 'assistant').at(-1).text, 'deltas add up to the final reply');
  const internal = await tool(tabId, 'pc_run_script', { name: 'log-application', args: ['add', '{}'] });
  assert.ok(!internal.ok && /internal/.test(internal.text), 'the model cannot run log-application');
  console.log(`1. registry: 6 recipes offered and in the system prompt; ${deltas.length} streamed deltas`);

  // 2. Job boards with de-duplication.
  let r = await tool(tabId, 'liepin_collect_jobs', { query: '全栈工程师', city: 'Wuhan', max_jobs: 25, details: 3 });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Collected 25 new jobs/);
  assert.match(r.text, /Skipped 1 job/);
  assert.match(r.text, /Import OK/);
  let draft = readJson(`China/liepin-全栈工程师-武汉-${today}-draft.json`);
  assert.equal(draft.length, 25);
  assert.equal(draft[0].id, 'liepin-1001');
  assert.ok(!draft.some((d) => d.id === 'liepin-1002'), 'seen job skipped');
  assert.equal(draft.at(-1).id, 'liepin-1026');
  assert.match(draft[0].descriptionText, /猎聘职位 1001/, 'detail page read');
  assert.match(draft[5].descriptionText, /^\[Summary from the Liepin/);
  assert.equal(draft[0].location, '武汉 洪山区, China');
  assert.equal(draft[0].source, 'Liepin');
  const csv = fs.readFileSync(path.join(jobsDir, 'China', `liepin-全栈工程师-武汉-${today}.csv`), 'utf8');
  assert.ok(csv.startsWith('\uFEFFtitle,company,salary,city'), 'CSV header');
  // A second run skips everything imported by the first one.
  r = await tool(tabId, 'liepin_collect_jobs', { query: '全栈工程师', city: 'Wuhan', max_jobs: 10, details: 0, run_import: false });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Collected 4 new jobs/, r.text);
  assert.match(r.text, /Skipped 26 job/, r.text);
  console.log('2a. liepin: 25 new (1 known skipped), descriptions + import; rerun: 4 new, 26 skipped');

  r = await tool(tabId, 'job51_collect_jobs', { query: 'Python', city: '武汉', max_jobs: 30, run_import: false });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Collected 19 new jobs .*19 with full description/, r.text);
  draft = readJson(`China/job51-Python-武汉-${today}-draft.json`);
  assert.ok(!draft.some((d) => d.link.endsWith('/51/51005.html')), 'seen link skipped');
  assert.equal(draft[0].companyName, '前程公司1有限公司');
  assert.match(draft[0].descriptionText, /51job description 1/);
  assert.equal(draft[0].location, '武汉 东湖新技术开发区, China');

  r = await tool(tabId, 'zhaopin_collect_jobs', { query: '前端', city: 'wuhan', details: 2, run_import: false });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Collected 15 new jobs .*2 with full description/, r.text);
  draft = readJson(`China/zhaopin-前端-武汉-${today}-draft.json`);
  assert.ok(!draft.some((d) => d.companyName === '智联公司3'), 'company+title+location match skipped');
  assert.match(draft[0].descriptionText, /智联职位 701/);

  r = await tool(tabId, 'linkedin_collect_jobs', { query: 'Full Stack Engineer', city: 'Amsterdam, Netherlands', details: 2, run_import: false });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Collected 18 new jobs .*2 with full description/, r.text);
  assert.match(r.text, /Skipped 2 job/);
  draft = readJson(`Netherlands/linkedin-Full-Stack-Engineer-Amsterdam,-Netherlands-${today}-draft.json`);
  assert.equal(draft[0].id, '4000000001');
  assert.equal(draft[0].link, `${base}/jobs/view/4000000001/`);
  assert.ok(!draft.some((d) => ['4000000003', '4000000005'].includes(d.id)), 'ledger id and company+title skipped');
  assert.match(draft[0].descriptionText, /^Job 4000000001: build React \+ Python products/);
  assert.match(draft[0].descriptionText, /visa sponsorship and relocation/);
  assert.equal(draft[0].location, 'Amsterdam, North Holland, Netherlands');
  // Full LinkedIn fields from the job page, in the shape the CV / fit skills read.
  const d0 = draft[0];
  assert.equal(d0.seniorityLevel, 'Mid-Senior level');
  assert.equal(d0.employmentType, 'Full-time · Hybrid');
  assert.equal(d0.applicantsCount, '100+');
  assert.equal(d0.salary, '€60K/yr - €80K/yr');
  assert.equal(d0.applyUrl, 'https://careers.example.com/jobs/1', 'external apply URL');
  assert.equal(d0.companyEmployeesCount, 1001);
  assert.equal(d0.companyWebsite, 'https://www.li-company-1.example.com/');
  assert.match(d0.companyDescription, /^Software Development · 1,001-5,000 employees · LI Company 1 builds tools/);
  assert.equal(d0.postedAt, new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10));
  assert.equal(d0.source, 'LinkedIn');
  assert.match(draft[2].descriptionText, /^\[Summary from the LinkedIn search list/, 'not-opened jobs are marked, never invented');
  const liCsv = fs.readFileSync(path.join(jobsDir, `Netherlands/linkedin-Full-Stack-Engineer-Amsterdam,-Netherlands-${today}.csv`), 'utf8').replace(/^﻿/, '');
  assert.ok(liCsv.startsWith('title,company,location,workplaceType,employmentType,seniorityLevel,salary,postedAt,applicantsCount,applyType,applyUrl,link,jobId,industries,jobFunction,companyEmployeesCount,companyWebsite,companyLinkedinUrl,companyDescription,sponsorship,languages,yearsExperience,description'), liCsv.slice(0, 300));
  const firstRow = liCsv.split('\r\n')[1];
  for (const want of ['Hybrid', 'Full-time', 'easy_apply', 'external', 'Software Development', '1,001-5,000', 'We offer visa sponsorship and relocation support for this role.', 'Fluent English is required', '5+ years']) {
    assert.ok(liCsv.includes(want), `CSV has ${want}`);
  }
  assert.match(firstRow, /^Full Stack Engineer,LI Company 1,"Amsterdam, North Holland, Netherlands",Hybrid,Full-time,Mid-Senior level/);

  // Like the live failure: no Voyager responses at all. Ids come from the page's job cards,
  // which only appear as the result list is scrolled.
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ linkedinApiPattern: '/no-such-api/' }));
  r = await tool(tabId, 'linkedin_collect_jobs', { query: 'Full Stack DOM', city: 'Amsterdam, Netherlands', max_jobs: 7, details: 1, run_import: false, include_seen: true });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /Collected 7 new jobs .*1 with full description/, r.text);
  const domDraft = readJson(`Netherlands/linkedin-Full-Stack-DOM-Amsterdam,-Netherlands-${today}-draft.json`);
  assert.equal(domDraft[5].companyName, 'LI Company 6', 'card lines parsed (title / company / location)');
  assert.equal(domDraft[5].title, 'Full Stack Engineer');
  assert.equal(domDraft[5].location, 'Amsterdam, North Holland, Netherlands (Hybrid)');
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ linkedinApiPattern: '' }));
  console.log('2b. 51job 19 (API descriptions), zhaopin 15, linkedin 18 with full job-page fields + DOM-only run 7 -> Netherlands; all de-duplicated');

  // 3. apply_assist: fill + upload, refuse to submit, log only after the user confirms in the panel.
  events = await run({ tabId, prompt: 'APPLY-FLOW apply to Acme' });
  const res = (name) => events.filter((e) => e.type === 'tool_result' && e.name === name);
  assert.ok(res('apply_assist')[0]?.ok, JSON.stringify(res('apply_assist')[0]?.content));
  const clicks = res('computer');
  assert.equal(clicks.length, 3);
  assert.ok(!clicks[0].ok && /never submits/.test(clicks[0].content[0].text), 'click on Submit refused');
  assert.ok(clicks[1].ok, 'clicking a normal field still works');
  assert.ok(!clicks[2].ok && /never submits/.test(clicks[2].content[0].text), 'Enter in the form refused');
  const form = await page.evaluate(() => ({
    fn: fn.value, ln: ln.value, em: em.value, ph: ph.value, li: li.value, city: city.value, country: country.value,
    notice: notice.value, salary: salary.value, pw: pw.value, cover: cover.value, file: document.getElementById('file').textContent,
    out: out.textContent, submitted: !!window.__submitted,
  }));
  assert.deepEqual(form, {
    fn: 'Test', ln: 'Person', em: 'test@example.com', ph: '+31 600000000', li: 'https://www.linkedin.com/in/testperson', city: 'Amsterdam', country: 'nl',
    notice: '1 month', salary: '', pw: '', cover: 'Full stack engineer, Python and React.', file: 'CV_Fawad.pdf 2048', out: 'not submitted', submitted: false,
  });
  const review = events.find((e) => e.type === 'apply_review');
  assert.ok(review && review.skipped.some((s) => /salary/i.test(s.label)), 'review card lists what was left for the user');
  assert.ok(!fs.existsSync(path.join(jobsDir, 'application_tracker.json')), 'nothing logged before the user confirms');
  // The pending review card shows in the tab's side panel; the user confirms there.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html?tabId=${tabId}`);
  await panel.locator('.approval.apply').waitFor({ timeout: 10000 });
  assert.match(await panel.locator('.approval.apply .apply-warn').textContent(), /did not submit/);
  await panel.getByRole('button', { name: /I submitted it/ }).click();
  await panel.locator('.msg.notice', { hasText: 'Logged cn_Acme_Full-Stack-Engineer' }).waitFor({ timeout: 15000 });
  const tracker = readJson('application_tracker.json');
  assert.equal(tracker.applications.length, 1);
  assert.equal(tracker.applications[0].company, 'Acme');
  assert.equal(tracker.applications[0].folder, 'China/Applications/Acme');
  assert.equal(tracker.applications[0].jobUrl, `${base}/apply`);
  assert.equal(tracker.metadata.stats.applied, 1);
  assert.equal((await T(() => globalThis.__localPilotTest.pendingApplications())).length, 0);
  console.log('3. apply_assist: 9 fields + CV, Submit click and Enter refused, logged after panel confirmation');

  // 4. Saved tasks: schedule, background run fired by the alarm, notification; unapproved sites are not asked about.
  await page.goto(`${base}/page`);
  const task = await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'morning', prompt: 'SCHEDULED-FLOW morning', url: `${base}/page`, daily: '07:30' });
  const alarm = await T((n) => globalThis.__localPilotTest.getAlarm(n), `task:${task.id}`);
  assert.equal(alarm.periodInMinutes, 1440);
  assert.equal(new Date(alarm.scheduledTime).getHours(), 7);
  const fired = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${task.id}`);
  assert.ok(fired.ok && fired.windowClosed, JSON.stringify(fired));
  assert.match(fired.text, /Join the club/);
  let notes = await T(() => globalThis.__localPilotTest.notifications());
  assert.match(notes.at(-1).title, /morning finished/);
  const runs = await T(() => globalThis.__localPilotTest.lastRuns());
  assert.ok(runs[task.id].ok);
  await settings({ permissionMode: 'ask_site', approvedDomains: [] });
  const nav = await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'nav', prompt: 'NAV-FLOW', url: `${base}/page` });
  const firedNav = await T((n) => globalThis.__localPilotTest.fireAlarm(n), `task:${nav.id}`);
  assert.ok(!firedNav.ok && !firedNav.windowClosed && /not approved yet: 127\.0\.0\.1/.test(firedNav.text), firedNav.text);
  notes = await T(() => globalThis.__localPilotTest.notifications());
  assert.match(notes.at(-1).title, /nav needs attention/);
  await T((id) => chrome.windows.remove(id), firedNav.windowId);
  console.log('4. saved task: daily alarm at 07:30, background run + notification; unapproved site -> needs attention, nothing asked');

  // 5. Panel: save a task in the UI, run it with /name; plan card approve.
  await settings({ permissionMode: 'auto', approvedDomains: ['127.0.0.1'] });
  await panel.reload();
  await panel.click('#toggle-tasks');
  await panel.fill('#task-name', 'readit');
  await panel.fill('#task-prompt', 'SCHEDULED-FLOW from panel');
  await panel.click('#task-form button[type=submit]');
  await panel.locator('.task-list li', { hasText: '/readit' }).waitFor({ timeout: 5000 });
  await panel.click('#toggle-tasks');
  await panel.fill('#prompt', '/readit');
  await panel.press('#prompt', 'Enter');
  await panel.locator('.msg.assistant', { hasText: 'FINAL' }).first().waitFor({ timeout: 20000 });
  await panel.click('#new-chat');
  await panel.selectOption('#mode-select', 'plan');
  await panel.fill('#prompt', 'PLAN-FLOW from panel');
  await panel.press('#prompt', 'Enter');
  await panel.locator('.approval.plan').waitFor({ timeout: 10000 });
  assert.match(await panel.locator('.approval.plan .plan-text').textContent(), /Open the test page/);
  await panel.getByRole('button', { name: 'Approve', exact: true }).click();
  await panel.locator('.msg.assistant', { hasText: 'FINAL' }).first().waitFor({ timeout: 20000 });
  console.log('5. panel: task saved in the UI and run with /readit; plan card approved, then executed');

  // 6. Plan-first mode: edit and cancel.
  events = await run({ tabId, prompt: 'PLAN-FLOW edit', plan: 'edit:1. Open the page\n2. Read it (edited by the user)' });
  assert.match(events.find((e) => e.type === 'plan_request').plan, /Open the test page/);
  const planReq = requests.find((q) => !q.tools && /PLANNING STEP/.test(q.messages[0].content));
  assert.ok(planReq, 'planning request has no tools');
  assert.ok(requests.at(-1).messages.some((m) => typeof m.content === 'string' && m.content.includes('edited by the user')), 'edited plan sent to the model');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 2);
  assert.ok(events.some((e) => e.type === 'done' && e.reason === 'end_turn'));
  events = await run({ tabId, prompt: 'PLAN-FLOW cancel', plan: 'deny' });
  assert.equal(events.filter((e) => e.type === 'tool_start').length, 0, 'nothing runs when the plan is cancelled');
  assert.ok(events.some((e) => e.type === 'done' && e.reason === 'plan_rejected'));
  console.log('6. plan mode: plan without tools, edited plan executed, cancelled plan runs nothing');

  // 7. Context summarization once the prompt passes the limit.
  await settings({ permissionMode: 'auto', summarizeAfterTokens: 1000 });
  await page.goto(`${base}/long`);
  const before = requests.length;
  events = await run({ tabId, prompt: 'LONG-FLOW read the long page' });
  const sums = requests.slice(before).filter((q) => !q.tools && /compress the history/.test(q.messages[0].content));
  assert.ok(sums.length >= 1, 'summary request made');
  assert.ok(events.some((e) => e.type === 'notice' && /Summarized \d+ older messages/.test(e.text)));
  assert.equal(events.filter((e) => e.type === 'tool_result' && e.name === 'get_page_text').length, 8, 'flow continued correctly after summarizing');
  assert.ok(events.some((e) => e.type === 'done' && e.reason === 'end_turn'));
  const afterSum = requests.at(-1).messages;
  assert.match(afterSum[1].content, /^\[Summary of the earlier conversation/);
  const sizes = requests.slice(before).filter((q) => q.tools).map((q) => q.messages.length);
  assert.ok(Math.max(...sizes) <= 10, `history stayed small: ${sizes.join(',')}`);
  console.log(`7. summarization: ${sums.length} summary call(s), history sizes ${sizes.join(',')}`);

  // 8. Streaming fallback for a server that rejects stream: true.
  await settings({ summarizeAfterTokens: 0, model: 'nostream-model' });
  await page.goto(`${base}/page`);
  events = await run({ tabId, prompt: 'SCHEDULED-FLOW nostream' });
  assert.ok(events.some((e) => e.type === 'done' && e.reason === 'end_turn'), 'run finished without streaming');
  assert.ok(stats.streamRejected >= 1 && requests.at(-1).stream === false);
  console.log('8. streaming fallback: server rejected stream, reply fetched without it');

  // 9. Panel: Help, the "/" menu, and files attached with the paperclip (uploaded without a PC path).
  await settings({ model: 'mock-model', permissionMode: 'auto' });
  await panel.reload();
  await panel.click('#new-chat');
  await panel.locator('.task-list li', { hasText: '/readit' }).waitFor({ state: 'attached', timeout: 5000 });
  await panel.fill('#prompt', '/');
  await panel.locator('#slash-menu').waitFor({ state: 'visible', timeout: 5000 });
  const menu = await panel.locator('#slash-menu .slash-name').allTextContents();
  for (const c of ['/help', '/tasks', '/attach', '/new', '/readit']) assert.ok(menu.includes(c), `"/" menu lists ${c}: ${menu}`);
  await panel.fill('#prompt', '/he');
  assert.deepEqual(await panel.locator('#slash-menu .slash-name').allTextContents(), ['/help'], 'menu filters as you type');
  await panel.press('#prompt', 'Enter');
  await panel.locator('#help').waitFor({ state: 'visible', timeout: 5000 });
  await panel.locator('#help-pc', { hasText: 'PC bridge: on' }).waitFor({ timeout: 5000 });
  assert.ok(await panel.locator('#pc-steps').isHidden(), 'setup steps hidden when the bridge works');
  assert.ok((await panel.locator('#help-commands').textContent()).includes('/readit'), 'help lists saved tasks');
  assert.ok(await panel.locator('#help-examples .chip.ex').count() >= 10, 'examples listed');
  await panel.locator('#help-examples .chip.ex', { hasText: 'Upload the attached file' }).click();
  assert.equal(await panel.inputValue('#prompt'), 'Upload the attached file to the resume field', 'example fills the box');
  await panel.click('#toggle-help');
  assert.ok(await panel.locator('#help').isHidden());
  const savedTry = await T((t) => globalThis.__localPilotTest.saveTask(t).then(() => 'saved', (e) => e.message), { name: 'help', prompt: 'x' });
  assert.match(savedTry, /built-in command/, 'saved tasks cannot take built-in names');

  await page.goto(`${base}/page`);
  await panel.setInputFiles('#attach-input', [
    { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(3000, 7) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notice period: 2 months') },
  ]);
  await panel.locator('.file-chip').nth(1).waitFor({ timeout: 5000 });
  await panel.fill('#prompt', 'ATTACH-FLOW upload my CV');
  await panel.press('#prompt', 'Enter');
  await panel.locator('.msg.assistant', { hasText: 'FINAL' }).first().waitFor({ timeout: 20000 });
  assert.ok(await panel.locator('#attach-list').isHidden(), 'attachments cleared after sending');
  assert.match(await panel.locator('.msg.user .msg-files').first().textContent(), /cv\.pdf.*notes\.txt/);
  assert.equal(await page.locator('#out').textContent(), 'cv.pdf 3000', 'attached file uploaded into the page');
  const attachReq = requests.at(-1);
  const userText = attachReq.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join(' '))).join('\n');
  assert.match(userText, /cv\.pdf \(application\/pdf, 3 KB\)/, 'model told which files are attached');
  assert.match(userText, /Notice period: 2 months/, 'text file contents given to the model');
  const uploadDef = attachReq.tools.find((t) => t.function.name === 'file_upload').function.parameters;
  assert.deepEqual(uploadDef.properties.attachment.anyOf[0].enum, ['cv.pdf', 'notes.txt']);
  // The history view (after a reload) still shows the files on the user message.
  await panel.reload();
  await panel.locator('.msg.user .msg-files').first().waitFor({ timeout: 5000 });
  // A direct call without the PC bridge path uses the attachment.
  r = await T(([t]) => globalThis.__localPilotTest.tool(t, 'find', { query: 'Resume' }), [tabId]);
  const ref = r.text.match(/\[(ref_\d+)\]/)[1];
  r = await T(([t, i, f]) => globalThis.__localPilotTest.tool(t, 'file_upload', i, f), [tabId, { ref, attachment: 'b.pdf' }, [{ name: 'b.pdf', type: 'application/pdf', data: Buffer.alloc(10, 1).toString('base64') }]]);
  assert.ok(r.ok, r.text);
  assert.equal(await page.locator('#out').textContent(), 'b.pdf 10');
  r = await T(([t, i]) => globalThis.__localPilotTest.tool(t, 'file_upload', i), [tabId, { ref, attachment: 'nope.pdf' }]);
  assert.ok(!r.ok && /No attached file "nope\.pdf"/.test(r.text), r.text);
  console.log('9. panel: Help (setup, commands, examples), "/" menu, paperclip files read by the model and uploaded to the page');

  console.log('\nPHASE C E2E PASS');
} finally {
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
