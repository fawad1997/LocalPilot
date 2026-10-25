// Benchmark: LocalPilot on bench/tasks.json with one model.
//   node bench/run-localpilot.mjs --model gemma-4-26b-a4b-it [--mode tools|json] [--tasks id,id] [--max-steps 25] [--headed]
// The model server, key and provider come from src/local-defaults.json (the extension loads it).
// Results: bench/results/localpilot-<model>-<mode>-<time>.json, and a summary on the console.
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { score, summarize, ANSWER_SUFFIX } from './score.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const model = arg('model');
if (!model) throw new Error('Pass --model <id> (the same model for every agent you compare).');
const mode = arg('mode', 'tools');
const maxSteps = Number(arg('max-steps', 25));
const timeoutMs = Number(arg('timeout', 360)) * 1000;
const only = arg('tasks', '').split(',').filter(Boolean);
const { tasks } = JSON.parse(fs.readFileSync(path.join(root, 'bench', 'tasks.json'), 'utf8'));
const chosen = only.length ? tasks.filter((t) => only.includes(t.id)) : tasks;

const stampNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(root, 'bench', 'results');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-bench-'));
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 1280, height: 900 },
  env: {
    ...process.env,
    // Its own bridge pipe, state and logs, so a running LocalPilot is not disturbed.
    LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-bench-${process.pid}`,
    LOCALPILOT_STATE_DIR: path.join(tmp, 'state'),
    LOCALPILOT_LOG_DIR: path.join(outDir, `logs-localpilot-${stampNow}`),
  },
});

const results = [];
let quotaStop = null;
try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const T = (fn, a) => sw.evaluate(fn, a);
  await T((p) => globalThis.__localPilotTest.saveSettings(p), {
    model, actionMode: mode, permissionMode: 'auto', maxSteps, sendPageState: true, judgeRuns: false, streaming: false, recordRuns: false, fallbackModels: '',
  });
  for (const [i, task] of chosen.entries()) {
    const page = await context.newPage();
    page.on('dialog', () => {}); // dialogs are LocalPilot's to handle
    await page.goto(task.url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    const tabId = await T(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u))?.id, new URL(page.url()).origin);
    const started = Date.now();
    let events = [];
    let error = null;
    try {
      events = await Promise.race([
        T(async (o) => {
          globalThis.__localPilotTest.reset();
          return globalThis.__localPilotTest.run(o);
        }, { tabId, prompt: `${task.task}${ANSWER_SUFFIX}` }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
      ]);
    } catch (err) {
      error = String(err.message || err);
      await T((t) => globalThis.__localPilotTest.stop?.(t), tabId).catch(() => {});
    }
    const answers = events.filter((e) => e.type === 'assistant').map((e) => e.text);
    const done = events.find((e) => e.type === 'done');
    const r = {
      id: task.id,
      ok: !error && score(task, answers.at(-1) || ''),
      answer: (answers.at(-1) || '').slice(0, 500),
      steps: events.filter((e) => e.type === 'status' && /^Thinking/.test(e.text)).length,
      actions: events.filter((e) => e.type === 'tool_result').length,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      end: error || done?.reason || 'none',
      ...(events.some((e) => e.type === 'error') ? { error: events.filter((e) => e.type === 'error').map((e) => e.text).join(' | ').slice(0, 400) } : {}),
    };
    results.push(r);
    console.log(`${String(i + 1).padStart(2)}/${chosen.length} ${r.ok ? 'PASS' : 'fail'} ${task.id} — ${r.steps} steps, ${r.seconds}s — ${r.answer.replace(/\s+/g, ' ').slice(0, 90)}`);
    await page.close().catch(() => {});
    // The model server's quota is gone: the rest would only measure that. Stop, and mark the run.
    if (results.slice(-2).length === 2 && results.slice(-2).every((x) => /429|exhausted|rate.?limit/i.test(x.error || ''))) {
      quotaStop = `stopped after task ${i + 1}: the model server kept answering 429 (quota or rate limit)`;
      console.log(quotaStop);
      break;
    }
  }
} finally {
  await context.close();
}
const report = { agent: 'LocalPilot', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, model, mode, maxSteps, at: new Date().toISOString(), ...(quotaStop ? { invalid: quotaStop } : {}), summary: summarize(results), results };
const file = path.join(outDir, `localpilot-${model.replace(/[^\w.-]+/g, '_')}-${mode}-${stampNow}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 1));
console.log(`\n${JSON.stringify(report.summary)}\nSaved ${file}`);
