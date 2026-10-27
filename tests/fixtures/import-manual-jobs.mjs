// import-manual-jobs.mjs -- normalise hand-collected job postings into the shape
// the application-assistant workflow expects (used by the end-to-end tests as a stand-in for
// the user's own copy in their jobs folder).
//
// Needed because BOSS直聘 is chat-first and app-only, and 51job / Liepin / Zhaopin
// have no reliable Apify actor. Browse in the app, paste what you see into a draft
// file, then run this to get a file the workflow can consume.
//
//   node import-manual-jobs.mjs template China          # write a starter draft file
//   node import-manual-jobs.mjs build <draft.json>      # normalise -> scraper shape
//
// A draft entry needs only: title, companyName, location, descriptionText.
// Everything else is optional and filled with safe defaults.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const JOBS_ROOT = dirname(fileURLToPath(import.meta.url));

const REQUIRED = ['title', 'companyName', 'location', 'descriptionText'];

const TEMPLATE = [
  {
    title: 'Full Stack Engineer',
    companyName: 'Example Tech Co',
    location: 'Shenzhen, Guangdong, China',
    descriptionText: 'Paste the full posting text here. Keep the original language.',
    link: 'https://www.zhipin.com/job_detail/xxxxx.html',
    source: 'BOSS Zhipin',
    salary: '25K-40K/month x 14',
    companyEmployeesCount: 200,
    postedAt: '2026-10-19',
    _hint: 'Delete this object and add your own. Only title, companyName, location and descriptionText are required.'
  }
];

// Chinese titles slug to an empty string, which would leave a filename starting
// with a dash. Fall back rather than emit one.
function slug(s, fallback = 'jobs') {
  const out = String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return out || fallback;
}

function stableId(job) {
  return createHash('sha1')
    .update(`${job.companyName}|${job.title}|${job.location}`)
    .digest('hex')
    .slice(0, 16);
}

function normalise(raw, index) {
  const missing = REQUIRED.filter(k => !String(raw[k] || '').trim());
  if (missing.length) {
    return { error: `entry ${index + 1} (${raw.title || raw.companyName || 'unnamed'}): missing ${missing.join(', ')}` };
  }

  const text = String(raw.descriptionText).trim();
  return {
    job: {
      id: raw.id || stableId(raw),
      link: raw.link || '',
      applyUrl: raw.applyUrl || raw.link || '',
      title: String(raw.title).trim(),
      companyName: String(raw.companyName).trim(),
      location: String(raw.location).trim(),
      postedAt: raw.postedAt || new Date().toISOString().slice(0, 10),
      salary: raw.salary || '',
      descriptionText: text,
      // The skills read descriptionHtml when present; keep both in sync so a
      // manual entry behaves exactly like a scraped one.
      descriptionHtml: raw.descriptionHtml || text.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join(''),
      seniorityLevel: raw.seniorityLevel || '',
      employmentType: raw.employmentType || '',
      applicantsCount: raw.applicantsCount ?? '',
      companyWebsite: raw.companyWebsite || '',
      companyEmployeesCount: raw.companyEmployeesCount ?? null,
      companyDescription: raw.companyDescription || '',
      benefits: raw.benefits || [],
      // Provenance -- the tailor-cv-china skill reads this for job_notes.md.
      source: raw.source || 'manual',
      manualImport: true
    }
  };
}

function cmdTemplate(region) {
  const dir = join(JOBS_ROOT, region);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, 'manual-draft.json');
  if (existsSync(out)) {
    console.error(`Refusing to overwrite existing ${out}`);
    console.error('Move or rename it first.');
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify(TEMPLATE, null, 2), 'utf8');
  console.log(`Draft written: ${out}`);
  console.log('Fill it in, then: node import-manual-jobs.mjs build "' + region + '/manual-draft.json"');
}

function cmdBuild(draftPath) {
  const abs = isAbsolute(draftPath) ? draftPath : join(JOBS_ROOT, draftPath);
  if (!existsSync(abs)) {
    console.error(`Not found: ${abs}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    console.error(`Invalid JSON in ${abs}: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error('Draft must be a JSON array of job objects.');
    process.exit(1);
  }

  const jobs = [];
  const errors = [];
  for (const [i, entry] of raw.entries()) {
    if (entry._hint) continue;  // the untouched template example
    const r = normalise(entry, i);
    r.error ? errors.push(r.error) : jobs.push(r.job);
  }

  if (errors.length) {
    console.error('Cannot build:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  if (!jobs.length) {
    console.error('No usable entries. Did you replace the template example?');
    process.exit(1);
  }

  const seen = new Set();
  const unique = jobs.filter(j => !seen.has(j.id) && seen.add(j.id));
  const dupes = jobs.length - unique.length;

  const region = basename(dirname(abs));
  const date = new Date().toISOString().slice(0, 10);
  const name = `${slug(unique[0].title)}-${slug(region)}-manual-${date}.json`;
  const out = join(dirname(abs), name);

  writeFileSync(out, JSON.stringify(unique, null, 2), 'utf8');
  console.log(`${unique.length} job(s) written${dupes ? `, ${dupes} duplicate(s) dropped` : ''}`);
  console.log(`-> ${out}`);
  console.log(`\nNext: run the tailor-cv skill for ${region} against this file.`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'template') cmdTemplate(arg || 'China');
else if (cmd === 'build' && arg) cmdBuild(arg);
else {
  console.log('Usage:');
  console.log('  node import-manual-jobs.mjs template <Region>   e.g. China, HongKong');
  console.log('  node import-manual-jobs.mjs build <draft.json>');
  process.exit(1);
}
