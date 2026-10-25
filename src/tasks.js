// Saved tasks: a name, a prompt and an optional start URL, run from the panel ("/name")
// or on a schedule (chrome.alarms). Stored in chrome.storage.local.
//   schedule: { kind: 'daily' | 'weekdays', time: 'HH:MM' } | { kind: 'interval', minutes } | null
//   notifyOn: 'always' | 'change' | 'keyword' (+ keyword)
//   watch:    { selector } -> a page watch: no model; the text at `url` is compared with the last run
//   replay:   { steps, savedAt } -> the steps of the last successful run, replayed without the model
//             (useReplay false turns that off); dropped when the prompt or start URL changes
const KEY = 'savedTasks';
const RUNS_KEY = 'savedTaskRuns';
export const ALARM_PREFIX = 'task:';
export const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const TIME = /^\d{1,2}:\d{2}$/;

export async function listTasks() {
  return ((await chrome.storage.local.get(KEY))[KEY] || []).map(migrate);
}

// Tasks saved before 0.6 only had `daily: 'HH:MM'`.
export function migrate(task) {
  if (task.schedule === undefined) {
    return { ...task, schedule: task.daily && TIME.test(task.daily) ? { kind: 'daily', time: task.daily } : null, notifyOn: task.notifyOn || 'always' };
  }
  return { notifyOn: 'always', ...task };
}

// Built-in panel commands (/help, /tasks, /new, /attach, /test, /record); saved tasks cannot use these names.
export const RESERVED_NAMES = ['help', 'tasks', 'new', 'attach', 'test', 'record'];

export function validName(name) {
  return /^[\p{L}\p{N}_-]{1,40}$/u.test(String(name || ''));
}

// "HH:MM" -> next local time it occurs (ms epoch).
export function nextDaily(time, now = new Date()) {
  const [h, m] = String(time).split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function normalizeSchedule(input = {}) {
  const raw = input.schedule !== undefined ? input.schedule : input.daily ? { kind: 'daily', time: input.daily } : null;
  if (!raw || !raw.kind || raw.kind === 'off') return null;
  if (raw.kind === 'daily' || raw.kind === 'weekdays') {
    const time = String(raw.time || '');
    const [h, m] = time.split(':').map(Number);
    if (!TIME.test(time) || h > 23 || m > 59) throw new Error('Pick a time (HH:MM) for the schedule.');
    return { kind: raw.kind, time };
  }
  if (raw.kind === 'interval') {
    const minutes = Math.round(Number(raw.minutes));
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) throw new Error(`Repeat at most every ${MIN_INTERVAL_MINUTES} minutes.`);
    return { kind: 'interval', minutes: Math.min(minutes, MAX_INTERVAL_MINUTES) };
  }
  throw new Error(`Unknown schedule "${raw.kind}".`);
}

export function describeSchedule(schedule) {
  if (!schedule) return '';
  if (schedule.kind === 'daily') return `daily ${schedule.time}`;
  if (schedule.kind === 'weekdays') return `weekdays ${schedule.time}`;
  if (schedule.kind === 'interval') return schedule.minutes % 60 === 0 ? `every ${schedule.minutes / 60} h` : `every ${schedule.minutes} min`;
  return '';
}

const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

// Should a scheduled run go ahead now? Weekday tasks use a daily alarm that skips Saturday and Sunday.
export function isDue(schedule, at = new Date()) {
  return !(schedule?.kind === 'weekdays' && isWeekend(at));
}

// When the schedule next fires (ms epoch).
export function nextRun(schedule, now = new Date()) {
  if (!schedule) return null;
  if (schedule.kind === 'interval') return now.getTime() + schedule.minutes * 60000;
  let at = nextDaily(schedule.time, now);
  if (schedule.kind === 'weekdays') {
    while (isWeekend(new Date(at))) at = nextDaily(schedule.time, new Date(at));
  }
  return at;
}

async function schedule(task) {
  await chrome.alarms.clear(ALARM_PREFIX + task.id);
  const s = task.schedule;
  if (!s) return;
  const periodInMinutes = s.kind === 'interval' ? s.minutes : 24 * 60;
  await chrome.alarms.create(ALARM_PREFIX + task.id, { when: nextRun(s), periodInMinutes });
}

export async function saveTask(input) {
  const name = String(input.name || '').trim();
  if (!validName(name)) throw new Error('Task names are 1-40 letters, digits, "-" or "_" (used as /name).');
  if (RESERVED_NAMES.includes(name.toLowerCase())) throw new Error(`"/${name}" is a built-in command. Pick another name.`);
  const url = String(input.url || '').trim();
  const watch = input.watch ? { selector: String(input.watch.selector || '').trim() } : null;
  const prompt = String(input.prompt || '').trim();
  if (watch && !/^https?:\/\//i.test(url)) throw new Error('A page watch needs a start URL (http or https).');
  if (!watch && !prompt) throw new Error('A saved task needs a prompt.');
  const notifyOn = ['always', 'change', 'keyword'].includes(input.notifyOn) ? input.notifyOn : watch ? 'change' : 'always';
  const keyword = String(input.keyword || '').trim();
  if (notifyOn === 'keyword' && !keyword) throw new Error('Enter the word to look for, or pick another "Notify" option.');
  const sched = normalizeSchedule(input);
  const tasks = await listTasks();
  const existing = tasks.find((t) => t.id === input.id) || tasks.find((t) => t.name.toLowerCase() === name.toLowerCase());
  const task = {
    id: existing?.id || crypto.randomUUID(),
    name,
    prompt,
    url,
    schedule: sched,
    daily: sched?.kind === 'daily' ? sched.time : '', // kept for older panels
    notifyOn,
    keyword,
    watch,
    useReplay: input.useReplay !== false,
    allowedDomains: parseDomains(input.allowedDomains),
    // The saved steps belong to this prompt and start page; a changed task is learned again.
    replay: existing && existing.prompt === prompt && existing.url === url && !input.forgetReplay ? existing.replay || null : null,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  const next = existing ? tasks.map((t) => (t.id === existing.id ? task : t)) : [...tasks, task];
  await chrome.storage.local.set({ [KEY]: next });
  await schedule(task);
  if (existing) {
    // An edited task starts a new baseline: the next run is compared with nothing.
    const runs = await lastRuns();
    if (runs[task.id]) {
      delete runs[task.id].hash;
      delete runs[task.id].snapshot;
      await chrome.storage.local.set({ [RUNS_KEY]: runs });
    }
  }
  return task;
}

// "example.com, shop.example.org" or a list -> ['example.com', 'shop.example.org']
export function parseDomains(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  return [...new Set(list.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean))];
}

export const MAX_REPLAY_STEPS = 60;

export async function saveReplay(id, steps) {
  const all = await listTasks();
  const task = all.find((t) => t.id === id);
  if (!task || !steps.length || steps.length > MAX_REPLAY_STEPS) return null;
  task.replay = { steps, savedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [KEY]: all });
  return task;
}

export async function clearReplay(id) {
  const all = await listTasks();
  const task = all.find((t) => t.id === id);
  if (!task) return;
  task.replay = null;
  await chrome.storage.local.set({ [KEY]: all });
}

// What a run of this task should replay: nothing when turned off, for page watches, or when
// the user added words to the prompt (then it is a different task).
export function replayFor(task, extra = '') {
  return task && !task.watch && task.useReplay !== false && !String(extra || '').trim() ? task.replay?.steps || null : null;
}

export async function deleteTask(id) {
  const tasks = await listTasks();
  await chrome.storage.local.set({ [KEY]: tasks.filter((t) => t.id !== id) });
  await chrome.alarms.clear(ALARM_PREFIX + id);
  const runs = await lastRuns();
  if (runs[id]) {
    delete runs[id];
    await chrome.storage.local.set({ [RUNS_KEY]: runs });
  }
}

export async function findTask(nameOrId) {
  const key = String(nameOrId || '').replace(/^\//, '').toLowerCase();
  return (await listTasks()).find((t) => t.id === nameOrId || t.name.toLowerCase() === key) || null;
}

// Re-create alarms that are missing (e.g. after the extension was reloaded).
export async function ensureSchedules() {
  for (const task of await listTasks()) {
    if (task.schedule && !(await chrome.alarms.get(ALARM_PREFIX + task.id))) await schedule(task);
  }
}

export async function recordRun(taskId, run) {
  const runs = (await chrome.storage.local.get(RUNS_KEY))[RUNS_KEY] || {};
  runs[taskId] = run;
  await chrome.storage.local.set({ [RUNS_KEY]: runs });
}

export async function lastRuns() {
  return (await chrome.storage.local.get(RUNS_KEY))[RUNS_KEY] || {};
}

// --- change detection ------------------------------------------------------------

export function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// FNV-1a 32-bit over the whitespace-normalized text.
export function hashText(s) {
  let h = 0x811c9dc5;
  const t = normalizeText(s);
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Lines of `next` that were not in `prev` (at most `max`), for "what changed" notifications.
export function newLines(prev, next, max = 3) {
  const before = new Set(String(prev || '').split('\n').map(normalizeText).filter(Boolean));
  const out = [];
  for (const line of String(next || '').split('\n').map(normalizeText)) {
    if (line && !before.has(line) && !out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

// run / prev: this and the previous run record ({ ok, hash, text, snapshot? }). A failed run always notifies.
export function shouldNotify(task, run, prev) {
  if (!run.ok) return true;
  const mode = task.notifyOn || 'always';
  if (mode === 'always') return true;
  const changed = !prev || prev.hash !== run.hash;
  if (mode === 'change') return changed;
  if (mode === 'keyword') {
    const kw = String(task.keyword || '').trim().toLowerCase();
    return !!kw && changed && String(run.snapshot || run.text || '').toLowerCase().includes(kw);
  }
  return true;
}
