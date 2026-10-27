// MCP bridge, extension side. The native host relays tool calls from MCP clients
// (Claude Code via host/mcp-server.mjs). They run in a dedicated, unfocused
// "LocalPilot MCP" window (see mcpwindow.js), so they never take over the window or tabs you use.
// Each MCP session (one per Claude Code session) has its own tab there and stays out of the others'.
import * as pc from './pcbridge.js';
import * as cdp from './cdp.js';
import { loadSettings, saveSettings } from './settings.js';
import { toolDefinitions, runTool, setIndicator, otherSessionText } from './tools.js';
import { log } from './logger.js';
import { openMcpTab, addToGroup, withFrontTab } from './mcpwindow.js';
import { mcpHiddenRecipes } from './recipes/index.js';
import { ALWAYS_ASK_TOOLS } from './quantara.js';

// MCP clients have their own file access; apply_assist needs the panel's review card;
// quantara_halt is confirmed in the panel only.
const EXCLUDED = new Set(['pc_list_dir', 'pc_read_file', 'pc_write_file', 'pc_write_csv', 'pc_run_script', ...mcpHiddenRecipes(), ...ALWAYS_ASK_TOOLS]);
const IDLE_RELEASE_MS = 5 * 60 * 1000;
// A session quiet for this long no longer owns its tabs: it may have ended while the host was
// down, so no "session ended" message came.
const SESSION_STALE_MS = 60 * 60 * 1000;
const SAVED = 'mcpSessions'; // session storage: { [session]: { tabId, tabs, lastUsed } }, survives SW restarts

const OWN_TAB_ID = new Set(['switch_tab', 'tabs_close']);
const TAB_ID_PROP = {
  tab_id: { type: 'number', description: 'Optional: run this call in a specific tab (ids from tabs_context). Defaults to the current MCP tab.' },
};

const state = {
  sessions: new Map(), // session -> { ctx, tabs, retained, lastUsed, idleTimer }
  queue: Promise.resolve(),
  host: null,
  current: null, // { callId, cancel }
  cancelledIds: new Set(),
};

async function savedSessions() {
  return (await chrome.storage.session.get(SAVED).catch(() => ({})))[SAVED] || {};
}

async function saveSession(key, s) {
  const all = await savedSessions();
  if (s) {
    const open = await Promise.all([...s.tabs].map((id) => chrome.tabs.get(id).catch(() => null)));
    s.tabs = new Set(open.filter(Boolean).map((t) => t.id));
    all[key] = { tabId: s.ctx.tabId, tabs: [...s.tabs], lastUsed: s.lastUsed };
  } else delete all[key];
  await chrome.storage.session.set({ [SAVED]: all }).catch(() => {});
}

// Tabs that other, still active sessions work in.
async function busyTabs(key) {
  const busy = new Set();
  for (const [k, s] of Object.entries(await savedSessions())) {
    if (k !== key && Date.now() - s.lastUsed < SESSION_STALE_MS) for (const id of s.tabs) busy.add(id);
  }
  return busy;
}

async function mcpSession(key, settings) {
  let s = state.sessions.get(key);
  if (!s) {
    const saved = (await savedSessions())[key];
    s = { tabs: new Set(saved?.tabs || []), retained: new Set(), lastUsed: Date.now(), idleTimer: null };
    s.ctx = {
      tabId: saved?.tabId ?? null,
      windowId: null,
      mcp: true, // bot checks are reported to the MCP client instead of waiting for the panel
      settings,
      running: true,
      screenshotScale: null,
      sessionApproved: new Set(),
      host: state.host,
      emit: () => {},
      requestApproval: async () => 'deny',
      persistApprovedDomains: (domains) => saveSettings({ approvedDomains: domains }),
      onTabChange: (id) => {
        s.tabs.add(id);
        addToGroup(id);
      },
      busyTabs: () => busyTabs(key),
      exclusive: (fn) => withFrontTab(s.ctx, fn, s.ctx.cancelled), // a cancelled call hands the window on at once
    };
    state.sessions.set(key, s);
  }
  const { ctx } = s;
  ctx.settings = { ...settings, permissionMode: settings.mcpPermissionMode || 'auto' };
  ctx.host = state.host;
  const busy = await busyTabs(key);
  // Gone, or taken by another session after this one went quiet for a long time.
  const alive = ctx.tabId != null && !busy.has(ctx.tabId) && (await chrome.tabs.get(ctx.tabId).catch(() => null));
  if (!alive) {
    const tab = await openMcpTab({ reuseIdle: true, exclude: busy });
    ctx.windowId = tab.windowId;
    ctx.tabId = tab.tabId;
    ctx.screenshotScale = null;
  }
  s.tabs.add(ctx.tabId);
  s.lastUsed = Date.now();
  await saveSession(key, s);
  return s;
}

function toMcpContent(blocks) {
  return blocks.map((b) => (b.type === 'image' ? { type: 'image', data: b.data, mimeType: b.mediaType } : { type: 'text', text: b.text ?? '' }));
}

function retainTab(s, tabId) {
  if (s.retained.has(tabId)) return;
  s.retained.add(tabId);
  cdp.retain(tabId);
}

async function releaseSession(s) {
  clearTimeout(s.idleTimer);
  // every tab used in this session, not just the last: a "tab_id" call can leave the frame on another tab
  for (const id of new Set([s.ctx.tabId, ...s.retained])) await setIndicator(id, false);
  for (const id of s.retained) await cdp.release(id);
  s.retained.clear();
}

function scheduleRelease(s) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => releaseSession(s), IDLE_RELEASE_MS);
}

// The client disconnected (its Claude Code session ended): free its tabs for the next session.
async function endSession(key) {
  const s = state.sessions.get(key);
  if (s) await releaseSession(s);
  state.sessions.delete(key);
  await saveSession(key, null);
  log('mcp_session_end', { session: key });
}

async function handleCall(msg) {
  const settings = await loadSettings();
  if (msg.op === 'list_tools') {
    const tools = toolDefinitions(settings, state.host)
      .filter((t) => !EXCLUDED.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: OWN_TAB_ID.has(t.name) ? t.input_schema : { ...t.input_schema, properties: { ...(t.input_schema.properties || {}), ...TAB_ID_PROP } },
      }));
    return { tools };
  }
  if (msg.op === 'call_tool') {
    if (EXCLUDED.has(msg.name)) throw new Error(`${msg.name} is not available over MCP.`);
    const key = msg.session || 'default'; // hosts from before per-session tabs send none
    const s = await mcpSession(key, settings);
    const { ctx } = s;
    // tools whose own `tab_id` means something else (the tab to switch to / close)
    const raw = msg.arguments || {};
    const { tab_id: tabId, ...rest } = raw;
    const args = OWN_TAB_ID.has(msg.name) ? raw : rest;
    if (tabId !== undefined && !OWN_TAB_ID.has(msg.name)) {
      const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
      if (!tab) throw new Error(`No tab with id ${tabId}. Call tabs_context to list tabs.`);
      if ((await busyTabs(key)).has(tab.id)) throw new Error(otherSessionText(tab.id));
      if (tab.id !== ctx.tabId) {
        await setIndicator(ctx.tabId, false); // or the frame stays on the old tab (it did on the shop TV's menu)
        ctx.tabId = tab.id;
        ctx.screenshotScale = null;
        s.tabs.add(tab.id);
      }
    }
    retainTab(s, ctx.tabId);
    await setIndicator(ctx.tabId, true);

    // Cancellation (notifications/cancelled from the client) and progress updates.
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = resolve;
    });
    state.current = {
      callId: msg.callId,
      cancel: () => {
        ctx.running = false; // long loops (BOSS, waits for the user) check this
        cancel();
      },
    };
    let n = 0;
    ctx.emit = (e) => {
      if (e.type === 'status' || e.type === 'notice') {
        n += 1;
        pc.post({ type: 'mcp_progress', callId: msg.callId, progress: { progress: n, message: e.text } });
      }
    };
    ctx.running = true;
    ctx.cancelled = cancelled;
    try {
      const blocks = await Promise.race([
        runTool(ctx, msg.name, args),
        cancelled.then(() => {
          throw new Error('Cancelled by the client.');
        }),
      ]);
      retainTab(s, ctx.tabId);
      return { content: toMcpContent(blocks), tabId: ctx.tabId };
    } finally {
      state.current = null;
      ctx.running = true;
      ctx.cancelled = null;
      ctx.emit = () => {};
      s.lastUsed = Date.now();
      if (state.sessions.get(key) === s) await saveSession(key, s);
      scheduleRelease(s);
    }
  }
  throw new Error(`Unknown MCP op ${msg.op}`);
}

let started = false;
let retryTimer = null;

export async function startMcpBridge() {
  if (started) return;
  started = true;
  pc.onHostMessage((msg) => {
    if (msg.type === 'mcp_cancel') {
      if (state.current?.callId === msg.callId) state.current.cancel();
      else state.cancelledIds.add(msg.callId); // still queued: skip it
      log('mcp_cancel', { callId: msg.callId });
      return;
    }
    if (msg.type === 'mcp_session_end') {
      state.queue = state.queue.then(() => endSession(msg.session || 'default').catch(() => {})); // the queue must never reject
      return;
    }
    if (msg.type !== 'mcp') return;
    // One call at a time: MCP clients may issue calls in parallel against the same tab, and
    // all sessions share one window, where only the front tab is drawn.
    state.queue = state.queue.then(async () => {
      if (state.cancelledIds.delete(msg.callId)) return;
      const t0 = Date.now();
      try {
        const result = await handleCall(msg);
        pc.post({ type: 'mcp_result', callId: msg.callId, ok: true, result });
        if (msg.op === 'call_tool') log('mcp_call', { name: msg.name, input: msg.arguments, ok: true, ms: Date.now() - t0, tabId: result.tabId, session: msg.session });
      } catch (err) {
        pc.post({ type: 'mcp_result', callId: msg.callId, ok: false, error: String(err.message || err) });
        log('mcp_call', { op: msg.op, name: msg.name, input: msg.arguments, ok: false, ms: Date.now() - t0, error: String(err.message || err), session: msg.session });
      }
    });
  });
  pc.onDisconnect(() => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(ensureHost, 30000);
  });
  await ensureHost();
}

// A persistent native port keeps the host (and its MCP pipe) alive and keeps this
// service worker running. Called at start-up, after disconnects, and every minute
// by an alarm so the pipe comes back after a service-worker restart.
export async function ensureHost() {
  const settings = await loadSettings();
  if (settings.mcpBridge === false) return;
  if (pc.status().connected && state.host) return;
  state.host = await pc.probe();
}
