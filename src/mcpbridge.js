// MCP bridge, extension side. The native host relays tool calls from MCP clients
// (Claude Code via host/mcp-server.mjs). They run in a dedicated, unfocused
// "LocalPilot MCP" window (see mcpwindow.js), so they never take over the window or tabs you use.
import * as pc from './pcbridge.js';
import * as cdp from './cdp.js';
import { loadSettings, saveSettings } from './settings.js';
import { toolDefinitions, runTool, setIndicator } from './tools.js';
import { log } from './logger.js';
import { openMcpTab, addToGroup } from './mcpwindow.js';
import { mcpHiddenRecipes } from './recipes/index.js';
import { ALWAYS_ASK_TOOLS } from './quantara.js';

// MCP clients have their own file access; apply_assist needs the panel's review card;
// quantara_halt is confirmed in the panel only.
const EXCLUDED = new Set(['pc_list_dir', 'pc_read_file', 'pc_write_file', 'pc_write_csv', 'pc_run_script', ...mcpHiddenRecipes(), ...ALWAYS_ASK_TOOLS]);
const IDLE_RELEASE_MS = 5 * 60 * 1000;

const OWN_TAB_ID = new Set(['switch_tab', 'tabs_close']);
const TAB_ID_PROP = {
  tab_id: { type: 'number', description: 'Optional: run this call in a specific tab (ids from tabs_context). Defaults to the current MCP tab.' },
};

const state = {
  ctx: null,
  windowId: null,
  queue: Promise.resolve(),
  idleTimer: null,
  retained: new Set(),
  host: null,
  current: null, // { callId, cancel }
  cancelledIds: new Set(),
};

async function mcpCtx(settings) {
  if (!state.ctx) {
    state.ctx = {
      tabId: null,
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
      onTabChange: (id) => addToGroup(id),
    };
  }
  const ctx = state.ctx;
  ctx.settings = { ...settings, permissionMode: settings.mcpPermissionMode || 'auto' };
  ctx.host = state.host;
  const alive = ctx.tabId != null && (await chrome.tabs.get(ctx.tabId).catch(() => null));
  if (!alive) {
    const tab = await openMcpTab({ reuseIdle: true });
    ctx.windowId = tab.windowId;
    ctx.tabId = tab.tabId;
    ctx.screenshotScale = null;
  }
  return ctx;
}

function toMcpContent(blocks) {
  return blocks.map((b) => (b.type === 'image' ? { type: 'image', data: b.data, mimeType: b.mediaType } : { type: 'text', text: b.text ?? '' }));
}

function retainTab(tabId) {
  if (state.retained.has(tabId)) return;
  state.retained.add(tabId);
  cdp.retain(tabId);
}

function scheduleRelease(ctx) {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(async () => {
    // every tab used in this session, not just the last: a "tab_id" call can leave the frame on another tab
    for (const id of new Set([ctx.tabId, ...state.retained])) await setIndicator(id, false);
    for (const id of state.retained) await cdp.release(id);
    state.retained.clear();
  }, IDLE_RELEASE_MS);
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
    const ctx = await mcpCtx(settings);
    // tools whose own `tab_id` means something else (the tab to switch to / close)
    const raw = msg.arguments || {};
    const { tab_id: tabId, ...rest } = raw;
    const args = OWN_TAB_ID.has(msg.name) ? raw : rest;
    if (tabId !== undefined && !OWN_TAB_ID.has(msg.name)) {
      const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
      if (!tab) throw new Error(`No tab with id ${tabId}. Call tabs_context to list tabs.`);
      if (tab.id !== ctx.tabId) {
        await setIndicator(ctx.tabId, false); // or the frame stays on the old tab (it did on the shop TV's menu)
        ctx.tabId = tab.id;
        ctx.screenshotScale = null;
      }
    }
    retainTab(ctx.tabId);
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
    try {
      const blocks = await Promise.race([
        runTool(ctx, msg.name, args),
        cancelled.then(() => {
          throw new Error('Cancelled by the client.');
        }),
      ]);
      retainTab(ctx.tabId);
      return { content: toMcpContent(blocks), tabId: ctx.tabId };
    } finally {
      state.current = null;
      ctx.running = true;
      ctx.emit = () => {};
      scheduleRelease(ctx);
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
    if (msg.type !== 'mcp') return;
    // One call at a time: MCP clients may issue calls in parallel against the same tab.
    state.queue = state.queue.then(async () => {
      if (state.cancelledIds.delete(msg.callId)) return;
      const t0 = Date.now();
      try {
        const result = await handleCall(msg);
        pc.post({ type: 'mcp_result', callId: msg.callId, ok: true, result });
        if (msg.op === 'call_tool') log('mcp_call', { name: msg.name, input: msg.arguments, ok: true, ms: Date.now() - t0, tabId: result.tabId });
      } catch (err) {
        pc.post({ type: 'mcp_result', callId: msg.callId, ok: false, error: String(err.message || err) });
        log('mcp_call', { op: msg.op, name: msg.name, input: msg.arguments, ok: false, ms: Date.now() - t0, error: String(err.message || err) });
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
