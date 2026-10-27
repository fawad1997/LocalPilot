// Where MCP calls and scheduled runs open their tabs. By default one dedicated, unfocused
// "LocalPilot MCP" window is reused: its id is kept in session storage (the MV3 service
// worker forgets memory when it idles) and, failing that, found again by its tab group.
// With mcpWindowMode 'current' the tabs open in the window you last used instead.
import { loadSettings } from './settings.js';
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

async function targetWindow() {
  const settings = await loadSettings();
  if (settings.mcpWindowMode === 'current') {
    const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] }).catch(() => null);
    if (win) return Object.assign(win, { current: true });
  }
  return dedicatedWindow();
}

export function mcpWindow() {
  const run = (pending || Promise.resolve()).catch(() => {}).then(targetWindow);
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
// otherwise an idle tab already in the group is reused, else a new one is opened.
export async function openMcpTab({ url = 'about:blank', reuseIdle = false, group = true } = {}) {
  const win = await mcpWindow();
  const active = !win.current; // your own window keeps the tab you are looking at
  let tab;
  if (win.fresh) {
    tab = win.tabs[0];
    if (url !== 'about:blank') tab = await chrome.tabs.update(tab.id, { url });
  } else {
    if (reuseIdle) {
      const groups = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: win.id }).catch(() => []);
      const idle = groups[0] ? (await chrome.tabs.query({ windowId: win.id, groupId: groups[0].id }))[0] : null;
      if (idle) tab = await chrome.tabs.update(idle.id, { url, ...(active ? { active: true } : {}) });
    }
    tab ||= await chrome.tabs.create({ windowId: win.id, url, active });
  }
  if (group) await addToGroup(tab.id);
  return { tabId: tab.id, windowId: win.id, windowCreated: !!win.fresh };
}
