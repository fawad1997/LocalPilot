// LinkedIn jobs search -> CSV + import draft, in the user's own logged-in browser.
//
// Job ids come from the search page itself (job links / data attributes, which both the
// classic /jobs/search/ and the newer /jobs/search-results/ pages carry) and, when LinkedIn
// happens to send them, from its Voyager API responses. Every job is then opened at
// /jobs/view/<id>/ and read field by field (title, company, location, workplace type,
// employment type, seniority, salary, posted date, applicants, Easy Apply vs external,
// full description, company size/industry/description) so the CSV and the import draft
// carry what evaluate-job-fit and the tailor-cv skills need. Page reading uses visible text
// and headings rather than LinkedIn's (frequently changing) class names.
import * as cdp from '../cdp.js';
import { log } from '../logger.js';
import {
  jitter, safeName, today, openUrl, guardPage, requireHost, loadSeenJobs, isSeen, saveJobs, jobBoardSchema, fitSignals, sleep,
} from './common.js';

const COUNTRY_FOLDERS = ['Netherlands', 'Germany', 'Luxembourg', 'Sweden', 'HongKong', 'Remote', 'China'];
const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const PROBE = { loginUrl: '/login|/authwall|/uas/|/checkpoint/lg', loginText: 'Sign in to view|Join LinkedIn|Sign in$|Join now to see' };

export const LINKEDIN_COLUMNS = [
  'title', 'company', 'location', 'workplaceType', 'employmentType', 'seniorityLevel', 'salary', 'postedAt', 'applicantsCount',
  'applyType', 'applyUrl', 'link', 'jobId', 'industries', 'jobFunction', 'companyEmployeesCount', 'companyWebsite', 'companyLinkedinUrl',
  'companyDescription', 'sponsorship', 'languages', 'yearsExperience', 'description',
];

const emptyLinkedInRow = () => Object.fromEntries(LINKEDIN_COLUMNS.map((c) => [c, '']));
const idFromUrn = (urn) => String(urn || '').match(/(\d{6,})$/)?.[1] || '';

// Normalized Voyager JSON: job cards sit in `included`, one entry per card type.
export function parseVoyager(data) {
  const included = data.included || [];
  const items = included
    .filter((e) => /JobPostingCard$/.test(e.$type || '') && (e.jobPostingUrn || e['*jobPosting']))
    .map((e) => ({
      id: idFromUrn(e.jobPostingUrn || e['*jobPosting']),
      title: e.jobPostingTitle || e.title?.text || '',
      company: e.primaryDescription?.text || '',
      location: e.secondaryDescription?.text || '',
      insight: e.tertiaryDescription?.text || '',
    }))
    .filter((e) => e.id);
  return { items };
}

// Any job-posting id mentioned in an API body, for responses whose shape we don't parse.
export function idsInText(body) {
  const ids = new Set();
  for (const m of String(body).matchAll(/(?:fsd_jobPosting|jobPosting|fs_normalized_jobPosting):(\d{6,})/g)) ids.add(m[1]);
  return [...ids];
}

// "2 weeks ago" -> ISO date. Unknown -> ''.
export function postedDate(ago, now = new Date()) {
  const m = String(ago || '').match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return /just now|today/i.test(ago || '') ? now.toISOString().slice(0, 10) : '';
  const n = Number(m[1]);
  const d = new Date(now);
  const unit = m[2].toLowerCase();
  if (unit === 'day') d.setDate(d.getDate() - n);
  else if (unit === 'week') d.setDate(d.getDate() - n * 7);
  else if (unit === 'month') d.setMonth(d.getMonth() - n);
  else if (unit === 'year') d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

// "Over 100 applicants" -> "100+", "21 people clicked apply" -> "21".
export function applicants(text) {
  const m = String(text || '').match(/(over\s+)?([\d,]+)\s*(?:\+\s*)?(?:applicants?|people clicked apply)/i);
  if (!m) return '';
  return `${m[2].replace(/,/g, '')}${m[1] ? '+' : ''}`;
}

// "1,001-5,000 employees" -> 1001 (lower bound, a number like the Apify data).
export function employeesNumber(text) {
  const m = String(text || '').match(/([\d,]+)\s*(?:-\s*[\d,]+|\+)?\s*employees/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// ---------------------------------------------------------------------------
// In-page functions (run with chrome.scripting; they must be self-contained).

function harvestCardsInPage() {
  const out = new Map();
  const noise = /^(promoted|easy apply|viewed|applied|saved|actively recruiting|be an early applicant|new|verified|reposted.*|.*\bago|\d+ applicants?|over \d+ applicants|\d+ (school )?alum.*works here.*|your profile matches.*|.*connections? work here.*)$/i;
  const add = (id, el) => {
    if (!/^\d{6,}$/.test(id) || out.has(id)) return;
    const card = el?.closest?.('li, [data-job-id], [data-occludable-job-id], [data-view-name*="job-card"], div[class*="job-card"]');
    const lines = [];
    for (const raw of (card?.innerText || '').split('\n')) {
      const s = raw.trim();
      if (!s || noise.test(s) || lines.includes(s) || lines.some((l) => s.startsWith(l) || l.startsWith(s))) continue;
      lines.push(s);
    }
    out.set(id, { id, title: lines[0] || '', company: lines[1] || '', location: lines[2] || '' });
  };
  for (const a of document.querySelectorAll('a[href*="/jobs/view/"], a[href*="currentJobId="]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/) || href.match(/currentJobId=(\d{6,})/);
    if (m) add(m[1], a);
  }
  for (const el of document.querySelectorAll('[data-job-id], [data-occludable-job-id]')) add(el.getAttribute('data-job-id') || el.getAttribute('data-occludable-job-id'), el);
  for (const el of document.querySelectorAll('[data-entity-urn*="obPosting"]')) add((el.getAttribute('data-entity-urn').match(/(\d{6,})/) || [])[1], el);
  const current = new URLSearchParams(location.search).get('currentJobId');
  if (current) add(current, document.querySelector('h1, h2'));
  return [...out.values()];
}

async function scrollResultsInPage() {
  const link = document.querySelector('a[href*="/jobs/view/"], [data-job-id], [data-occludable-job-id]');
  let box = link?.parentElement;
  while (box && box !== document.body) {
    const s = getComputedStyle(box);
    if (/(auto|scroll)/.test(s.overflowY) && box.scrollHeight > box.clientHeight + 20) break;
    box = box.parentElement;
  }
  const target = box && box !== document.body ? box : document.scrollingElement;
  for (let i = 0; i < 6; i += 1) {
    target.scrollBy(0, Math.max(400, target.clientHeight * 0.8));
    await new Promise((r) => setTimeout(r, 450));
  }
  return target.scrollTop + target.clientHeight >= target.scrollHeight - 10;
}

async function readJobInPage() {
  const clean = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const lines = (el) => (el?.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Wait for the job to render (single-page app).
  for (let i = 0; i < 20 && !document.querySelector('main h1, h1'); i += 1) await new Promise((r) => setTimeout(r, 300));
  const main = document.querySelector('main') || document.body;
  const h1 = main.querySelector('h1') || document.querySelector('h1');
  const out = { title: clean(h1?.innerText) };

  // Expand a collapsed description ("See more" / "…more"), without leaving the page.
  for (const b of main.querySelectorAll('button, [role="button"]')) {
    const t = (b.getAttribute('aria-label') || b.innerText || '').trim();
    if (/see more|show more|…\s*more|^more$/i.test(t) && b.closest('article, section, div')?.innerText.length > 200) {
      try { b.click(); } catch { /* ignore */ }
    }
  }
  await new Promise((r) => setTimeout(r, 300));

  // Top card: the smallest ancestor of the title with enough text to hold company + meta line.
  let top = h1;
  while (top && top !== main && (top.innerText || '').length < 160) top = top.parentElement;
  const topLines = lines(top);
  const companyLink = (top || main).querySelector('a[href*="/company/"]') || main.querySelector('a[href*="/company/"]');
  out.company = clean(companyLink?.innerText) || topLines.find((l) => l !== out.title && !/·|•/.test(l)) || '';
  out.companyLinkedinUrl = companyLink ? companyLink.href.split('?')[0] : '';
  // Meta fields: "Amsterdam, North Holland, Netherlands · 2 weeks ago · Over 100 applicants" (signed in)
  // or "ElevenLabs  Amsterdam, …" / "6 days ago  116 applicants" (public page): split on · • or wide gaps.
  const parts = topLines
    .filter((l) => l !== out.title)
    .flatMap((l) => l.split(/\s*[·•]\s*|\s{2,}/))
    .map((p) => p.trim())
    .filter((p) => p && p !== out.company);
  const isMeta = (p) => /(ago|applicant|clicked apply|Reposted|Posted|Promoted|Responses|See who|hired|^Apply$|^Save$|Easy Apply)/i.test(p);
  out.location = parts.find((p) => !isMeta(p) && (/,/.test(p) || /^(Remote|Hybrid)\b/i.test(p)) && p.length < 90) || '';
  out.postedAgo = parts.find((p) => /\bago\b|today|just now/i.test(p)) || '';
  out.applicantsText = parts.find((p) => /applicant|clicked apply/i.test(p)) || '';
  const topText = (top?.innerText || '') + '\n' + (main.querySelector('[class*="preferences"], [class*="job-insight"], [class*="fit-level"]')?.innerText || '');
  out.workplaceType = (topText.match(/\b(Remote|Hybrid|On-site)\b/) || [])[1] || (/\((Remote|Hybrid|On-site)\)/.exec(out.location) || [])[1] || '';
  out.employmentType = (topText.match(/\b(Full-time|Part-time|Contract|Temporary|Internship|Volunteer)\b/) || [])[1] || '';
  out.seniorityLevel = (topText.match(/\b(Internship|Entry level|Associate|Mid-Senior level|Director|Executive)\b/) || [])[1] || '';
  // "€60K/yr - €80K/yr", "$120,000 - 150,000 per year", "EUR 5,000/mo"
  const money = (cur) => `${cur}\\s?[\\d.,]+\\s?[KkMm]?(?:\\s?\\/\\s?(?:yr|year|hr|hour|mo|month))?`;
  const currency = '(?:[€$£¥₹]|\\b(?:EUR|USD|GBP|CHF|SEK)\\b)';
  out.salary = (topText.match(new RegExp(`${money(currency)}(?:\\s?[-–]\\s?${money(`${currency}?`)})?(?:\\s+per\\s+(?:year|hour|month))?`)) || [])[0] || '';

  // Apply: Easy Apply inside LinkedIn, or an external application (URL when it is a link).
  const applyEl = [...main.querySelectorAll('button, a')].find((b) => /^(easy apply|apply)\b/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
  const applyText = (applyEl?.innerText || applyEl?.getAttribute('aria-label') || '').trim();
  out.applyType = !applyEl ? '' : /easy apply/i.test(applyText) ? 'easy_apply' : 'external';
  const href = applyEl?.tagName === 'A' ? applyEl.href : '';
  out.applyUrl = href && !/linkedin\.com\/(jobs|login)/.test(href) ? href : '';

  // Section by heading text ("About the job", "About the company"), else known containers.
  const section = (re) => {
    const head = [...main.querySelectorAll('h1, h2, h3, h4, strong')].find((h) => re.test(h.innerText.trim()));
    if (!head) return null;
    let box = head.parentElement;
    while (box && box !== main && (box.innerText || '').length < head.innerText.length + 80) box = box.parentElement;
    return box;
  };
  const jobBox = section(/^About the job$/i) || main.querySelector('#job-details, .jobs-description__content, .jobs-box__html-content, .show-more-less-html__markup, .description__text');
  out.description = clean((jobBox?.innerText || '').replace(/^About the job\s*/i, '').replace(/\s*(…\s*)?(see|show) (more|less)\s*$/i, ''));

  // Guest pages list criteria as "Seniority level / Employment type / Job function / Industries".
  for (const h of main.querySelectorAll('h3, dt')) {
    const label = h.innerText.trim();
    const value = clean(h.nextElementSibling?.innerText);
    if (/^Seniority level$/i.test(label)) out.seniorityLevel ||= value;
    else if (/^Employment type$/i.test(label)) out.employmentType ||= value;
    else if (/^Job function$/i.test(label)) out.jobFunction = value;
    else if (/^Industries$/i.test(label)) out.industries = value;
  }

  const companyBox = section(/^About the company$/i) || main.querySelector('.jobs-company__box, [class*="company__box"]');
  const cLines = lines(companyBox);
  const empLine = cLines.find((l) => /employees/i.test(l)) || '';
  out.companyEmployees = (empLine.match(/([\d,]+\s*(?:-\s*[\d,]+|\+)?)\s*employees/i) || [])[1] || '';
  if (!out.industries) {
    const before = empLine.split(/\s*[·•]\s*|\s{2,}/).find((p) => p && !/employees|on LinkedIn|followers/i.test(p));
    const prev = cLines[cLines.indexOf(empLine) - 1];
    out.industries = before && before !== empLine ? before : prev && !/followers|^About the company$|^Follow/i.test(prev) && prev !== out.company ? prev : '';
  }
  out.companyDescription = clean(cLines.filter((l) => l.length > 80).sort((a, b) => b.length - a.length)[0] || '');
  const site = companyBox && [...companyBox.querySelectorAll('a[href^="http"]')].find((a) => !/linkedin\.com/.test(a.href));
  out.companyWebsite = site ? site.href : '';
  return out;
}

// ---------------------------------------------------------------------------

async function inPage(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(() => [{ result: null }]);
  return res?.result;
}

export function toLinkedInDraft(row) {
  const summary = [
    '[Summary from the LinkedIn search list; the job page could not be read]',
    row.location && `Location: ${row.location}`,
    row.workplaceType && `Workplace: ${row.workplaceType}`,
  ].filter(Boolean).join('\n');
  return {
    id: row.jobId,
    title: row.title,
    companyName: row.company,
    location: row.location,
    descriptionText: row.description || summary,
    link: row.link,
    applyUrl: row.applyUrl || row.link,
    source: 'LinkedIn',
    salary: row.salary,
    postedAt: row.postedAt || today(),
    seniorityLevel: row.seniorityLevel,
    employmentType: [row.employmentType, row.workplaceType].filter(Boolean).join(' · '),
    applicantsCount: row.applicantsCount,
    companyWebsite: row.companyWebsite,
    companyEmployeesCount: employeesNumber(`${row.companyEmployeesCount} employees`),
    companyDescription: [row.industries, row.companyEmployeesCount && `${row.companyEmployeesCount} employees`, row.companyDescription].filter(Boolean).join(' · '),
    benefits: [],
  };
}

async function run(ctx, input) {
  const { root, rootPath } = requireHost(ctx);
  const base = (ctx.settings.linkedinBaseUrl || 'https://www.linkedin.com').replace(/\/+$/, '');
  const apiPattern = ctx.settings.linkedinApiPattern || '/voyager/api/';
  const query = String(input.query || '').trim();
  if (!query) throw new Error('query is required.');
  const locName = String(input.city || 'Netherlands').trim();
  const maxJobs = Math.min(Math.max(Number(input.max_jobs) || 30, 1), 150);
  const outDir = String(input.out_dir || COUNTRY_FOLDERS.find((f) => locName.toLowerCase().includes(f.toLowerCase())) || 'Europe').replace(/[\\/]+$/, '');
  const status = (t) => ctx.emit?.({ type: 'status', text: t });
  const guard = () => guardPage(ctx, 'LinkedIn', PROBE, 'linkedin.com');
  const known = input.include_seen ? { seen: new Set(), sources: [], notes: [] } : await loadSeenJobs(root, outDir);

  // 1. Search pages: ids from the DOM and from any Voyager responses.
  await cdp.startCapture(ctx.tabId, apiPattern);
  let seq = cdp.lastCaptureSeq();
  const candidates = new Map();
  let skippedSeen = 0;
  const consider = (c) => {
    if (!c.id || candidates.has(c.id)) return false;
    const row = {
      ...emptyLinkedInRow(), jobId: c.id, title: c.title || '', company: c.company || '', location: c.location || '',
      link: `${base}/jobs/view/${c.id}/`,
    };
    if (isSeen(known.seen, row, { draftId: c.id })) {
      skippedSeen += 1;
      candidates.set(c.id, null);
      return false;
    }
    candidates.set(c.id, row);
    return true;
  };
  const fresh = () => [...candidates.values()].filter(Boolean);
  for (let page = 0; page < MAX_PAGES && fresh().length < maxJobs; page += 1) {
    if (ctx.running === false) throw new Error('Stopped by the user.');
    const url = `${base}/jobs/search/?keywords=${encodeURIComponent(query)}&location=${encodeURIComponent(locName)}${page ? `&start=${page * PAGE_SIZE}` : ''}`;
    status(`LinkedIn: searching "${query}" in ${locName} (page ${page + 1})…`);
    await openUrl(ctx, url);
    await jitter(ctx, 2, 4);
    if (await guard()) {
      await openUrl(ctx, url);
      await jitter(ctx, 2, 4);
    }
    let added = 0;
    const harvest = async () => {
      for (const c of (await inPage(ctx.tabId, harvestCardsInPage)) || []) if (consider(c)) added += 1;
      const caps = cdp.readCaptured(ctx.tabId, { pattern: apiPattern, sinceSeq: seq });
      if (caps.length) seq = caps[caps.length - 1].seq;
      for (const cap of caps) {
        let cards = [];
        try {
          cards = parseVoyager(JSON.parse(cap.body)).items;
        } catch {
          // not JSON
        }
        for (const c of cards) if (consider(c)) added += 1;
        for (const id of idsInText(cap.body)) if (consider({ id })) added += 1;
      }
    };
    // The result list loads more cards as it is scrolled: harvest, scroll, repeat.
    await harvest();
    for (let round = 0; round < 4 && fresh().length < maxJobs; round += 1) {
      const atEnd = await inPage(ctx.tabId, scrollResultsInPage);
      await jitter(ctx, 1, 2);
      await harvest();
      if (atEnd) break;
    }
    status(`LinkedIn: ${fresh().length} new jobs found${skippedSeen ? ` (${skippedSeen} already known)` : ''}…`);
    if (!added) break; // no more results
  }
  const rows = fresh().slice(0, maxJobs);
  if (!rows.length) {
    if (skippedSeen) return [{ type: 'text', text: `No new jobs: all ${skippedSeen} jobs found for "${query}" in ${locName} were collected before (${known.sources.join(', ')}).` }];
    throw new Error(
      'No LinkedIn jobs were found in this tab. Check that you are logged in and the search shows results. ' +
      'Do not write job entries by hand: tell the user what happened instead.',
    );
  }

  // 2. Every job page, read field by field.
  const detailCount = input.details === undefined ? rows.length : Math.min(Math.max(Number(input.details) || 0, 0), rows.length);
  let read = 0;
  for (let i = 0; i < detailCount; i += 1) {
    if (ctx.running === false) break;
    const row = rows[i];
    status(`LinkedIn: reading job ${i + 1}/${detailCount}: ${row.title || row.jobId}${row.company ? ` @ ${row.company}` : ''}`);
    await openUrl(ctx, row.link);
    await jitter(ctx, 1.5, 3);
    if (await guard()) await openUrl(ctx, row.link);
    const d = await inPage(ctx.tabId, readJobInPage);
    if (!d) continue;
    Object.assign(row, {
      title: d.title || row.title,
      company: d.company || row.company,
      location: d.location || row.location,
      workplaceType: d.workplaceType,
      employmentType: d.employmentType,
      seniorityLevel: d.seniorityLevel,
      salary: d.salary,
      postedAt: postedDate(d.postedAgo),
      applicantsCount: applicants(d.applicantsText),
      applyType: d.applyType,
      applyUrl: d.applyUrl,
      industries: d.industries || '',
      jobFunction: d.jobFunction || '',
      companyEmployeesCount: d.companyEmployees,
      companyWebsite: d.companyWebsite,
      companyLinkedinUrl: d.companyLinkedinUrl,
      companyDescription: d.companyDescription,
      description: d.description,
    });
    if (d.description) read += 1;
    Object.assign(row, fitSignals(d.description));
    await jitter(ctx, 3, 7);
  }

  // 3. Save CSV + draft on the PC, then import.
  const stem = `linkedin-${safeName(query)}-${safeName(locName)}-${today()}`;
  const { csv, draft, importNote } = await saveJobs(ctx, {
    root, rootPath, outDir, stem, rows, columns: LINKEDIN_COLUMNS, makeDraft: toLinkedInDraft, runImport: input.run_import,
  });
  log('recipe_done', { runId: ctx.runId, recipe: 'linkedin', rows: rows.length, withDescription: read, skippedSeen, csv: csv.path });
  const missing = rows.filter((r) => !r.description).length;
  const preview = rows.slice(0, 8).map((r, i) => `${i + 1}. ${r.title} | ${r.company} | ${r.location}${r.workplaceType ? ` (${r.workplaceType})` : ''}${r.sponsorship ? ' | mentions visa/sponsorship' : ''}`).join('\n');
  return [{
    type: 'text',
    text: [
      `Collected ${rows.length} new jobs for "${query}" in ${locName} (${read} with full description).`,
      missing ? `${missing} job page(s) could not be read; their rows only have list data.` : '',
      input.include_seen ? 'De-duplication off (include_seen).' : `Skipped ${skippedSeen} job(s) already collected before${known.sources.length ? ` (checked ${known.sources.join(', ')})` : ''}.`,
      `CSV: ${csv.path}`,
      `Draft: ${draft.path}`,
      importNote,
      '',
      'First rows:',
      preview,
    ].filter((l) => l !== '').join('\n'),
  }];
}

export default {
  definition: {
    name: 'linkedin_collect_jobs',
    description:
      'Collect LinkedIn job search results in this browser tab (the user\'s own logged-in LinkedIn), open every job page, and save a CSV + import-manual-jobs draft on the PC, then run the import. ' +
      'Each row has title, company, location, workplace/employment type, seniority, salary, posted date, applicants, Easy Apply vs external, full description, company size/industry, and visa/language/experience lines for fit checks. ' +
      'Skips jobs already in processed-jobs.json or earlier imports. Pauses on login or verification pages.',
    input_schema: jobBoardSchema({
      locationDesc: 'Location as typed in LinkedIn search, e.g. "Amsterdam", "Netherlands", "Germany". Default Netherlands.',
      outDirDesc: 'Region folder in the jobs root (default: the country folder named in the location, else "Europe").',
    }),
  },
  domains: ['linkedin.com'],
  approval: 'linkedin.com + PC files',
  promptHint: 'For LinkedIn job searches, use linkedin_collect_jobs. It reads every job page itself.',
  run,
};

// exported for unit tests
export const _inPage = { harvestCardsInPage, readJobInPage, scrollResultsInPage, sleep };
