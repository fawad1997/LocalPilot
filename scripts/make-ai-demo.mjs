// AI demos: LocalPilot's own agent, with YOUR model, doing real tasks on real websites, each run
// recorded as a GIF ("Record every run"). Output: examples/demo-ai/<name>.gif + <name>.md (prompt,
// steps, answer). Model settings come from src/local-defaults.json (gitignored) or LP_BASE_URL /
// LP_MODEL / LP_API_KEY. The API key is only sent to your model server and never written to a file.
//   npm run demo:ai               all demos
//   npm run demo:ai -- books      one demo
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'examples', 'demo-ai');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-ai-demo-'));
let local = {};
try {
  local = JSON.parse(fs.readFileSync(path.join(root, 'src', 'local-defaults.json'), 'utf8'));
} catch {
  // use the environment
}
const model = {
  provider: 'openai',
  baseUrl: process.env.LP_BASE_URL || local.baseUrl || 'http://localhost:11434/v1',
  model: process.env.LP_MODEL || local.model || 'qwen2.5vl:7b',
  apiKey: process.env.LP_API_KEY || local.apiKey || '',
};

const DEMOS = {
  books: {
    url: 'https://books.toscrape.com/',
    prompt: 'Find the cheapest book in the Travel category on this site. Tell me its title and price.',
  },
  wikipedia: {
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    prompt: 'Use Wikipedia to find out who created the first web browser and in which year. Answer in one sentence.',
  },
  bugs: {
    url: 'https://the-internet.herokuapp.com/broken_images',
    prompt: 'Test this website for bugs with test_website (at most 2 pages, check at most 10 links). Then explain the most important problems in plain words, and how to fix them.',
  },
  form: {
    url: 'https://httpbin.org/forms/post',
    prompt: 'Fill this pizza order form for Jane Doe (phone +31 20 123 4567, email jane@example.com): a large pizza with mushroom and onion, delivery instructions "Ring the bell twice". Do NOT submit the form. Tell me when it is filled.',
  },
};

fs.writeFileSync(path.join(tmp, 'none.json'), JSON.stringify({ roots: [], scripts: [] }));
const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--window-size=1280,900'],
  downloadsPath: path.join(tmp, 'downloads'),
  viewport: null,
  // A private pipe and state folder, so this never touches your own LocalPilot bridge or folders.
  env: { ...process.env, LOCALPILOT_PIPE: `\\\\.\\pipe\\localpilot-ai-demo-${process.pid}`, LOCALPILOT_STATE_DIR: path.join(tmp, 'state'), LOCALPILOT_LOG_DIR: path.join(tmp, 'logs'), LOCALPILOT_HOST_CONFIG: path.join(tmp, 'none.json') },
});

try {
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const T = (fn, arg) => sw.evaluate(fn, arg);
  await T((p) => globalThis.__localPilotTest.saveSettings(p), { ...model, permissionMode: 'auto', recordRuns: true, maxSteps: 20, streaming: true, requestTimeoutSec: 180, sendScreenshots: false, summarizeAfterTokens: 24000 });
  const page = await context.newPage();
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const name of names.length ? names : Object.keys(DEMOS)) {
    const demo = DEMOS[name];
    console.log(`\n=== ${name}: ${demo.prompt}`);
    await page.goto(demo.url);
    const tabId = await T(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u)).id, demo.url.replace(/\/$/, ''));
    const started = Date.now();
    const events = await T(async (o) => {
      globalThis.__localPilotTest.reset();
      return globalThis.__localPilotTest.run(o);
    }, { tabId, prompt: demo.prompt });
    const steps = events.filter((e) => e.type === 'tool_start').map((e) => `- \`${e.name}\` ${JSON.stringify(e.input).slice(0, 140)}`);
    const answer = events.filter((e) => e.type === 'assistant').at(-1)?.text || '(no answer)';
    const done = events.find((e) => e.type === 'done');
    const errors = events.filter((e) => e.type === 'error').map((e) => e.text);
    const gif = events.find((e) => e.type === 'notice' && /Recording: Saved a GIF/.test(e.text))?.text.match(/\) to (.+?)\.$/)?.[1];
    console.log(`  ${done?.reason} in ${Math.round((Date.now() - started) / 1000)} s, ${steps.length} tool calls${errors.length ? `, errors: ${errors.join(' | ')}` : ''}`);
    console.log(`  answer: ${answer.slice(0, 400)}`);
    if (gif) {
      fs.copyFileSync(gif, path.join(out, `${name}.gif`));
      console.log(`  wrote examples/demo-ai/${name}.gif`);
    }
    fs.writeFileSync(path.join(out, `${name}.md`), [
      `# ${name}`,
      '',
      `**Page:** ${demo.url}`,
      '',
      `**Prompt:** ${demo.prompt}`,
      '',
      `**Model:** \`${model.model}\` through ${new URL(model.baseUrl).hostname === '127.0.0.1' || new URL(model.baseUrl).hostname === 'localhost' ? 'a local server' : 'the configured server'} · ${done?.reason} · ${Math.round((Date.now() - started) / 1000)} s · ${steps.length} tool calls`,
      '',
      '**What it did:**',
      '',
      ...steps,
      '',
      '**Its answer:**',
      '',
      ...answer.split('\n').map((l) => `> ${l}`),
      ...(errors.length ? ['', `**Errors:** ${errors.join(' | ')}`] : []),
      '',
    ].join('\n'));
  }
} finally {
  await context.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
