#!/usr/bin/env node
// log-application.mjs -- record an application the user has submitted in application_tracker.json.
// Run by LocalPilot only after the user confirms in the side panel that they pressed Submit
// (allowlisted as an internal host script, so the model cannot call it).
//
//   node log-application.mjs add '{"company":"Acme","role":"Full Stack Engineer","country":"China",
//                                  "jobUrl":"https://…","cvPath":"China/Applications/Acme/CV.pdf"}'
//
// Canonical copy: LocalPilot host/jobs-scripts/log-application.mjs (copy it next to application_tracker.json).
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { loadTracker, saveTracker } from './lib/tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(ROOT, 'application_tracker.json');
const PREFIX = { netherlands: 'nl', germany: 'de', china: 'cn', hongkong: 'hk', luxembourg: 'lu', sweden: 'se', europe: 'eu', remote: 'rm' };

const idPart = (s, sep) => String(s).trim().replace(/[^\p{L}\p{N}]+/gu, sep).replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const [cmd, json] = process.argv.slice(2);
if (cmd !== 'add' || !json) fail('Usage: node log-application.mjs add \'{"company":…,"role":…}\'');
let input;
try {
  input = JSON.parse(json);
} catch (err) {
  fail(`Invalid JSON: ${err.message}`);
}
const company = String(input.company || '').trim();
const role = String(input.role || '').trim();
if (!company || !role) fail('company and role are required.');
const country = String(input.country || 'China').trim();
const date = new Date().toISOString().slice(0, 10);

const tracker = await loadTracker(TRACKER);
const prefix = PREFIX[country.toLowerCase().replace(/\s+/g, '')] || country.slice(0, 2).toLowerCase();
const baseId = `${prefix}_${idPart(company, '_')}_${idPart(role, '-')}`;

const same = tracker.applications.find((a) => a.id === baseId || (a.company === company && a.role === role && a.appliedDate === date));
if (same && same.appliedDate === date) {
  console.log(`Already logged today: ${same.id}`);
  process.exit(0);
}
let id = baseId;
for (let n = 2; tracker.applications.some((a) => a.id === id); n += 1) id = `${baseId}_${n}`;

const cvPath = String(input.cvPath || '').replace(/\\/g, '/');
tracker.applications.push({
  id,
  company,
  role,
  country,
  folder: cvPath ? dirname(cvPath) : '',
  appliedDate: date,
  status: 'applied',
  statusHistory: [{ status: 'applied', date, source: input.source || 'localpilot' }],
  keySkillsHighlighted: [],
  cvVersion: cvPath ? basename(cvPath) : 'unknown',
  tags: ['localpilot'],
  ...(input.jobUrl ? { jobUrl: String(input.jobUrl) } : {}),
});
await saveTracker(TRACKER, tracker);
console.log(`Logged ${id} (${company} — ${role}, ${date}). Total applications: ${tracker.applications.length}.`);
