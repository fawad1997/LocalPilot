// Summarize LocalPilot JSONL logs: runs, model failures, retries, tool errors, bot checks, slow steps.
//   node scripts/summarize-logs.mjs [YYYY-MM-DD] [--dir <logs folder>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const dir = dirFlag >= 0 ? args[dirFlag + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (!day || f.includes(day))).sort() : [];
if (!files.length) {
  console.log(`No log files in ${dir}${day ? ` for ${day}` : ''}.`);
  process.exit(0);
}

const events = [];
for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip partial lines
    }
  }
}

const count = (arr, key) => arr.reduce((m, e) => m.set(key(e), (m.get(key(e)) || 0) + 1), new Map());
const top = (map, n = 10) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
const of = (t) => events.filter((e) => e.type === t);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');

const runs = of('run_end');
const reqs = of('model_request');
const failedReqs = reqs.filter((e) => !e.ok);
const tools = of('tool_call');
const failedTools = tools.filter((e) => !e.ok);

console.log(`Files: ${files.join(', ')}  (${events.length} events)\n`);
console.log(`Runs: ${runs.length}  ${top(count(runs, (e) => e.reason)).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`Model calls: ${reqs.length}, failed ${failedReqs.length} (${pct(failedReqs.length, reqs.length)}), retries ${of('model_retry').length}, fallbacks ${of('model_fallback').length}`);
const okMs = reqs.filter((e) => e.ok).map((e) => e.ms).sort((a, b) => a - b);
if (okMs.length) console.log(`Model latency: median ${okMs[Math.floor(okMs.length / 2)]} ms, p90 ${okMs[Math.floor(okMs.length * 0.9)]} ms`);
for (const [k, v] of top(count(failedReqs, (e) => `${e.model} | ${e.status ?? '-'} | ${String(e.error).slice(0, 110)}`), 8)) console.log(`  ${v}x  ${k}`);

console.log(`\nTool calls: ${tools.length}, failed ${failedTools.length} (${pct(failedTools.length, tools.length)})`);
for (const [k, v] of top(count(tools, (e) => e.name))) {
  const fails = failedTools.filter((e) => e.name === k).length;
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)} calls  ${fails} failed`);
}
console.log('Most common tool errors:');
for (const [k, v] of top(count(failedTools, (e) => `${e.name}: ${String(e.error).slice(0, 110)}`), 8)) console.log(`  ${v}x  ${k}`);

const bots = of('bot_check');
console.log(`\nBot checks: ${bots.length}  ${top(count(bots, (e) => `${e.kind}@${e.host}`)).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`  cleared ${of('bot_check_cleared').length}, declined ${of('bot_check_decision').filter((e) => e.decision !== 'continue').length}, clicks refused ${of('bot_check_click_refused').length}`);

const slow = [...tools].sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 5);
console.log('\nSlowest tool calls:');
for (const e of slow) console.log(`  ${e.ms} ms  ${e.name} ${JSON.stringify(e.input).slice(0, 80)}`);

const errs = [...of('run_error'), ...of('sw_error')];
console.log(`\nRun / service-worker errors: ${errs.length}`);
for (const [k, v] of top(count(errs, (e) => String(e.error).split('\n')[0].slice(0, 140)), 8)) console.log(`  ${v}x  ${k}`);
const mcp = of('mcp_call');
if (mcp.length) console.log(`\nMCP calls: ${mcp.length}, failed ${mcp.filter((e) => !e.ok).length}`);
