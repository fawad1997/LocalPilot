// ForexFactory economic calendar, week by week -> Quantara's events CSV (D:\AI\Trading).
// Quantara's backtests read news times from its economic_events table, which only had a few
// future FOMC dates plus the current week (calendar_sync). This fills in the history:
//   datasets/calendar_<from>_<to>.csv           datetime_utc,currency,impact,title  (import-events format)
//   datasets/calendar_<from>_<to>_detailed.csv  + actual, forecast, previous, flags
// Times come from the page's own calendar data (epoch seconds) when it has them; otherwise from
// the table, with the time zone worked out from releases whose New York time is fixed (8:30 / 14:00).
// Either way a self-check against those releases must pass, or nothing is written.
// The live page's window.calendarComponentStates was checked on 2026-10-20 (name, currency, impactName,
// dateline, timeLabel, actual/forecast/previous; NFP at 12:30 UTC). A full run through the extension
// has not been done yet: run one past month first.
import { jitter, openUrl, guardPage, requireRoot, writeUnique } from './common.js';
import { handleBotCheck } from '../botcheck.js';
import { log } from '../logger.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 86400000;
const MAX_WEEKS = 106; // about two years per call
export const CALENDAR_COLUMNS = ['datetime_utc', 'currency', 'impact', 'title'];
export const DETAILED_COLUMNS = ['datetime_utc', 'currency', 'impact', 'title', 'actual', 'forecast', 'previous', 'time_label', 'flags', 'week'];

// Releases whose New York time never changes; used to check (and, for the table, find) the time zone.
const FIXED_NY = [
  { re: /^(non-farm employment change|unemployment rate|average hourly earnings m\/m|cpi m\/m|core cpi m\/m|cpi y\/y|retail sales m\/m|core retail sales m\/m|unemployment claims|(advance|prelim|final) gdp q\/q|core pce price index m\/m|ppi m\/m|core ppi m\/m)$/i, h: 8, m: 30 },
  { re: /^(fomc statement|federal funds rate)$/i, h: 14, m: 0 },
];

// --- dates ------------------------------------------------------------------------

export function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) throw new Error(`Dates are YYYY-MM-DD (got "${s}").`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(t).getUTCDate() !== Number(m[3])) throw new Error(`"${s}" is not a real date.`);
  return t;
}

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

// ForexFactory weeks start on Sunday; every Sunday from the one on/before `from` up to `to`.
export function weekStarts(fromMs, toMs) {
  if (toMs < fromMs) throw new Error('"to" is before "from".');
  const first = fromMs - new Date(fromMs).getUTCDay() * DAY_MS;
  const out = [];
  for (let t = first; t <= toMs; t += 7 * DAY_MS) out.push(t);
  if (out.length > MAX_WEEKS) throw new Error(`That is ${out.length} weeks; ask for at most two years (${MAX_WEEKS} weeks) per run.`);
  return out;
}

// 2026-10-18 -> "oct18.2026"
export function weekParam(t) {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]}${d.getUTCDate()}.${d.getUTCFullYear()}`;
}

// Minutes east of UTC for `timeZone` at instant t (New York summer time: -240).
export function zoneOffsetMinutes(t, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - t) / 60000);
}

// UTC epoch ms of a New York wall-clock time on a calendar day (dayMs = UTC midnight of that day).
export function nyToUtc(dayMs, h, m) {
  const wall = dayMs + (h * 60 + m) * 60000;
  let t = wall - zoneOffsetMinutes(wall) * 60000;
  t = wall - zoneOffsetMinutes(t) * 60000; // second pass settles DST edges
  return t;
}

export function formatUtc(t) {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

export function normImpact(v) {
  const s = String(v || '').toLowerCase();
  if (/high|red/.test(s)) return 'HIGH';
  if (/medium|ora/.test(s)) return 'MEDIUM';
  if (/low|yel/.test(s)) return 'LOW';
  if (/holiday|gra|non-economic/.test(s)) return 'HOLIDAY';
  return s ? s.toUpperCase() : '';
}

// "8:30am" -> {h: 8, m: 30}; anything else ("All Day", "Tentative", "Day 2") -> null
export function parseClock(label) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap]m)$/i.exec(String(label || '').trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return { h, m: Number(m[2]) };
}

// --- page data -> events ------------------------------------------------------------

// From the calendar's embedded state (window.calendarComponentStates): epoch seconds, no time zone guessing.
export function fromState(items, week) {
  return (items || []).map((e) => {
    const clock = parseClock(e.timeLabel);
    const dated = Number.isFinite(Number(e.dateline)) && Number(e.dateline) > 0;
    const timed = dated && (clock || !e.timeLabel);
    return {
      utc: timed ? Number(e.dateline) * 1000 : null,
      day: dated ? Number(e.dateline) * 1000 : null,
      currency: String(e.currency || e.country || '').trim().toUpperCase(),
      impact: normImpact(e.impactName || e.impactTitle || e.impactClass),
      title: String(e.name || e.title || '').trim(),
      actual: String(e.actual ?? '').trim(),
      forecast: String(e.forecast ?? '').trim(),
      previous: String(e.previous ?? '').trim(),
      timeLabel: String(e.timeLabel || '').trim(),
      flags: timed ? '' : String(e.timeLabel || 'no time').trim(),
      week,
    };
  });
}

// "Mon Oct 19" (or "MonOct 19") in the week starting weekStart -> UTC midnight of that day.
export function dayFromLabel(label, weekStart) {
  const m = /([A-Za-z]{3})\s*(\d{1,2})\s*$/.exec(String(label || '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const start = new Date(weekStart);
  let year = start.getUTCFullYear();
  if (month < start.getUTCMonth()) year += 1; // a week from Dec 28 into January
  return Date.UTC(year, month, Number(m[2]));
}

// From the table: local wall-clock times in whatever zone the page shows (offset applied later).
export function fromDom(rows, weekStart, week) {
  let day = null;
  let clockLabel = '';
  const out = [];
  for (const r of rows || []) {
    if (r.dateLabel) {
      day = dayFromLabel(r.dateLabel, weekStart) ?? day;
      clockLabel = '';
    }
    if (r.timeLabel) clockLabel = r.timeLabel; // a blank time cell means "same as the row above"
    if (!r.currency || !r.title || day == null) continue;
    const clock = parseClock(clockLabel);
    out.push({
      local: clock ? day + (clock.h * 60 + clock.m) * 60000 : null,
      utc: null,
      day,
      currency: String(r.currency).trim().toUpperCase(),
      impact: normImpact(r.impact),
      title: String(r.title).trim(),
      actual: String(r.actual || '').trim(),
      forecast: String(r.forecast || '').trim(),
      previous: String(r.previous || '').trim(),
      timeLabel: clockLabel,
      flags: clock ? '' : clockLabel || 'no time',
      week,
    });
  }
  return out;
}

const fixedRule = (e) => (e.currency === 'USD' ? FIXED_NY.find((r) => r.re.test(e.title)) : null);
const utcMidnight = (t) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());

// Table times: the page's offset from UTC in minutes, found from releases with a fixed New York time.
// Near midnight the page's date can be a day off New York's, so each release votes for every
// plausible offset (within ±14 h, whole quarter hours) and the most common one wins.
export function inferOffset(events) {
  const counts = new Map();
  for (const e of events) {
    const rule = e.local != null && fixedRule(e);
    if (!rule) continue;
    for (const shift of [0, -DAY_MS, DAY_MS]) {
      const off = Math.round((e.local - nyToUtc(utcMidnight(e.local) + shift, rule.h, rule.m)) / 60000);
      if (Math.abs(off) <= 14 * 60 && off % 15 === 0) counts.set(off, (counts.get(off) || 0) + 1);
    }
  }
  let best = null;
  for (const [off, n] of counts) if (!best || n > best.n) best = { off, n };
  return best ? best.off : null;
}

// Every release with a fixed New York time must land on it. Returns {checked, wrong: [...]}.
export function selfCheck(events) {
  let checked = 0;
  const wrong = [];
  for (const e of events) {
    const rule = e.utc != null && fixedRule(e);
    if (!rule) continue;
    checked += 1;
    const nyDay = utcMidnight(e.utc + zoneOffsetMinutes(e.utc) * 60000); // the release's New York date
    const want = nyToUtc(nyDay, rule.h, rule.m);
    if (want !== e.utc) wrong.push(`${e.title} on ${isoDay(nyDay)} parsed as ${formatUtc(e.utc)} UTC, expected ${formatUtc(want)} UTC`);
  }
  return { checked, wrong };
}

export function keep(e, { fromMs, toMs, currencies, impacts }) {
  const t = e.utc ?? e.local ?? e.day;
  if (t != null && (t < fromMs || t >= toMs + DAY_MS)) return false;
  if (currencies.length && !currencies.includes(e.currency)) return false;
  if (impacts.length && !impacts.includes(e.impact)) return false;
  return true;
}

export function toImportRows(events) {
  return events
    .filter((e) => e.utc != null)
    .sort((a, b) => a.utc - b.utc)
    .map((e) => ({ datetime_utc: formatUtc(e.utc), currency: e.currency, impact: e.impact, title: e.title }));
}

export function toDetailedRows(events) {
  return [...events]
    .sort((a, b) => (a.utc ?? a.local ?? a.day ?? 0) - (b.utc ?? b.local ?? b.day ?? 0))
    .map((e) => ({
      datetime_utc: e.utc != null ? formatUtc(e.utc) : '', currency: e.currency, impact: e.impact, title: e.title,
      actual: e.actual, forecast: e.forecast, previous: e.previous, time_label: e.timeLabel, flags: e.flags, week: e.week,
    }));
}

// --- in the page ---------------------------------------------------------------------

async function readState(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN', // the calendar's data lives in the page's own JavaScript
    func: () => {
      const st = window.calendarComponentStates;
      if (!st || typeof st !== 'object') return null;
      const out = [];
      for (const comp of Object.values(st)) {
        for (const day of comp?.days || []) {
          for (const e of day?.events || []) {
            out.push({
              name: e.name ?? e.title, currency: e.currency ?? e.country, impactName: e.impactName, impactTitle: e.impactTitle, impactClass: e.impactClass,
              dateline: e.dateline, timeLabel: e.timeLabel, actual: e.actual, forecast: e.forecast, previous: e.previous,
            });
          }
        }
      }
      return out;
    },
  }).catch(() => [{ result: null }]);
  return res?.result || null;
}

async function readTable(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const cell = (r, sel) => (r.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('tr.calendar__row')].map((r) => ({
        dateLabel: cell(r, '.calendar__date'),
        timeLabel: cell(r, '.calendar__time'),
        currency: cell(r, '.calendar__currency'),
        impact: [...(r.querySelector('.calendar__impact span, .calendar__impact i')?.classList || [])].join(' ') || r.querySelector('.calendar__impact span')?.title || '',
        title: cell(r, '.calendar__event-title') || cell(r, '.calendar__event'),
        actual: cell(r, '.calendar__actual'),
        forecast: cell(r, '.calendar__forecast'),
        previous: cell(r, '.calendar__previous'),
      }));
    },
  }).catch(() => [{ result: [] }]);
  return res?.result || [];
}

const PROBE = {
  verifyUrl: '__cf_chl|/cdn-cgi/challenge',
  verifyText: 'Verify you are human|Checking your browser|Just a moment\\.\\.\\.|needs to review the security of your connection',
  loginUrl: '^/login',
  loginText: '(?!)',
};

// --- the recipe ---------------------------------------------------------------------------

async function run(ctx, input) {
  const { root } = requireRoot(ctx, 'trading', '{"name": "trading", "path": "<your Quantara research folder>", "writable": true}');
  const fromMs = parseDay(input.from);
  const toMs = parseDay(input.to);
  const weeks = weekStarts(fromMs, toMs);
  const currencies = (input.currencies?.length ? input.currencies : ['USD']).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  const impacts = (input.impacts?.length ? input.impacts : ['HIGH']).map((c) => String(c).trim().toUpperCase()).filter((c) => c && c !== 'ALL');
  const base = (ctx.settings.forexfactoryBaseUrl || 'https://www.forexfactory.com').replace(/\/+$/, '');
  const status = (t) => ctx.emit?.({ type: 'status', text: t });
  const all = [];
  const notes = [];
  let source = '';
  let offset = null;

  for (let i = 0; i < weeks.length; i += 1) {
    if (ctx.running === false) throw new Error('Stopped by the user.');
    const week = weekParam(weeks[i]);
    status(`ForexFactory week ${i + 1}/${weeks.length} (${week})…`);
    await openUrl(ctx, `${base}/calendar?week=${week}`);
    if (await guardPage(ctx, 'ForexFactory', PROBE, 'forexfactory.com')) await openUrl(ctx, `${base}/calendar?week=${week}`);
    const bot = await handleBotCheck(ctx, 'econ_calendar_collect');
    if (/BOT CHECK DETECTED/.test(bot)) throw new Error(`${bot.trim()} Run the tool again after the check is done.`);

    let events;
    const state = await readState(ctx.tabId);
    if (state?.length) {
      events = fromState(state, week);
      source ||= 'page data (epoch times)';
    } else {
      events = fromDom(await readTable(ctx.tabId), weeks[i], week);
      if (events.length) {
        source ||= 'calendar table';
        const found = inferOffset(events);
        if (found != null) offset = found;
        if (offset == null && input.page_utc_offset != null) offset = Math.round(Number(input.page_utc_offset) * 60);
        if (offset == null) throw new Error(`Could not tell which time zone ${base} shows (week ${week} has no NFP/CPI/FOMC-type release to compare with). Pass page_utc_offset (hours, e.g. 2 for CEST) and run again.`);
        for (const e of events) if (e.local != null) e.utc = e.local - offset * 60000;
      }
    }
    if (!events.length) notes.push(`${week}: no calendar rows found`);
    all.push(...events);
    log('recipe_progress', { runId: ctx.runId, recipe: 'econ_calendar_collect', week, events: events.length });
    if (i < weeks.length - 1) await jitter(ctx, 3, 6);
  }

  if (!all.length) throw new Error(`No calendar events were read from ${base} (${weeks.length} week(s)). The page layout may have changed or the page did not load; nothing was written. Do not write events by hand.`);
  const check = selfCheck(all);
  if (check.checked && check.wrong.length * 2 > check.checked) {
    throw new Error(`Time-zone self-check failed (${check.wrong.length} of ${check.checked} fixed-time releases are off, e.g. ${check.wrong[0]}). Nothing was written. Set ForexFactory's time zone to UTC, or pass page_utc_offset.`);
  }
  if (check.wrong.length) notes.push(`${check.wrong.length} release(s) not at their usual time: ${check.wrong.slice(0, 3).join('; ')}`);
  if (!check.checked) notes.push('no NFP/CPI/FOMC-type release in range, so times were not self-checked');

  const kept = all.filter((e) => keep(e, { fromMs, toMs, currencies, impacts }));
  const importRows = toImportRows(kept);
  const stem = `datasets/calendar_${isoDay(fromMs)}_${isoDay(toMs)}${currencies.length === 1 && currencies[0] !== 'USD' ? `_${currencies[0]}` : ''}`;
  // No BOM: Quantara's load_events_csv opens the file as plain UTF-8.
  const main = importRows.length
    ? await writeUnique('write_csv', { root, path: `${stem}.csv`, columns: CALENDAR_COLUMNS, rows: importRows, bom: false })
    : null;
  const detailed = await writeUnique('write_csv', { root, path: `${stem}_detailed.csv`, columns: DETAILED_COLUMNS, rows: toDetailedRows(kept), bom: false });
  const untimed = kept.length - importRows.length;
  const rel = main ? `research/datasets/${main.path.split(/[\\/]/).pop()}` : ''; // the trading root is your Quantara research folder
  return [{
    type: 'text',
    text: [
      `Read ${all.length} events from ${weeks.length} ForexFactory week(s) (${source}). Kept ${kept.length} ${currencies.join('/')} ${impacts.length ? impacts.join('/') : 'all-impact'} events from ${isoDay(fromMs)} to ${isoDay(toMs)}.`,
      main ? `Import file: ${main.path} (${importRows.length} timed events)` : 'No timed events matched, so no import file was written.',
      `Detailed file: ${detailed.path} (with actual / forecast / previous${untimed ? `; ${untimed} all-day or tentative events are only here` : ''})`,
      `Self-check: ${check.checked ? `${check.checked - check.wrong.length} of ${check.checked} fixed-time releases at their usual New York time` : 'not possible'}.`,
      ...(notes.length ? [`Notes: ${notes.join(' | ')}`] : []),
      ...(main ? [`Next step (the user or Claude Code runs it in the Quantara project folder): python -m app.main import-events ${rel}`] : []),
    ].join('\n'),
  }];
}

export default {
  definition: {
    name: 'econ_calendar_collect',
    description:
      'Collect past (or upcoming) economic-calendar events from ForexFactory, week by week in this tab, into CSV files for the Quantara trading bot (PC root "trading"): ' +
      'an import file (datetime_utc,currency,impact,title) for `python -m app.main import-events` and a detailed file with actual/forecast/previous. ' +
      'Default USD high-impact. Times are converted to UTC and self-checked against NFP/CPI/FOMC. Pauses on Cloudflare checks for the user.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD (at most about two years after from)' },
        currencies: { type: 'array', items: { type: 'string' }, description: 'Default ["USD"]' },
        impacts: { type: 'array', items: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'HOLIDAY', 'ALL'] }, description: 'Default ["HIGH"]' },
        page_utc_offset: { type: 'number', description: 'Only if the tool asks for it: the hours ForexFactory\'s times are ahead of UTC.' },
      },
      required: ['from', 'to'],
    },
  },
  domains: ['forexfactory.com'],
  approval: 'forexfactory.com + PC files (trading)',
  promptHint: 'For historical economic-calendar / news-event times for Quantara backtests, use econ_calendar_collect (writes the import-events CSV; it never trades).',
  run,
};
