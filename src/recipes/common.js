// Shared pieces for recipes: pacing, "the user must handle this" pauses, page guards,
// PC output (CSV + import draft), de-duplication against what was already collected,
// and a generic job-board collector driven by each site's own JSON API (captured over CDP).
import * as cdp from '../cdp.js';
import * as pc from '../pcbridge.js';
import { log } from '../logger.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function jitter(ctx, minS, maxS) {
  const scale = ctx.settings.recipeDelayScale ?? 1;
  return sleep((minS + Math.random() * (maxS - minS)) * 1000 * scale);
}

export function safeName(s) {
  return String(s).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'jobs';
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function waitForComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status === 'complete' || Date.now() - start > timeoutMs) resolve(tab);
      else setTimeout(tick, 250);
    };
    setTimeout(tick, 300);
  });
}

export async function openUrl(ctx, url) {
  await chrome.tabs.update(ctx.tabId, { url });
  await waitForComplete(ctx.tabId);
}

// Verification / login detection. Patterns are regex sources so they can cross into the page.
const DEFAULT_PROBE = {
  verifyUrl: 'security-check|verify|captcha|checkpoint/challenge',
  verifyText: '安全验证|环境存在异常|滑块|拖动.*验证|请完成验证|quick security check',
  loginUrl: 'login',
  loginText: '扫码登录|登录/注册|请先登录',
};

export async function pageProbe(tabId, patterns = {}) {
  const p = { ...DEFAULT_PROBE, ...patterns };
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [p],
    func: (pat) => {
      const body = (document.body?.innerText || '').slice(0, 3000);
      return {
        url: location.href,
        title: document.title,
        verification: new RegExp(pat.verifyUrl, 'i').test(location.href) || new RegExp(pat.verifyText, 'i').test(body),
        login: new RegExp(pat.loginUrl, 'i').test(location.pathname) || new RegExp(pat.loginText, 'i').test(body.slice(0, 600)),
      };
    },
  }).catch(() => [{ result: null }]);
  return res?.result;
}

// Pause until isClear() holds (the user logs in / passes a check in the tab). Never acts on the check itself.
export async function waitForUser(ctx, site, reason, isClear) {
  log('recipe_pause', { runId: ctx.runId, site, reason });
  ctx.emit?.({ type: 'notice', text: `${site} needs you: ${reason}. Please handle it in the tab. I will wait up to 5 minutes and then continue.` });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (ctx.running === false) throw new Error('Stopped by the user.');
    await sleep(3000);
    if (await isClear()) {
      ctx.emit?.({ type: 'notice', text: 'Thanks, continuing.' });
      return;
    }
  }
  throw new Error(`Gave up waiting: ${reason}. Run the task again after handling it.`);
}

// Returns true when it had to wait for the user (callers then reload what they wanted).
export async function guardPage(ctx, site, patterns, loginHost) {
  const probe = await pageProbe(ctx.tabId, patterns);
  if (probe?.verification) {
    await waitForUser(ctx, site, 'a security verification page appeared (安全验证)', async () => !(await pageProbe(ctx.tabId, patterns))?.verification);
    return true;
  }
  if (probe?.login) {
    await waitForUser(ctx, site, `you need to log in to ${loginHost}`, async () => !(await pageProbe(ctx.tabId, patterns))?.login);
    return true;
  }
  return false;
}

export function requireHost(ctx) {
  const host = ctx.host;
  if (!host) throw new Error('PC bridge not installed. Run: node host/install.mjs, then reload the extension.');
  const root = host.roots.find((r) => r.writable);
  if (!root) throw new Error('No writable PC root configured in host/config.json.');
  return { host, root: root.name, rootPath: root.path };
}

// A named writable root (e.g. "trading"), for recipes that do not write to the jobs folder.
export function requireRoot(ctx, name, example) {
  const host = ctx.host;
  if (!host) throw new Error('PC bridge not installed. Run: node host/install.mjs, then reload the extension.');
  const root = host.roots.find((r) => r.name === name);
  if (!root) throw new Error(`No PC root "${name}" in host/config.json. Add ${example} to "roots", then reload the extension.`);
  if (!root.writable) throw new Error(`PC root "${name}" is read-only; set "writable": true in host/config.json.`);
  return { root: root.name, rootPath: root.path };
}

export async function writeUnique(method, params) {
  const dot = params.path.lastIndexOf('.');
  for (let i = 1; i <= 20; i += 1) {
    const p = i === 1 ? params.path : `${params.path.slice(0, dot)}-${i}${params.path.slice(dot)}`;
    try {
      return await pc.call(method, { ...params, path: p });
    } catch (err) {
      if (!/already exists/.test(err.message)) throw err;
    }
  }
  throw new Error(`Could not find a free file name for ${params.path}`);
}

// ---------------------------------------------------------------------------
// Job rows: one shape for every job board, so CSVs and drafts look the same.

export const JOB_COLUMNS = ['title', 'company', 'salary', 'city', 'district', 'experience', 'degree', 'skills', 'labels', 'welfare', 'companySize', 'industry', 'stage', 'recruiter', 'link', 'jobId', 'sponsorship', 'languages', 'yearsExperience', 'description'];

// Lines from a job description that the evaluate-job-fit gates look at first:
// visa / sponsorship / right-to-work wording, language requirements, years of experience.
// Quoted verbatim (trimmed) so the gate can cite them; empty when the description is silent.
export function fitSignals(description) {
  const text = String(description || '');
  if (!text) return { sponsorship: '', languages: '', yearsExperience: '' };
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const pick = (re, max = 3) => [...new Set(sentences.filter((s) => re.test(s)).map((s) => (s.length > 220 ? `${s.slice(0, 217)}…` : s)))].slice(0, max).join(' | ');
  return {
    sponsorship: pick(/visa|sponsor|relocat|work permit|right to work|work authori[sz]ation|citizen|residence permit|EU passport|kennismigrant|highly skilled migrant|blue card|签证|工作许可/i),
    languages: pick(/\b(Dutch|German|French|Spanish|Italian|Swedish|Danish|Norwegian|Polish|Portuguese|Mandarin|Chinese|Cantonese|Japanese|Korean|English)\b.*\b(fluent|fluency|native|proficien|required|must|C1|C2|B1|B2|business[- ]level|working knowledge)|\b(fluent|fluency|native|proficien)\b.*\b(Dutch|German|French|Spanish|Mandarin|Chinese|Japanese|English)\b|普通话|英语|日语/i, 2),
    yearsExperience: (text.match(/\b(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs)\b[^.\n]{0,60}/i) || text.match(/(\d{1,2})\s*(?:-\s*\d{1,2})?\s*年(?:以上)?(?:工作)?经验/) || [''])[0].trim(),
  };
}

export function emptyRow() {
  return Object.fromEntries(JOB_COLUMNS.map((c) => [c, '']));
}

export const joinList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? x.name || x.text || '' : x)).filter(Boolean).join('; ') : String(v || ''));

export function draftLocation(row, country) {
  const place = [row.city, row.district].filter(Boolean).join(' ');
  return country ? `${place}, ${country}` : place;
}

export function toDraftEntry(row, date, { source = 'BOSS Zhipin', label = 'BOSS', country = 'China', id } = {}) {
  const summary = [
    `[Summary from the ${label} search list; full description was not fetched]`,
    row.experience && `经验 Experience: ${row.experience}`,
    row.degree && `学历 Degree: ${row.degree}`,
    row.skills && `技能 Skills: ${row.skills}`,
    row.labels && `标签 Labels: ${row.labels}`,
    row.welfare && `福利 Benefits: ${row.welfare}`,
  ].filter(Boolean).join('\n');
  return {
    ...(id ? { id } : {}),
    title: row.title,
    companyName: row.company,
    location: draftLocation(row, country),
    descriptionText: row.description || summary,
    link: row.link,
    source,
    salary: row.salary,
    companyEmployeesCount: null,
    companyDescription: [row.industry, row.stage, row.companySize].filter(Boolean).join(' · '),
    benefits: row.welfare ? row.welfare.split('; ') : [],
    postedAt: date,
  };
}

// ---------------------------------------------------------------------------
// De-duplication: processed-jobs.json (the jobs ledger) and earlier <Region>/*-manual-*.json imports.

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const linkedinId = (url) => String(url || '').match(/linkedin\.com\/jobs\/view\/.*?(\d{5,})/)?.[1];

export function rowKeys(row, { country, draftId } = {}) {
  const keys = [row.jobId, draftId, row.link, linkedinId(row.link)].filter(Boolean).map(String);
  if (row.company && row.title) {
    keys.push(`ct:${norm(row.company)}|${norm(row.title)}`);
    keys.push(`ctl:${norm(row.company)}|${norm(row.title)}|${norm(draftLocation(row, country))}`);
  }
  return keys;
}

async function readJson(root, path) {
  const res = await pc.call('read_file', { root, path });
  if (res.truncated) throw new Error(`${path} is larger than the host read limit`);
  return JSON.parse(res.content);
}

// Known jobs as a key set. Ledger entries match on id/URL or company+title (the ledger has no
// location); earlier manual imports match on id/link or company+title+location.
export async function loadSeenJobs(root, outDir) {
  const seen = new Set();
  const sources = [];
  const notes = [];
  try {
    const ledger = await readJson(root, 'processed-jobs.json');
    let n = 0;
    for (const [key, job] of Object.entries(ledger.jobs || {})) {
      seen.add(String(key));
      if (job?.url) seen.add(String(job.url));
      if (job?.company && job?.title) seen.add(`ct:${norm(job.company)}|${norm(job.title)}`);
      n += 1;
    }
    sources.push(`processed-jobs.json (${n})`);
  } catch (err) {
    if (!/ENOENT|no such file|not a file|does not exist/i.test(err.message)) notes.push(`processed-jobs.json skipped: ${err.message}`);
  }
  let files = [];
  try {
    files = (await pc.call('list_dir', { root, path: outDir })).entries.filter((e) => e.type === 'file' && /-manual-.*\.json$/i.test(e.name));
  } catch {
    // the region folder does not exist yet
  }
  for (const f of files) {
    try {
      const jobs = await readJson(root, `${outDir}/${f.name}`);
      for (const j of Array.isArray(jobs) ? jobs : []) {
        for (const k of [j.id, j.link, j.applyUrl, linkedinId(j.link)]) if (k) seen.add(String(k));
        if (j.companyName && j.title) seen.add(`ctl:${norm(j.companyName)}|${norm(j.title)}|${norm(j.location)}`);
      }
      sources.push(`${outDir}/${f.name} (${Array.isArray(jobs) ? jobs.length : 0})`);
    } catch (err) {
      notes.push(`${f.name} skipped: ${err.message}`);
    }
  }
  return { seen, sources, notes };
}

export function isSeen(seen, row, opts) {
  return rowKeys(row, opts).some((k) => seen.has(k));
}

// ---------------------------------------------------------------------------
// Output: CSV (Excel-friendly) + draft JSON for import-manual-jobs, then the import itself.

export async function saveJobs(ctx, { root, rootPath, outDir, stem, rows, draftOpts, draftIds, runImport, columns = JOB_COLUMNS, makeDraft }) {
  const date = today();
  const csv = await writeUnique('write_csv', { root, path: `${outDir}/${stem}.csv`, rows, columns });
  const drafts = rows.map((r, i) => (makeDraft ? makeDraft(r, date) : toDraftEntry(r, date, { ...draftOpts, id: draftIds?.[i] })));
  const draft = await writeUnique('write_file', { root, path: `${outDir}/${stem}-draft.json`, content: JSON.stringify(drafts, null, 2) });
  let importNote = 'Import skipped.';
  if (runImport !== false && ctx.host.scripts.some((s) => s.name === 'import-manual-jobs')) {
    const rel = draft.path.slice(rootPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    const res = await pc.call('run_script', { name: 'import-manual-jobs', args: ['build', rel] });
    importNote = res.exitCode === 0 ? `Import OK: ${res.stdout.trim()}` : `Import failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`;
  }
  return { csv, draft, importNote };
}

async function readDescription(tabId, selectors, heading) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [selectors, heading],
    func: (sels, head) => {
      let el = sels.map((s) => document.querySelector(s)).find((n) => n && n.innerText.trim());
      if (!el && head) {
        const h = [...document.querySelectorAll('h1, h2, h3, h4, .title')].find((n) => n.textContent.trim().startsWith(head));
        el = h?.nextElementSibling;
      }
      return (el?.innerText || '').trim();
    },
  }).catch(() => [{ result: '' }]);
  return res?.result || '';
}

async function scrollToBottom(tabId, listSelector) {
  await chrome.scripting.executeScript({
    target: { tabId },
    args: [listSelector || ''],
    func: (sel) => {
      const list = sel ? document.querySelector(sel) : null;
      (list || document.scrollingElement).scrollTop = (list || document.scrollingElement).scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
    },
  }).catch(() => {});
}

// Shared tool-input properties for job-board recipes.
export function jobBoardSchema({ locationDesc, outDirDesc }) {
  return {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keywords, e.g. "全栈工程师", "Python", "Full Stack Engineer".' },
      city: { type: 'string', description: locationDesc },
      max_jobs: { type: 'number', description: 'How many NEW jobs to collect (default 30, max 150). Jobs already in processed-jobs.json or earlier imports are skipped.' },
      details: { type: 'number', description: 'Open this many job pages to read the full description (default: all collected; 0 = list data only, faster).' },
      out_dir: { type: 'string', description: outDirDesc },
      run_import: { type: 'boolean', description: 'Run import-manual-jobs build on the draft (default true).' },
      include_seen: { type: 'boolean', description: 'Keep jobs that were already collected before (default false).' },
    },
    required: ['query'],
  };
}

/*
 * Generic job-board run. spec:
 *   key, label, source, country, defaultBase, defaultOutDir, apiPattern, paging ('scroll' | 'url'),
 *   probe (pageProbe patterns), loginHost, listSelector,
 *   resolveLocation(input) -> { name, code }, searchUrl(base, query, loc, page),
 *   parse(json) -> { items, hasMore, error }, idOf(item), mapRow(item, base) -> row,
 *   draftId(row)?, detailSelectors, detailHeading, maxPages
 * Settings `<key>BaseUrl` and `<key>ApiPattern` override the site URL and API pattern
 * (used by the mock-site tests, and to fix an endpoint without a code change).
 */
export async function collectJobBoard(ctx, input, spec) {
  const { root, rootPath } = requireHost(ctx);
  const base = (ctx.settings[`${spec.key}BaseUrl`] || spec.defaultBase).replace(/\/+$/, '');
  const apiPattern = ctx.settings[`${spec.key}ApiPattern`] || spec.apiPattern;
  const query = String(input.query || '').trim();
  if (!query) throw new Error('query is required.');
  const loc = spec.resolveLocation(input);
  const maxJobs = Math.min(Math.max(Number(input.max_jobs) || 30, 1), 150);
  const outDir = String(input.out_dir || spec.defaultOutDir(loc)).replace(/[\\/]+$/, '');
  const status = (t) => ctx.emit?.({ type: 'status', text: t });
  const guard = () => guardPage(ctx, spec.label, spec.probe, spec.loginHost);
  const draftId = (row) => (spec.draftId ? spec.draftId(row) : row.jobId ? `${spec.key}-${row.jobId}` : undefined);
  const rowOpts = (row) => ({ country: spec.country, draftId: draftId(row) });

  const known = input.include_seen ? { seen: new Set(), sources: [], notes: [] } : await loadSeenJobs(root, outDir);
  let skippedSeen = 0;

  // 1. Search results, read from the site's own API responses.
  await cdp.startCapture(ctx.tabId, apiPattern);
  let seq = cdp.lastCaptureSeq();
  let page = 1;
  let pageUrl = spec.searchUrl(base, query, loc, page);
  status(`${spec.label}: searching "${query}" in ${loc.name}…`);
  await openUrl(ctx, pageUrl);
  await jitter(ctx, 2, 4);
  if (await guard()) {
    await openUrl(ctx, pageUrl);
    await jitter(ctx, 2, 4);
  }

  const byId = new Map();
  const seenIds = new Set();
  let hasMore = true;
  let idle = 0;
  while (byId.size < maxJobs && hasMore) {
    if (ctx.running === false) throw new Error('Stopped by the user.');
    const caps = cdp.readCaptured(ctx.tabId, { pattern: apiPattern, sinceSeq: seq });
    if (caps.length) seq = caps[caps.length - 1].seq;
    let apiError = null;
    let progress = false;
    for (const c of caps) {
      let data;
      try {
        data = JSON.parse(c.body);
      } catch {
        continue;
      }
      const got = spec.parse(data);
      if (got.error) {
        apiError = got.error;
        continue;
      }
      if (got.items.length) progress = true;
      if (got.hasMore === false) hasMore = false;
      for (const item of got.items) {
        const id = spec.idOf(item);
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const row = spec.mapRow(item, base);
        if (isSeen(known.seen, row, rowOpts(row))) {
          skippedSeen += 1;
          continue;
        }
        if (byId.size < maxJobs) byId.set(id, row);
      }
    }
    if (apiError) {
      await waitForUser(ctx, spec.label, `${spec.label} rejected the search (${apiError}); usually a login or verification is needed`, async () => {
        const p = await pageProbe(ctx.tabId, spec.probe);
        return p && !p.verification && !p.login;
      });
      await openUrl(ctx, pageUrl);
      await jitter(ctx, 2, 4);
      hasMore = true;
      continue;
    }
    status(`${spec.label}: ${byId.size} new jobs collected${skippedSeen ? ` (${skippedSeen} already known, skipped)` : ''}…`);
    if (byId.size >= maxJobs || !hasMore) break;
    idle = progress ? 0 : idle + 1;
    const nextPage = async () => {
      page += 1;
      pageUrl = spec.searchUrl(base, query, loc, page);
      await openUrl(ctx, pageUrl);
      idle = 0;
    };
    if (spec.paging === 'url') {
      if (progress) {
        if (page >= (spec.maxPages || 10)) break;
        await nextPage();
      } else if (idle >= 3) {
        break;
      }
    } else if (idle >= 3) {
      // Infinite scroll did not load more: try the paged URL.
      if (page >= (spec.maxPages || 10)) break;
      await nextPage();
    } else {
      await scrollToBottom(ctx.tabId, spec.listSelector);
    }
    await jitter(ctx, 2.5, 5);
    await guard();
  }
  if (!byId.size) {
    if (skippedSeen) return [{ type: 'text', text: `No new jobs: all ${skippedSeen} jobs found for "${query}" in ${loc.name} were collected before (${known.sources.join(', ')}).` }];
    throw new Error(`No jobs were captured. Check you are logged in to ${spec.loginHost} and the search shows results in the tab. Do not write job entries by hand: tell the user what happened instead.`);
  }
  const rows = [...byId.values()];

  // 2. Full descriptions from detail pages (slow on purpose). Rows that already have one are skipped.
  const detailCount = input.details === undefined ? rows.length : Math.min(Math.max(Number(input.details) || 0, 0), rows.length);
  for (let i = 0; i < detailCount; i += 1) {
    if (ctx.running === false) break;
    const row = rows[i];
    if (!row.link || row.description) continue;
    status(`${spec.label}: reading job ${i + 1}/${detailCount}: ${row.title} @ ${row.company}`);
    await openUrl(ctx, row.link);
    await jitter(ctx, 1.5, 3);
    if (await guard()) await openUrl(ctx, row.link);
    row.description = await readDescription(ctx.tabId, spec.detailSelectors, spec.detailHeading);
    await jitter(ctx, 3, 7);
  }
  for (const row of rows) if (row.description) Object.assign(row, fitSignals(row.description));

  // 3. Save CSV + draft on the PC, then import.
  const stem = `${spec.key}-${safeName(query)}-${safeName(loc.name)}-${today()}`;
  const { csv, draft, importNote } = await saveJobs(ctx, {
    root, rootPath, outDir, stem, rows,
    draftOpts: { source: spec.source, label: spec.label, country: spec.country },
    draftIds: rows.map(draftId),
    runImport: input.run_import,
  });
  log('recipe_done', { runId: ctx.runId, recipe: spec.key, rows: rows.length, skippedSeen, csv: csv.path });

  const withDesc = rows.filter((r) => r.description).length;
  const dedupNote = input.include_seen
    ? 'De-duplication off (include_seen).'
    : `Skipped ${skippedSeen} job(s) already collected before${known.sources.length ? ` (checked ${known.sources.join(', ')})` : ''}.${known.notes.length ? ` Notes: ${known.notes.join('; ')}` : ''}`;
  const preview = rows.slice(0, 8).map((r, i) => `${i + 1}. ${r.title} | ${r.company} | ${r.salary} | ${r.city} ${r.district}`).join('\n');
  return [{
    type: 'text',
    text: `Collected ${rows.length} new jobs for "${query}" in ${loc.name} (${withDesc} with full description).\n${dedupNote}\nCSV: ${csv.path}\nDraft: ${draft.path}\n${importNote}\n\nFirst rows:\n${preview}`,
  }];
}
