// Phase B: smart wait (SPA), wait_for, Set-of-Marks clicks, iframes (same- and
// cross-origin), file upload, downloads, full-page / element screenshots, and
// clicks by coordinate under browser zoom. Needs host:install.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-b-'));
const jobsDir = path.join(tmp, 'Jobs');
const dlDir = path.join(tmp, 'downloads');
fs.mkdirSync(path.join(jobsDir, 'China'), { recursive: true });
fs.mkdirSync(dlDir);
fs.writeFileSync(path.join(jobsDir, 'China', 'cv.pdf'), Buffer.alloc(1234, 7));
const configFile = path.join(tmp, 'host-config.json');
fs.writeFileSync(configFile, JSON.stringify({ roots: [{ name: 'jobs', path: jobsDir, writable: true }], scripts: [], downloadsDir: dlDir }));

const { server } = await startMockServer(0);
const { server: other } = await startMockServer(0); // second origin for the cross-origin iframe
const base = `http://127.0.0.1:${server.address().port}`;
const otherBase = `http://127.0.0.1:${other.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  downloadsPath: dlDir,
  env: {
    ...process.env,
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-b-test-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'),
    LOCALPILOT_HOST_CONFIG: configFile,
  },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const tool = (tabId, name, input) => sw.evaluate(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const refIn = (text, re) => text.split('\n').find((l) => re.test(l))?.match(/\[((?:f\d+:)?ref_\d+)\]/)?.[1];
  await sw.evaluate(() => globalThis.__localPilotTest.saveSettings({ permissionMode: 'auto', screenshotMarks: true }));

  const page = await context.newPage();
  page.on('dialog', () => {});
  await page.goto(`${base}/spa`);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/spa`);

  // 7. Smart wait: the click returns only after the delayed fetch + render settles.
  const load = refIn((await tool(tabId, 'find', { query: 'Load results' })).text, /button/);
  const t0 = Date.now();
  await tool(tabId, 'computer', { action: 'left_click', ref: load });
  const clickMs = Date.now() - t0;
  const afterClick = await tool(tabId, 'get_page_text', {});
  assert.match(afterClick.text, /Result A/, 'content from the delayed request is there right after the click');
  console.log(`7. smart wait: click returned after ${clickMs} ms with the SPA content rendered`);

  // wait_for
  await tool(tabId, 'computer', { action: 'left_click', ref: refIn((await tool(tabId, 'find', { query: 'Later' })).text, /button/) });
  const waited = await tool(tabId, 'computer', { action: 'wait_for', text: 'Later done', duration: 10 });
  assert.match(waited.text, /Found after/);
  const missing = await tool(tabId, 'computer', { action: 'wait_for', selector: '.never', duration: 1 });
  assert.match(missing.text, /Not found within 1s/);
  console.log('   wait_for: found text, timed out on a missing selector');

  // 8. Set-of-Marks: screenshot lists numbered marks; clicking by mark works.
  await page.goto(`${base}/page`);
  await tool(tabId, 'form_input', { ref: refIn((await tool(tabId, 'find', { query: 'Name' })).text, /textbox/), value: 'Mia' });
  const shot = await tool(tabId, 'computer', { action: 'screenshot' });
  assert.equal(shot.images, 1);
  const markLine = shot.text.split('\n').find((l) => /button "Submit"/.test(l));
  assert.ok(markLine, `marks legend: ${shot.text}`);
  const mark = Number(markLine.match(/^\[(\d+)\]/)[1]);
  const clicked = await tool(tabId, 'computer', { action: 'left_click', mark });
  assert.equal(clicked.ok, true, clicked.text);
  assert.equal(await page.textContent('#out'), 'Hello, Mia (free)');
  assert.equal(await page.evaluate(() => !!document.getElementById('__localpilot_marks__')), false, 'marks removed after capture');
  console.log(`8. marks: clicked mark [${mark}] (Submit)`);

  // 9. Iframes: same-origin and cross-origin frames are readable and clickable.
  await page.goto(`${base}/frames?other=${encodeURIComponent(otherBase)}`);
  const tree = (await tool(tabId, 'read_page', { filter: 'interactive' })).text;
  assert.match(tree, /--- iframe f\d+: .*name=same/);
  assert.match(tree, /--- iframe f\d+: .*name=cross/);
  const finds = (await tool(tabId, 'find', { query: 'City' })).text;
  const sameRef = refIn(finds, /textbox "City \(same\)/);
  const crossRef = refIn(finds, /textbox "City \(cross\)/);
  assert.ok(/^f\d+:ref_\d+$/.test(sameRef) && /^f\d+:ref_\d+$/.test(crossRef), finds);
  await tool(tabId, 'form_input', { ref: sameRef, value: 'Wuhan' });
  await tool(tabId, 'form_input', { ref: crossRef, value: 'Shenzhen' });
  const goCross = refIn(finds.includes('Go cross') ? finds : (await tool(tabId, 'find', { query: 'Go cross' })).text, /button "Go cross"/);
  const goSame = refIn((await tool(tabId, 'find', { query: 'Go same' })).text, /button "Go same"/);
  assert.equal((await tool(tabId, 'computer', { action: 'left_click', ref: goCross })).ok, true);
  assert.equal((await tool(tabId, 'computer', { action: 'left_click', ref: goSame })).ok, true);
  const frameText = async (name) => page.frames().find((f) => f.url().includes(`name=${name}`)).textContent('#out');
  assert.equal(await frameText('cross'), 'clicked:Shenzhen', 'real mouse click landed inside the cross-origin iframe');
  assert.equal(await frameText('same'), 'clicked:Wuhan');
  console.log('9. iframes: read, filled and clicked inside same- and cross-origin frames');

  // 10. File upload from the PC sandbox.
  await page.goto(`${base}/upload`);
  const fileRef = refIn((await tool(tabId, 'find', { query: 'Resume' })).text, /Resume/);
  const up = await tool(tabId, 'file_upload', { ref: fileRef, root: 'jobs', path: 'China/cv.pdf' });
  assert.equal(up.ok, true, up.text);
  assert.equal(await page.textContent('#out'), 'cv.pdf 1234');
  const escape = await tool(tabId, 'file_upload', { ref: fileRef, root: 'jobs', path: '../host-config.json' });
  assert.equal(escape.ok, false);
  assert.match(escape.text, /escapes root/);
  console.log('10. file upload: attached cv.pdf; path escape refused');

  // 11. Downloads: wait for the file and copy it into the jobs folder.
  await page.goto(`${base}/download`);
  await tool(tabId, 'computer', { action: 'left_click', ref: refIn((await tool(tabId, 'find', { query: 'Download report' })).text, /link/) });
  const dl = await tool(tabId, 'downloads_wait', { timeout_sec: 20, save_to: { root: 'jobs', path: 'downloads/report.csv' } });
  assert.equal(dl.ok, true, dl.text);
  assert.equal(fs.readFileSync(path.join(jobsDir, 'downloads', 'report.csv'), 'utf8'), 'id,title\n1,全栈工程师\n');
  console.log('11. download finished and copied to Jobs/downloads/report.csv');

  // 12. Full-page and element screenshots.
  await page.goto(`${base}/long`);
  const full = await tool(tabId, 'computer', { action: 'screenshot', full_page: true });
  const [fw, fh] = full.text.match(/(\d+)x(\d+)/).slice(1).map(Number);
  assert.ok(fh > fw * 1.5, `full page is tall: ${fw}x${fh}`);
  await page.goto(`${base}/page`);
  const el = await tool(tabId, 'computer', { action: 'screenshot', ref: refIn((await tool(tabId, 'find', { query: 'Submit' })).text, /button/) });
  assert.equal(el.images, 1);
  console.log(`12. full-page ${fw}x${fh}; element screenshot ok`);

  // Coordinates stay correct under browser zoom (150%).
  await sw.evaluate((t) => chrome.tabs.setZoom(t, 1.5), tabId);
  await page.waitForTimeout(500);
  await page.goto(`${base}/page`);
  await sw.evaluate((t) => chrome.tabs.setZoom(t, 1.5), tabId);
  await page.fill('#name', 'Zed');
  const zshot = await tool(tabId, 'computer', { action: 'screenshot', marks: false });
  if (!/Screenshot \d+x\d+ \(viewport/.test(zshot.text)) throw new Error(`zoom screenshot: ${JSON.stringify(zshot)}`);
  const [iw, , cw] = zshot.text.match(/Screenshot (\d+)x(\d+) \(viewport (\d+)x(\d+)/).slice(1).map(Number);
  const r = await page.evaluate(() => {
    const b = document.querySelector('button').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  const cssW = await page.evaluate(() => window.visualViewport.width); // exact (fractional at 150%)
  const ratio = iw / cssW;
  assert.ok(Math.abs(cw - cssW) < 1, `reported viewport ${cw} ≈ ${cssW}`);
  await tool(tabId, 'computer', { action: 'left_click', coordinate: [Math.round(r.x * ratio), Math.round(r.y * ratio)] });
  assert.equal(await page.textContent('#out'), 'Hello, Zed (free)', 'coordinate click hit the button at 150% zoom');
  await sw.evaluate((t) => chrome.tabs.setZoom(t, 1), tabId);
  console.log('    zoom 150%: coordinate click landed on target');

  console.log('\nPHASE B E2E PASS');
} finally {
  await context.close();
  server.close();
  other.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
