// Compare benchmark runs: the newest result per agent+model+mode in bench/results, as a Markdown
// table (overall and per task), written to bench/RESULTS.md and printed.
//   node bench/compare.mjs [--model llama-3.3-70b-fp8-fast]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'bench', 'results');
const i = process.argv.indexOf('--model');
const onlyModel = i >= 0 ? process.argv[i + 1] : null;

const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .filter((r) => !onlyModel || r.model === onlyModel)
  .filter((r) => r.results?.length && !r.invalid); // runs cut short by the model server's quota do not count
const latest = new Map();
for (const r of runs.sort((a, b) => a.at.localeCompare(b.at))) {
  const key = `${r.agent}|${r.model}|${r.mode}`;
  const prev = latest.get(key);
  if (!prev || r.results.length >= prev.results.length) latest.set(key, r); // newest full run wins
}
const chosen = [...latest.values()].sort((a, b) => a.model.localeCompare(b.model) || a.agent.localeCompare(b.agent));
if (!chosen.length) {
  console.log('No results yet. Run bench/run-localpilot.mjs and bench/run_browser_use.py first.');
  process.exit(0);
}

const label = (r) => `${r.agent} ${r.version || ''} (${r.mode})`.replace(/\s+/g, ' ');
const lines = [
  '# Benchmark results',
  '',
  `Tasks: bench/tasks.json (${chosen[0].results.length} tasks with known answers). A task passes when the final answer contains every expected value. Same model, server, start page, instruction and step limit (${chosen[0].maxSteps}) for every agent.`,
  '',
  '| Model | Agent | Passed | Success | Avg steps | Avg seconds | Steps when passed | Seconds when passed |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...chosen.map((r) => `| ${r.model} | ${label(r)} | ${r.summary.passed}/${r.summary.tasks} | ${r.summary.successRate} | ${r.summary.avgSteps} | ${r.summary.avgSeconds} | ${r.summary.avgStepsWhenPassed} | ${r.summary.avgSecondsWhenPassed} |`),
  '',
  '## Per task',
  '',
  `| Task | ${chosen.map(label).join(' | ')} |`,
  `| --- | ${chosen.map(() => '---').join(' | ')} |`,
];
const ids = [...new Set(chosen.flatMap((r) => r.results.map((x) => x.id)))];
for (const id of ids) {
  lines.push(`| ${id} | ${chosen.map((r) => {
    const x = r.results.find((y) => y.id === id);
    return x ? `${x.ok ? 'pass' : 'fail'} (${x.steps} steps, ${x.seconds}s)` : '-';
  }).join(' | ')} |`);
}
lines.push('', `Runs: ${chosen.map((r) => `${label(r)} on ${r.model} at ${r.at}`).join('; ')}.`);
const md = `${lines.join('\n')}\n`;
fs.writeFileSync(path.join(root, 'bench', 'RESULTS.md'), md);
console.log(md);
