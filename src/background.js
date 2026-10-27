// Service worker: per-tab side panels and conversations, approval round-trips,
// and the MCP bridge (Claude Code and other MCP clients driving this browser).
import { AgentRun, Conversation } from './agent.js';
import { loadSettings, saveSettings } from './settings.js';
import { startMcpBridge, ensureHost } from './mcpbridge.js';
import { probe } from './pcbridge.js';
import { log, flush as flushLogs } from './logger.js';
import { runTool, callPage } from './tools.js';
import { detectBotCheck } from './botcheck.js';
import { detach as cdpDetach, isAttached as cdpIsAttached, retain as cdpRetain } from './cdp.js';
import * as tasks from './tasks.js';
import { resolveApplication, pendingApplications } from './recipes/apply.js';

const testCtx = new Map();

self.addEventListener('unhandledrejection', (e) => log('sw_error', { kind: 'unhandledrejection', error: String(e.reason?.message || e.reason), stack: e.reason?.stack }));
self.addEventListener('error', (e) => log('sw_error', { kind: 'error', error: String(e.message), file: e.filename, line: e.lineno }));
log('sw_start', { version: chrome.runtime.getManifest().version });

// ---------------------------------------------------------------------------
// Side panel: one panel instance per tab. Each tab keeps its own conversation,
// and the panel hides when you switch to a tab where LocalPilot was not opened.

function panelPath(tabId) {
  return `src/ui/sidepanel.html?tabId=${tabId}`;
}

function openPanelForTab(tab) {
  if (!tab?.id) return;
  // Both calls stay synchronous so sidePanel.open keeps the user gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: panelPath(tab.id), enabled: true }).catch(() => {});
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
}

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  // No global panel: only tabs where the user opened LocalPilot get one.
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.action.onClicked.addListener((tab) => openPanelForTab(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-side-panel') openPanelForTab(tab);
});

// ---------------------------------------------------------------------------
// Conversations, keyed by the tab the panel belongs to.

const conversations = new Map(); // key (tabId or test key) -> Conversation

function conversationFor(key) {
  if (!conversations.has(key)) {
    const conv = new Conversation();
    conv.ports = new Set();
    conv.pending = new Map(); // approval id -> { event, resolve }
    conversations.set(key, conv);
  }
  return conversations.get(key);
}

// Chats survive service-worker restarts: each tab's conversation is mirrored to
// chrome.storage.session (cleared when the browser closes). Screenshot pixels are
// not stored; the model only ever sees the latest two anyway.
const storeKey = (tabId) => `conv:${tabId}`;
const saveTimers = new Map();

function persistConversation(tabId, conv) {
  if (typeof tabId !== 'number') return; // test conversations stay in memory
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    saveTimers.delete(tabId);
    const messages = JSON.parse(JSON.stringify(conv.messages, (k, v) => (v && v.type === 'image' && typeof v.data === 'string' ? { type: 'text', text: '[screenshot not kept across restarts]' } : v)));
    chrome.storage.session.set({ [storeKey(tabId)]: { messages, controlTabId: conv.controlTabId } }).catch((err) => log('persist_error', { tabId, error: String(err.message || err) }));
  }, 400));
}

async function loadConversation(tabId) {
  const conv = conversationFor(tabId);
  if (conv.restored || conv.messages.length) return conv;
  conv.restored = true;
  const saved = (await chrome.storage.session.get(storeKey(tabId)))[storeKey(tabId)];
  if (saved && !conv.messages.length) {
    conv.messages = saved.messages || [];
    conv.controlTabId = saved.controlTabId;
    log('conversation_restored', { tabId, messages: conv.messages.length });
  }
  return conv;
}

function broadcast(conv, event) {
  for (const port of conv.ports) {
    try {
      port.postMessage(event);
    } catch {
      conv.ports.delete(port);
    }
  }
}

function denyPending(conv) {
  for (const [id, p] of conv.pending) {
    p.resolve('deny');
    conv.pending.delete(id);
  }
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

// Files attached in the panel: { name, type, size, data (base64) }. Names are made unique.
function cleanAttachments(list, existing = new Map()) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const taken = new Set(existing.keys());
  for (const f of list) {
    if (!f || typeof f.data !== 'string' || typeof f.name !== 'string') continue;
    const size = Math.floor((f.data.length * 3) / 4);
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`"${f.name}" is larger than 15 MB.`);
    let name = f.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    if (taken.has(name) && existing.get(name)?.data !== f.data) {
      const dot = name.lastIndexOf('.');
      for (let i = 2; taken.has(name); i += 1) name = dot > 0 ? `${f.name.slice(0, dot)} (${i})${f.name.slice(dot)}` : `${f.name} (${i})`;
    }
    taken.add(name);
    out.push({ name, type: String(f.type || ''), size: Number(f.size) || size, data: f.data });
  }
  return out;
}

async function startRun({ conv, tabId, prompt, emit, requestApproval, settingsPatch, panelTabId, files = [], task = null, extra = '' }) {
  if (conv.running) throw new Error('LocalPilot is already working in this tab. Stop it or wait.');
  const settings = { ...(await loadSettings()), ...settingsPatch };
  const run = new AgentRun({
    conversation: conv,
    tabId,
    settings,
    emit,
    requestApproval,
    persistApprovedDomains: (domains) => saveSettings({ approvedDomains: domains }),
  });
  run.ctx.panelTabId = panelTabId ?? tabId;
  if (task) run.ctx.task = { id: task.id, name: task.name, replaySteps: tasks.replayFor(task, extra) };
  if (task?.allowedDomains?.length) run.ctx.allowedDomains = task.allowedDomains;
  return run.run(prompt, cleanAttachments(files, conv.attachments));
}

function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || (tab.status === 'complete' && tab.url !== 'about:blank') || Date.now() - start > timeoutMs) resolve(tab);
      else setTimeout(tick, 200);
    };
    setTimeout(tick, 200);
  });
}

// ---------------------------------------------------------------------------
// Saved tasks on a schedule: run in their own unfocused window, ask nothing (only sites
// already approved with "Always allow" work), notify when done.

const sentNotifications = []; // for tests

async function notify(id, title, message) {
  sentNotifications.push({ id, title, message });
  await chrome.notifications.create(id, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message: String(message || ' ').slice(0, 300), priority: 1,
  }).catch((err) => log('notify_error', { error: String(err.message || err) }));
}

async function runTaskInBackground(task, trigger = 'schedule') {
  const startedAt = new Date().toISOString();
  log('task_start', { taskId: task.id, name: task.name, trigger });
  const win = await chrome.windows.create({ url: task.url || 'about:blank', focused: false, state: 'normal', width: 1280, height: 900 });
  const tabId = win.tabs[0].id;
  if (task.url) await waitTabComplete(tabId);
  const conv = new Conversation();
  conv.ports = new Set();
  conv.pending = new Map();
  const errors = [];
  const declined = new Set();
  let final = '';
  let done = null;
  const current = await loadSettings();
  await startRun({
    conv,
    tabId,
    prompt: task.prompt,
    task,
    settingsPatch: { permissionMode: current.permissionMode === 'auto' ? 'auto' : 'ask_site' },
    emit: (e) => {
      if (e.type === 'assistant') final = e.text;
      else if (e.type === 'error') errors.push(e.text);
      else if (e.type === 'done') done = e;
    },
    requestApproval: async (req) => {
      if (req.mode === 'verification') {
        errors.push(`${req.host} showed a verification (${req.kind}); the window is left open for you.`);
        return 'stop';
      }
      if (req.onceOnly) {
        errors.push(`${req.host} needs your confirmation every time, so a scheduled run cannot do it.`);
        return 'deny';
      }
      declined.add(req.host);
      return 'deny';
    },
  }).catch((err) => errors.push(String(err.message || err)));
  const check = await conv.judging?.catch(() => null);
  const ok = done?.reason === 'end_turn' && !errors.length && !declined.size && (!check || check.verdict === 'success');
  let text = done?.reason === 'end_turn' && !errors.length && !declined.size ? final : [errors.join(' '), done?.text, final].filter(Boolean).join(' ') || 'The task did not finish.';
  if (check && check.verdict !== 'success') text = `Check: ${check.verdict}. ${check.reason}\n${text}`;
  if (declined.size) text += ` Not run because not approved yet: ${[...declined].join(', ')}. Run the task once from the panel and choose "Always allow".`;
  const prev = (await tasks.lastRuns())[task.id] || null;
  const run = { at: startedAt, ok, text: text.slice(0, 2000), trigger, hash: tasks.hashText(text) };
  await tasks.recordRun(task.id, run);
  const notified = await notifyRun(task, run, prev);
  log('task_end', { taskId: task.id, ok, reason: done?.reason, notified, text: text.slice(0, 300) });
  if (ok) await chrome.windows.remove(win.id).catch(() => {});
  return { ok, text, notified, windowId: win.id, windowClosed: ok };
}

// Sends the desktop notification unless the task only wants changes / a keyword and this run has none.
async function notifyRun(task, run, prev) {
  if (!tasks.shouldNotify(task, run, prev)) return false;
  const status = !run.ok ? 'needs attention' : task.watch ? (prev?.hash && prev.hash !== run.hash ? 'changed' : 'watching') : task.notifyOn === 'keyword' ? `found "${task.keyword}"` : 'finished';
  await notify(`localpilot-task:${task.id}:${Date.now()}`, `LocalPilot: ${task.name} ${status}`, run.text);
  return true;
}

// Page watch: no model. Opens the URL in its own unfocused window, reads the page (or the
// selector's) text and compares it with the last run.
async function runWatchInBackground(task, trigger = 'schedule') {
  const startedAt = new Date().toISOString();
  log('task_start', { taskId: task.id, name: task.name, trigger, watch: true });
  const win = await chrome.windows.create({ url: task.url, focused: false, state: 'normal', width: 1280, height: 900 });
  const tabId = win.tabs[0].id;
  let ok = false;
  let snapshot = '';
  let text = '';
  try {
    await waitTabComplete(tabId);
    await callPage(tabId, 'quiet', 800, 8000).catch(() => {});
    const bot = await detectBotCheck(tabId);
    if (bot) throw new Error(`${new URL(task.url).hostname} showed a verification (${bot.kind}); the window is left open for you.`);
    snapshot = await callPage(tabId, 'selectorText', task.watch.selector || '', 20000);
    ok = true;
  } catch (err) {
    text = String(err.message || err);
  }
  const prev = (await tasks.lastRuns())[task.id] || null;
  const hash = ok ? tasks.hashText(snapshot) : prev?.hash;
  if (ok) {
    const lines = tasks.newLines(prev?.snapshot, snapshot);
    if (!prev?.hash) text = `Watching started: saved the page text (${snapshot.length} characters).`;
    else if (prev.hash === hash) text = 'No change.';
    else text = lines.length ? `Changed: ${lines.join(' | ')}` : 'Changed (text was removed or reordered).';
  }
  // A failed run keeps the last good snapshot, so the next run compares against it.
  const run = { at: startedAt, ok, text: text.slice(0, 2000), trigger, hash, snapshot: ok ? snapshot : prev?.snapshot || '' };
  await tasks.recordRun(task.id, run);
  const notified = await notifyRun(task, run, prev);
  log('task_end', { taskId: task.id, ok, watch: true, notified, text: text.slice(0, 300) });
  if (ok) await chrome.windows.remove(win.id).catch(() => {});
  return { ok, text, notified, windowId: win.id, windowClosed: ok };
}

async function onTaskAlarm(alarm) {
  const id = alarm.name.slice(tasks.ALARM_PREFIX.length);
  const task = (await tasks.listTasks()).find((t) => t.id === id);
  if (!task) {
    await chrome.alarms.clear(alarm.name);
    return null;
  }
  if (!tasks.isDue(task.schedule)) return { skipped: 'weekend' };
  return task.watch ? runWatchInBackground(task, 'schedule') : runTaskInBackground(task, 'schedule');
}

async function sendTasks(port) {
  const [list, runs] = await Promise.all([tasks.listTasks(), tasks.lastRuns()]);
  try {
    port.postMessage({
      type: 'tasks',
      tasks: list.map((t) => {
        const { snapshot, ...lastRun } = runs[t.id] || {}; // page snapshots stay in the worker
        const { replay, ...rest } = t; // saved steps stay in the worker too; the panel shows how many
        return { ...rest, replaySteps: replay?.steps.length || 0, replaySavedAt: replay?.savedAt || null, when: tasks.describeSchedule(t.schedule), lastRun: runs[t.id] ? lastRun : null };
      }),
    });
  } catch {
    // panel closed
  }
}

chrome.runtime.onConnect.addListener(async (port) => {
  if (!port.name.startsWith('sidepanel:')) return;
  const tabId = Number(port.name.split(':')[1]);
  const conv = await loadConversation(tabId);
  conv.ports.add(port);
  const emit = (event) => {
    broadcast(conv, event);
    if (['assistant', 'tool_result', 'done', 'tab'].includes(event.type)) persistConversation(tabId, conv);
  };
  const requestApproval = (request) =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      const event = { type: 'approval', id, ...request };
      conv.pending.set(id, { event, resolve });
      emit(event);
    });

  port.postMessage({ type: 'history', messages: conv.messages, running: !!conv.running });
  for (const p of conv.pending.values()) port.postMessage(p.event);
  for (const rec of await pendingApplications(tabId)) port.postMessage({ type: 'apply_review', ...rec });
  // Sent unasked: a request the panel posts right after connecting can arrive before
  // the onMessage listener below exists (the awaits above), and would be lost.
  sendTasks(port);

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case 'retry':
      case 'run_saved':
      case 'run': {
        if (msg.type === 'retry') msg.prompt = null; // resume the conversation as it is
        let savedTask = null;
        // Continue on the tab the agent was last controlling for this conversation.
        const target = conv.controlTabId ?? tabId;
        const tab = await chrome.tabs.get(target).catch(() => chrome.tabs.get(tabId).catch(() => null));
        if (!tab) {
          emit({ type: 'error', text: 'This tab no longer exists.' });
          emit({ type: 'done', reason: 'error' });
          return;
        }
        if (msg.type === 'run_saved') {
          // "/name extra words": the saved prompt (plus the extra words), started at the saved URL.
          const task = await tasks.findTask(msg.id || msg.name);
          if (!task) {
            emit({ type: 'error', text: `No saved task "${msg.name || msg.id}".` });
            emit({ type: 'done', reason: 'error' });
            return;
          }
          if (task.watch) {
            // A page watch runs without the model, in its own window, and compares with its last run.
            emit({ type: 'status', text: `Checking ${task.url}…` });
            const res = await runWatchInBackground(task, 'panel').catch((err) => ({ ok: false, text: String(err.message || err) }));
            emit({ type: res.ok ? 'assistant' : 'error', text: `Watch /${task.name}: ${res.text}` });
            emit({ type: 'done', reason: res.ok ? 'end_turn' : 'error' });
            for (const p of conv.ports) await sendTasks(p);
            return;
          }
          msg.prompt = [task.prompt, msg.extra].filter(Boolean).join('\n');
          savedTask = task;
          if (task.url && !conv.running) {
            await chrome.tabs.update(tab.id, { url: task.url });
            await waitTabComplete(tab.id);
          }
        }
        startRun({
          conv,
          tabId: tab.id,
          prompt: msg.prompt,
          emit: (e) => {
            if (e.type === 'tab') conv.controlTabId = e.tabId;
            emit(e);
          },
          requestApproval,
          panelTabId: tabId,
          files: msg.type === 'retry' ? [] : msg.attachments,
          task: savedTask,
          extra: msg.extra,
        }).catch((err) => {
          emit({ type: 'error', text: String(err.message || err) });
          emit({ type: 'done', reason: 'error' });
        });
        break;
      }
      case 'stop':
        conv.running?.stop();
        denyPending(conv);
        break;
      case 'reset':
        conv.reset();
        conv.controlTabId = undefined;
        denyPending(conv);
        chrome.storage.session.remove(storeKey(tabId)).catch(() => {});
        emit({ type: 'history', messages: [], running: false });
        break;
      case 'approval': {
        const p = conv.pending.get(msg.id);
        conv.pending.delete(msg.id);
        p?.resolve(msg.decision === 'edit' ? { decision: 'edit', text: String(msg.text || '') } : msg.decision);
        // Other open views of this conversation drop the card.
        emit({ type: 'approval_resolved', id: msg.id, decision: msg.decision });
        break;
      }
      case 'apply_confirm':
        try {
          const text = await resolveApplication(msg.id, !!msg.submitted);
          emit({ type: 'apply_resolved', id: msg.id, ok: true, text });
        } catch (err) {
          emit({ type: 'apply_resolved', id: msg.id, ok: false, text: String(err.message || err) });
        }
        break;
      case 'tasks_list':
        sendTasks(port);
        break;
      case 'task_save':
        try {
          await tasks.saveTask(msg.task);
          for (const p of conv.ports) await sendTasks(p);
        } catch (err) {
          port.postMessage({ type: 'task_error', text: String(err.message || err) });
        }
        break;
      case 'task_delete':
        await tasks.deleteTask(msg.id);
        for (const p of conv.ports) await sendTasks(p);
        break;
      case 'task_forget_steps':
        await tasks.clearReplay(msg.id);
        for (const p of conv.ports) await sendTasks(p);
        break;
      case 'ping':
        // Keeps the service worker alive during long local-model calls.
        break;
      default:
    }
  });

  port.onDisconnect.addListener(() => conv.ports.delete(port));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(storeKey(tabId)).catch(() => {});
  const conv = conversations.get(tabId);
  if (!conv) return;
  conv.running?.stop();
  denyPending(conv);
  conversations.delete(tabId);
});

// Permission mode changes apply to runs that are already going.
chrome.storage.onChanged.addListener((changes) => {
  const mode = changes.settings?.newValue?.permissionMode;
  if (!mode) return;
  for (const conv of conversations.values()) {
    if (conv.running) conv.running.ctx.settings.permissionMode = mode;
  }
});

// Stop button in the page overlay: stops whatever run controls that tab.
// Also answers the side panel's PC-bridge status query (one host process, owned here).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PC_STATUS') {
    probe().then(sendResponse);
    return true;
  }
  if (msg?.type === 'boss-unread' && sender.url?.startsWith('https://www.zhipin.com/')) {
    // Only a rise in the unread count counts as news; the agent run clears it by reading the chats.
    if (msg.count > (msg.previous ?? 0)) {
      notify('boss-unread', 'BOSS: new message', `${msg.count} unread on BOSS直聘`);
      fetch('http://127.0.0.1:4777/api/unread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: msg.count }) })
        .catch(() => {}); // dashboard server not running: the notification still shows
    }
    return;
  }
  if (msg?.type !== 'STOP_AGENT' || !sender.tab) return;
  for (const conv of conversations.values()) {
    if (conv.running?.tabId === sender.tab.id) {
      conv.running.stop();
      denyPending(conv);
    }
  }
});

startMcpBridge();

// Keepalive: re-establish the native host (and its MCP pipe) after a service-worker restart.
chrome.alarms.create('localpilot-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'localpilot-keepalive') ensureHost();
  else if (alarm.name.startsWith(tasks.ALARM_PREFIX)) onTaskAlarm(alarm).catch((err) => log('task_error', { alarm: alarm.name, error: String(err.message || err) }));
});
tasks.ensureSchedules().catch(() => {});

// Test hook: drive a run without the side panel UI (used by tests/e2e*.mjs).
globalThis.__localPilotTest = {
  async run({ tabId, prompt, approval = 'once', verification = 'continue', plan = 'approve', files = [], task: taskName = null, extra = '' }) {
    const events = [];
    const task = taskName ? await tasks.findTask(taskName) : null; // run a saved task, as "/name" does
    await startRun({
      conv: conversationFor(`test:${tabId}`),
      tabId,
      prompt: task ? [task.prompt, extra].filter(Boolean).join('\n') : prompt,
      task,
      extra,
      files,
      emit: (e) => events.push(e.type === 'tool_result' ? { ...e, content: e.content.map((c) => (c.type === 'image' ? { type: 'image', bytes: c.data.length } : c)) } : e),
      requestApproval: async (req) => {
        if (req.mode === 'verification') {
          events.push({ type: 'verification', host: req.host, kind: req.kind, solverTried: !!req.solverTried });
          return verification;
        }
        if (req.mode === 'plan') {
          events.push({ type: 'plan_request', plan: req.plan });
          return plan.startsWith('edit:') ? { decision: 'edit', text: plan.slice(5) } : plan;
        }
        events.push({ type: 'approval', host: req.host, mode: req.mode, onceOnly: !!req.onceOnly });
        return approval;
      },
    });
    await conversationFor(`test:${tabId}`).judging?.catch(() => null); // include the check's result
    return events;
  },
  flushLogs,
  saveSettings,
  saveTask: (t) => tasks.saveTask(t),
  listTasks: () => tasks.listTasks(),
  lastRuns: () => tasks.lastRuns(),
  getAlarm: (name) => chrome.alarms.get(name),
  fireAlarm: (name) => onTaskAlarm({ name }),
  notifications: () => sentNotifications,
  applyConfirm: (id, submitted) => resolveApplication(id, submitted),
  pendingApplications: () => pendingApplications(),
  loadSettings,
  reset() {
    for (const key of [...conversations.keys()]) if (String(key).startsWith('test:')) conversations.delete(key);
  },
  stop(tabId) {
    conversations.get(`test:${tabId}`)?.running?.stop();
  },
  conversationSizes() {
    return Object.fromEntries([...conversations].map(([k, c]) => [k, c.messages.length]));
  },
  // Run one tool directly (no model), with auto permissions.
  async tool(tabId, name, input = {}, files = null) {
    const settings = { ...(await loadSettings()), permissionMode: 'auto' };
    testCtx.set(tabId, testCtx.get(tabId) || {
      tabId, settings, running: true, screenshotScale: null, sessionApproved: new Set(),
      requestApproval: async () => 'deny', persistApprovedDomains: () => {}, emit: () => {}, host: await probe(),
    });
    const ctx = testCtx.get(tabId);
    ctx.settings = settings;
    if (files) ctx.attachments = new Map(cleanAttachments(files).map((f) => [f.name, f]));
    try {
      const blocks = await runTool(ctx, name, input);
      return { ok: true, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), images: blocks.filter((b) => b.type === 'image').length };
    } catch (err) {
      return { ok: false, text: String(err.message || err) };
    }
  },
  detachTab: (tabId) => cdpDetach(tabId),
  isAttached: (tabId) => cdpIsAttached(tabId),
  retain: (tabId) => cdpRetain(tabId), // as a run or MCP session does for the tabs it uses
  // Simulates a service-worker restart: in-memory chats are gone, storage remains.
  dropMemory() {
    for (const [key, conv] of [...conversations]) if (!conv.running) conversations.delete(key);
  },
};
