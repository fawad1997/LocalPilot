// 0.9.0 agent quality: the browser state sent with every step (new controls starred, older states
// not kept), controls covered by a pop-up left out, several actions per reply (stopped when the
// page changes), the done tool, and JSON action mode (server-enforced format, json_object
// fallback, a prose reply sent back once, memory carried to the next step).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-llm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-agent-'));
const { server, requests, stats } = await startMockServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 1280, height: 800 },
  downloadsPath: path.join(tmp, 'downloads'),
});

const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n'));

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const T = (fn, arg) => sw.evaluate(fn, arg);
  const settings = (patch) => T((p) => globalThis.__localPilotTest.saveSettings(p), patch);
  const tool = (tabId, name, input) => T(([t, n, i]) => globalThis.__localPilotTest.tool(t, n, i), [tabId, name, input]);
  const run = (opts) => T(async (o) => {
    globalThis.__localPilotTest.reset();
    return globalThis.__localPilotTest.run(o);
  }, opts);
  const results = (events) => events.filter((e) => e.type === 'tool_result').map((e) => e.content.map((b) => b.text || '').join(''));

  await settings({ provider: 'openai', baseUrl: `${base}/v1`, model: 'mock-model', apiKey: '', permissionMode: 'auto', maxSteps: 12, streaming: false, summarizeAfterTokens: 0, recordRuns: false, actionMode: 'tools', sendPageState: true });
  const page = await context.newPage();
  await page.goto(`${base}/qw/next`);
  const tabId = await T(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u).id, `${base}/qw/next`);

  // 1. Browser state with every step: first without stars, then new controls starred; only the latest state is sent.
  let before = requests.length;
  await run({ tabId, prompt: 'NAV-FLOW open the form' });
  const navReqs = requests.slice(before).filter((q) => q.tools?.length);
  assert.equal(navReqs.length, 2);
  const first = textOf(navReqs[0].messages.at(-1));
  assert.match(first, /^NAV-FLOW open the form\n\[Browser state now\. It is sent with every step; older states are left out\.\]\nTab \d+: "Next" .*\/qw\/next\n(Other tabs: .*\n)?Viewport: 1280x800[^\n]*\nVisible controls:\n- link "Back to form" href="\/qw\/form" \[ref_\d+\]$/, first);
  const second = navReqs[1].messages.map(textOf).join('\n');
  assert.equal(second.match(/\[Browser state now/g).length, 1, 'older states are not kept in the history');
  assert.match(second, /Tab \d+: "Signup test" .*\/page\n[\s\S]*Visible controls \(\* = new since your last step\):\n\*- textbox "Name" \[ref_\d+\]/);
  assert.match(navReqs[0].messages[0].content, /Every step ends with the current browser state/);
  console.log('1. browser state sent with every step; new controls starred; one state per request');

  // 2. A pop-up covers the page: covered controls leave the visible list and the screenshot marks.
  await page.goto(`${base}/qw/form`);
  const form = (await tool(tabId, 'read_page', { filter: 'interactive' })).text;
  const openRef = form.match(/button "Open dialog" \[(ref_\d+)\]/)[1];
  await tool(tabId, 'computer', { action: 'left_click', ref: openRef });
  const visible = (await tool(tabId, 'read_page', { filter: 'interactive', viewport_only: true })).text;
  assert.match(visible, /button "Close"/);
  assert.doesNotMatch(visible, /Does nothing|Open dialog/, visible);
  const full = (await tool(tabId, 'read_page', { filter: 'interactive' })).text;
  assert.match(full, /button "Does nothing" covered \[ref_\d+\]/);
  const shot = await tool(tabId, 'computer', { action: 'screenshot' });
  assert.match(shot.text, /button "Close"/);
  assert.doesNotMatch(shot.text, /Does nothing/);
  await page.keyboard.press('Escape');
  console.log('2. covered controls: left out of the visible list and the marks, flagged "covered" in read_page');

  // 3. Several actions in one reply: after the page changes, the next page action is skipped, reading still runs.
  await page.goto(`${base}/qw/form`);
  let events = await run({ tabId, prompt: 'MULTI-FLOW go' });
  let r = results(events);
  assert.equal(r.length, 3);
  assert.match(r[0], /^Navigated\. Title: Next/);
  assert.match(r[1], /^Not run: the page changed after an earlier action in this reply/);
  assert.match(r[2], /Next page/);
  console.log('3. three actions in one reply: navigate ran, the click was skipped after the page changed, the read ran');

  // 4. The done tool ends the task with a success flag.
  events = await run({ tabId, prompt: 'DONE-FLOW find the price' });
  assert.ok(events.some((e) => e.type === 'assistant' && e.text === 'Could not find the price on this page.'));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.reason, 'end_turn');
  assert.equal(done.success, false);
  console.log('4. done tool: final answer shown, success=false reported');

  // 5. JSON action mode: the signup flow, every request with a json_schema whose tool names are an enum.
  await settings({ actionMode: 'json' });
  await page.goto(`${base}/page`);
  before = requests.length;
  events = await run({ tabId, prompt: 'Fill the form' });
  const jsonReqs = requests.slice(before);
  assert.ok(jsonReqs.length >= 9, `requests: ${jsonReqs.length}`);
  for (const q of jsonReqs) {
    assert.equal(q.tools, undefined, 'no native tools in JSON mode');
    assert.equal(q.response_format.type, 'json_schema');
  }
  const toolEnum = jsonReqs[0].response_format.json_schema.schema.properties.actions.items.properties.tool.enum;
  for (const n of ['navigate', 'computer', 'form_input', 'web_search', 'done']) assert.ok(toolEnum.includes(n), `${n} in the enum`);
  assert.match(jsonReqs[0].messages[0].content, /REPLY FORMAT: every reply is exactly one JSON object/);
  assert.match(jsonReqs.at(-1).messages[0].content, /Your memory from your last step: steps so far: \d+/);
  assert.ok(jsonReqs.at(-1).messages.some((m) => m.role === 'user' && /^Results of your actions:\n1\. /.test(textOf(m))), 'tool results as text');
  r = results(events);
  assert.ok(r.some((t) => /Set ref_\d+ to "Ada"/.test(t)) && r.some((t) => /Set ref_\d+ to "Pro"/.test(t)));
  assert.ok(events.some((e) => e.type === 'assistant' && /Done\. The page now says: Hello, Ada \(pro\)/.test(e.text)));
  assert.equal(events.find((e) => e.type === 'done').success, true);
  assert.equal(await page.locator('#out').textContent(), 'Hello, Ada (pro)');
  console.log(`5. JSON mode: ${jsonReqs.length} server-enforced steps, tool names as an enum, memory carried, form filled, done success=true`);

  // 6. A server without json_schema: json_object is used instead (and remembered).
  await settings({ model: 'nojson-model' });
  stats.responseFormats = [];
  await page.goto(`${base}/qw/form`);
  events = await run({ tabId, prompt: 'DONE-FLOW find the price' });
  assert.deepEqual(stats.responseFormats.slice(0, 3), ['json_schema', 'json_object', 'json_object']);
  assert.ok(events.some((e) => e.type === 'assistant' && /Could not find the price/.test(e.text)));
  console.log('6. json_schema refused: fell back to json_object');

  // 7. A prose reply is sent back once with the error, then the model follows the format.
  await settings({ model: 'badjson-model' });
  events = await run({ tabId, prompt: 'DONE-FLOW find the price' });
  assert.ok(stats.badJson >= 1);
  const retry = requests.at(-1).messages.at(-1);
  assert.match(textOf(requests.find((q) => q.model === 'badjson-model' && /not a valid step object/.test(textOf(q.messages.at(-1)))).messages.at(-1)), /That reply was not a valid step object \(no JSON object found\)\. Reply again with only the JSON object/);
  assert.ok(retry, 'the run went on after the corrected reply');
  assert.ok(events.some((e) => e.type === 'done' && e.success === false));
  console.log('7. invalid JSON reply: corrected after one retry');

  // 8. extract (helper model, long page read in parts, JSON merged) and search_page (no model).
  await settings({ model: 'mock-model', actionMode: 'tools', helperModel: 'helper-model' });
  await page.goto(`${base}/qw/products`);
  stats.helper = [];
  const products = await tool(tabId, 'extract', { query: 'every product with its price', schema: { type: 'object', properties: { products: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } } } } } } });
  assert.equal(products.ok, true, products.text);
  assert.match(products.text, /^Extracted from "Products" \(.*\/qw\/products\), 2 part\(s\), by helper-model\./);
  const list = JSON.parse(products.text.slice(products.text.indexOf('\n') + 1)).products;
  assert.equal(list.length, 60, 'both parts merged');
  assert.deepEqual(list.at(-1), { name: 'Product 60', price: 120 });
  assert.ok(stats.helper.every((h) => h.model === 'helper-model' && h.kind === 'extract'));
  const email = await tool(tabId, 'extract', { query: 'the contact email' });
  assert.match(email.text, /\nsales@example\.org$/);
  const found = await tool(tabId, 'search_page', { pattern: 'product 4[0-2] -', regex: true, context: 0 });
  assert.match(found.text, /^3 match\(es\) for "product 4\[0-2\] -"/);
  assert.match(found.text, />\s\d+: Product 41 - \$82/);
  console.log('8. extract: 2 parts read by the helper model, 60 products merged, email found; search_page: 3 regex matches');

  // 9. The check after a task: success for a finished task, failed when the answer says it could not.
  stats.helper = [];
  await page.goto(`${base}/qw/next`);
  events = await run({ tabId, prompt: 'NAV-FLOW open the form' });
  const ok = events.find((e) => e.type === 'judge');
  assert.equal(ok?.verdict, 'success');
  assert.match(stats.helper[0].prompt, /User request:\nNAV-FLOW open the form\n\nActions:\n- navigate \{"url":"http:\/\/127\.0\.0\.1:\d+\/page"\} -> Navigated\. Title: Signup test/);
  events = await run({ tabId, prompt: 'DONE-FLOW find the price' });
  const bad = events.find((e) => e.type === 'judge');
  assert.equal(bad.verdict, 'failed');
  assert.match(stats.helper.at(-1).prompt, /the agent itself reported that it did not succeed/);
  events = await run({ tabId, prompt: 'TALK-FLOW hi' });
  assert.equal(events.filter((e) => e.type === 'judge').length, 0, 'no check for a reply without actions');
  console.log('9. check after tasks: success, failed (with the agent\'s own flag), skipped when nothing was done');

  // 10. Saved-task replay: learned from a run that worked, replayed without the model, repaired by
  // the agent when the page changed, then replayed again.
  await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'price', url: `${base}/qw/shop`, prompt: 'REPLAY-FLOW find the lamp price' });
  const runTask = async () => {
    await page.goto(`${base}/qw/shop`);
    return T(async (o) => {
      globalThis.__localPilotTest.reset();
      return globalThis.__localPilotTest.run(o);
    }, { tabId, task: 'price' });
  };
  const savedSteps = async () => (await T(() => globalThis.__localPilotTest.listTasks())).find((t) => t.name === 'price').replay?.steps || [];
  events = await runTask();
  assert.ok(events.some((e) => e.type === 'notice' && /^Saved 3 steps of \/price/.test(e.text)), events.filter((e) => e.type === 'notice').map((e) => e.text).join(' | '));
  const learned = await savedSteps();
  assert.deepEqual(learned.map((s) => s.name), ['form_input', 'computer', 'get_page_text']);
  assert.deepEqual(learned[1].fp && [learned[1].fp.tag, learned[1].fp.name, learned[1].fp.id], ['BUTTON', 'Go', 'go']);
  assert.equal(learned[1].changed, true);
  assert.equal(learned[0].input.ref, undefined, 'refs are not saved, fingerprints are');

  before = requests.length;
  events = await runTask();
  assert.equal(requests.length, before, 'replay made no model calls');
  assert.ok(events.some((e) => e.type === 'assistant' && /^Replayed all 3 saved steps without the AI\.\nResult:\n[\s\S]*Price: \$42/.test(e.text)));
  assert.equal(await page.locator('#out').textContent(), 'Price: $42');
  assert.equal(events.find((e) => e.type === 'done').replayed, true);

  await fetch(`${base}/qw/shop-mode?m=changed`);
  before = requests.length;
  events = await runTask();
  assert.ok(events.some((e) => e.type === 'notice' && /Saved step 2 did not work \(its element was not found on the page\)\. The AI takes over from here\./.test(e.text)));
  assert.ok(requests.length > before, 'the agent took over');
  const handover = requests.slice(before)[0].messages.map(textOf).join('\n');
  assert.match(handover, /Steps 1-1 worked; step 2 did not: its element was not found on the page/);
  assert.equal(await page.locator('#out').textContent(), 'Price: $42', 'the agent finished the task');
  assert.ok(events.some((e) => e.type === 'notice' && /^Saved \d+ steps of \/price/.test(e.text)), 'the repaired run was saved');
  const repaired = await savedSteps();
  assert.equal(repaired.find((s) => s.name === 'computer').fp.name, 'Look up');

  before = requests.length;
  events = await runTask();
  assert.equal(requests.length, before, 'the repaired steps replay without the model');
  assert.ok(events.some((e) => e.type === 'assistant' && /^Replayed all \d+ saved steps without the AI\.[\s\S]*Price: \$42/.test(e.text)));
  await fetch(`${base}/qw/shop-mode?m=normal`);

  console.log(`10. replay: learned 3 steps, replayed with 0 model calls, repaired by the agent after the page changed (${repaired.length} steps saved), replayed again with 0 calls`);
  // 11. Saved values: typed by placeholder, masked in results and the page outline, limited to their sites, never into passwords.
  await settings({ savedValues: [{ name: 'email', value: 'me@example.com', sites: '' }, { name: 'phone', value: '+31 6 1234 5678', sites: 'other.example' }] });
  await page.goto(`${base}/apply`);
  const applyForm = (await tool(tabId, 'read_page', { filter: 'interactive' })).text;
  const emailRef = applyForm.match(/textbox "Email address" \[(ref_\d+)\]/)[1];
  const filled = await tool(tabId, 'form_input', { ref: emailRef, value: '{{email}}' });
  assert.equal(filled.ok, true, filled.text);
  assert.equal(await page.locator('#em').inputValue(), 'me@example.com');
  assert.doesNotMatch(filled.text, /me@example\.com/, 'the result never shows the value');
  assert.match(filled.text, /\{\{email\}\}/);
  assert.match((await tool(tabId, 'read_page', { filter: 'interactive' })).text, /textbox "Email address" value="\{\{email\}\}"/);
  const phone = await tool(tabId, 'form_input', { ref: applyForm.match(/textbox "Phone" \[(ref_\d+)\]/)[1], value: '{{phone}}' });
  assert.match(phone.text, /\{\{phone\}\} may only be used on other\.example, not on 127\.0\.0\.1/);
  const pw = await tool(tabId, 'form_input', { ref: applyForm.match(/textbox "Password" \[(ref_\d+)\]/)[1], value: '{{email}}' });
  assert.match(pw.text, /never typed into password fields/);
  assert.equal(await page.locator('#pw').inputValue(), '');
  await settings({ savedValues: [] });
  console.log('11. saved values: filled by placeholder, masked everywhere, site limit and password fields refused');

  // 12. A saved task limited to some sites cannot leave them.
  await T((t) => globalThis.__localPilotTest.saveTask(t), { name: 'limited', url: '', prompt: 'NAV-FLOW open', allowedDomains: 'example.org' });
  events = await T(async (o) => {
    globalThis.__localPilotTest.reset();
    return globalThis.__localPilotTest.run(o);
  }, { tabId, task: 'limited' });
  assert.match(results(events)[0], /This task may only use example\.org; 127\.0\.0\.1 is not one of them\./);
  console.log('12. allowed sites: navigation outside the task\'s sites refused');

  // 13. save_pdf.
  await page.goto(`${base}/qw/form`);
  const pdf = await tool(tabId, 'save_pdf', { filename: 'contact form' });
  assert.match(pdf.text, /^Saved the page as a PDF \(\d+ KB\): /, pdf.text); // Playwright stores downloads under random names
  const pdfPath = pdf.text.split(': ').pop();
  assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');
  console.log('13. save_pdf: page saved as a PDF');

  // 14. Plan mode: the approved plan becomes a checklist the agent ticks off.
  await settings({ permissionMode: 'plan' });
  before = requests.length;
  events = await run({ tabId, prompt: 'PLANTICK-FLOW read it' });
  const progress = events.filter((e) => e.type === 'plan_progress');
  assert.deepEqual(progress[0].items.map((i) => [i.n, i.done]), [[1, false], [2, false], [3, false]]);
  assert.deepEqual(progress.at(-1).items.map((i) => i.done), [true, false, false]);
  assert.match(results(events)[1], /^Plan: 1\/3 done\. Next: 2\. Read its text/);
  assert.match(requests.at(-1).messages[0].content, /Approved plan \(tick steps off with plan_update\):\n\[x\] 1\. Open the test page\n\[ \] 2\. Read its text/);
  await settings({ permissionMode: 'auto' });
  console.log('14. plan checklist: 3 steps shown, step 1 ticked off by the agent');
  console.log('agent e2e: all passed');
} finally {
  await context.close();
  server.close();
}
