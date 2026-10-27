// Where MCP calls and scheduled runs open their tabs: one dedicated, unfocused "LocalPilot MCP"
// window, reused. Its id is kept in session storage (the MV3 service worker forgets memory when
// it idles) and, failing that, found again by its tab group. Not your own window: Chrome only
// draws the front tab of a window, so an agent's tab behind yours could not be seen or captured.
import { log } from './logger.js';

export const GROUP_TITLE = 'LocalPilot MCP';
const KEY = 'mcpWindowId';

let pending = null; // serializes window lookups so parallel callers share one window

async function liveWindow(id) {
  if (id == null) return null;
  const win = await chrome.windows.get(id, { populate: true }).catch(() => null);
  return win && win.type === 'normal' ? win : null;
}

async function dedicatedWindow() {
  const stored = (await chrome.storage.session.get(KEY).catch(() => ({})))[KEY];
  let win = await liveWindow(stored);
  if (!win) {
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE }).catch(() => []);
    for (const g of groups) {
      win = await liveWindow(g.windowId);
      if (win) break;
    }
  }
  if (!win) {
    // Unfocused, normal-state window: it renders (unlike minimized ones) without stealing focus.
    const created = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal', width: 1280, height: 900 });
    log('mcp_window_created', { windowId: created.id });
    win = await chrome.windows.get(created.id, { populate: true });
    win.fresh = true;
  }
  await chrome.storage.session.set({ [KEY]: win.id }).catch(() => {});
  return win;
}

export function mcpWindow() {
  const run = (pending || Promise.resolve()).catch(() => {}).then(dedicatedWindow);
  pending = run;
  return run;
}

export async function addToGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
    const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groups[0] ? { groupId: groups[0].id } : { createProperties: { windowId: tab.windowId } }) });
    if (!groups[0]) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple' });
  } catch {
    // Grouping is cosmetic.
  }
}

// A tab for a new session or run. A freshly created dedicated window donates its first tab;
// otherwise an idle tab already in the group (not one in `exclude`) is reused, else a new one is opened.
export async function openMcpTab({ url = 'about:blank', reuseIdle = false, exclude = new Set(), group = true } = {}) {
  const win = await mcpWindow();
  let tab;
  if (win.fresh) {
    tab = win.tabs[0];
    if (url !== 'about:blank') tab = await chrome.tabs.update(tab.id, { url });
  } else {
    if (reuseIdle) {
      const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: win.id }).catch(() => []);
      const idle = groups[0] ? (await chrome.tabs.query({ windowId: win.id, groupId: groups[0].id })).find((t) => !exclude.has(t.id)) : null;
      if (idle) tab = await chrome.tabs.update(idle.id, { url, active: true });
    }
    tab ||= await chrome.tabs.create({ windowId: win.id, url, active: true });
  }
  if (group) await addToGroup(tab.id);
  return { tabId: tab.id, windowId: win.id, windowCreated: !!win.fresh };
}

// Chrome only draws the front tab of a window; screenshots of its other tabs hang or fail.
// Everything that shares the LocalPilot MCP window (MCP sessions, scheduled runs) takes turns,
// and each turn first brings its tab to the front. Tabs in your own windows are never switched
// (a tab_id call there captures what Chrome draws, or fails with a clear message).
const TURN_MAX_MS = 10 * 60 * 1000; // a stuck call must not block everyone for good
let turn = Promise.resolve();

// `cancelled` (optional promise): the caller gave up, so the turn passes on at once (the tool
// may still be finishing) and a call still waiting for its turn never starts.
export function withFrontTab(ctx, fn, cancelled = null) {
  let gaveUp = false;
  cancelled?.then(() => {
    gaveUp = true;
  });
  const run = turn.then(async () => {
    if (gaveUp) throw new Error('Cancelled by the client.');
    await bringToFront(ctx.tabId);
    return fn();
  });
  turn = Promise.race([run.catch(() => {}), new Promise((r) => setTimeout(r, TURN_MAX_MS)), ...(cancelled ? [cancelled] : [])]);
  return run;
}

async function bringToFront(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active) return;
  const own = (await chrome.storage.session.get(KEY).catch(() => ({})))[KEY];
  if (tab.windowId === own) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}
