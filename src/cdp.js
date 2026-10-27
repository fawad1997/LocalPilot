// chrome.debugger (Chrome DevTools Protocol) sessions per tab.
//
// Two lifetimes:
//   - the debugger attachment: comes and goes (released when no agent uses the tab)
//   - the per-tab store (console, network, captures, dialogs): kept across detach/re-attach,
//     dropped only when the tab closes. So captures and logs survive idle periods.

const stores = new Map(); // tabId -> store
const attached = new Set(); // tabIds with a live debugger attachment
const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;
const DIALOG_TIMEOUT_MS = 60000;
const ENABLE_TIMEOUT_MS = 1500;

function target(tabId) {
  return { tabId };
}

// Sites with anti-devtools scripts. With Runtime.enable on, Chrome serializes every console
// call for us, which makes console.table() measurably slow; such scripts time it and reload
// or blank the page (BOSS直聘 and 猎聘 do this; 51job and 智联 are listed as the same kind of
// job board). Console capture is skipped there; clicks, reading and screenshots still work.
// Other sites are learned at run time (see watchSelfReload) and kept in storage.
const QUIET_RUNTIME_HOSTS = /(^|\.)(zhipin|liepin|51job|zhaopin)\.com$/i;
const QUIET_KEY = 'quietHosts';
const learnedQuiet = new Set();
const learnedReady = chrome.storage.local.get(QUIET_KEY).then((v) => {
  for (const h of v[QUIET_KEY] || []) learnedQuiet.add(h);
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[QUIET_KEY]) return;
  learnedQuiet.clear();
  for (const h of changes[QUIET_KEY].newValue || []) learnedQuiet.add(h);
});

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function quietRuntime(url) {
  const host = hostOf(url);
  return !!host && (QUIET_RUNTIME_HOSTS.test(host) || learnedQuiet.has(host));
}

// Tabs controlled by a run with CAPTCHA solving on. The Runtime domain stays off there: with
// it on, every console call is serialized for the debugger, and Cloudflare/DataDome measure
// that to spot automation (SeleniumBase's CDP mode never enables Runtime for this reason).
// read_console_messages turns it on for the rest of the run when the model asks for it.
const stealthTabs = new Set();

export function setStealth(tabId, on) {
  if (on) stealthTabs.add(tabId);
  else stealthTabs.delete(tabId);
  const state = stores.get(tabId);
  if (!state || !attached.has(tabId)) return;
  const want = !state.quiet && (!on || state.consoleRequested);
  setRuntime(tabId, state, want);
}

// While a CAPTCHA / bot check is live, console capture is a liability: turn Runtime off for
// this page (without remembering it for the site).
export function muteConsole(tabId) {
  const state = stores.get(tabId);
  if (state) setRuntime(tabId, state, false);
}

// Console capture can start now (on request) unless the site is known to react to it.
export async function ensureConsoleCapture(tabId) {
  const state = await attach(tabId);
  state.consoleRequested = true;
  if (state.runtimeOn) return { started: false, quiet: false };
  if (state.quiet) return { started: false, quiet: true };
  state.runtimeOn = true;
  await send(tabId, 'Runtime.enable').catch(() => {});
  return { started: true, quiet: false };
}

async function learnQuiet(host) {
  if (learnedQuiet.has(host)) return;
  learnedQuiet.add(host);
  const v = await chrome.storage.local.get(QUIET_KEY).catch(() => ({}));
  const hosts = new Set(v[QUIET_KEY] || []).add(host);
  await chrome.storage.local.set({ [QUIET_KEY]: [...hosts] }).catch(() => {});
}

// Console capture on or off for the page the tab shows (or is about to show). A site that
// reacts to console capture is never turned back on.
function setRuntime(tabId, state, on) {
  if (on && state.quiet) return;
  if (state.runtimeOn === on) return;
  state.runtimeOn = on;
  send(tabId, on ? 'Runtime.enable' : 'Runtime.disable').catch(() => {});
}

// Input and page scripts we run can make the page navigate; that is not the page reacting to us.
const AGENT_ACTION_GRACE_MS = 2000;

// `timeoutMs` guards a command that can hang when Chrome stops answering it (DOM lookups for a
// frame that went away, for example) so a tool call cannot hang forever.
export function send(tabId, method, params = {}, { timeoutMs = 0 } = {}) {
  if (method.startsWith('Input.') || method === 'Runtime.evaluate') markAgentAction(tabId);
  const command = chrome.debugger.sendCommand(target(tabId), method, params);
  if (!timeoutMs) return command;
  return Promise.race([
    command,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)),
  ]);
}

export function markAgentAction(tabId) {
  const state = stores.get(tabId);
  if (state) state.lastAgentAction = Date.now();
}

function storeFor(tabId) {
  if (!stores.has(tabId)) {
    stores.set(tabId, {
      console: [],
      network: new Map(),
      inflight: new Set(),
      dialogs: [], // handled dialogs not yet reported to the model
      pendingDialog: null, // confirm/prompt/beforeunload waiting for handle_dialog
      dialogWaiters: new Set(),
      capturePatterns: new Set(),
      captured: [],
      capturedBytes: 0,
      runtimeOn: false,
      quiet: false, // site reacts to console capture (anti-debugging): never turn Runtime on
      consoleRequested: false, // read_console_messages asked for capture in this run
      lastAgentAction: 0,
      mainFrameId: null,
      pageUrl: '', // last real (non-blank) page URL in the main frame
      selfReloads: [], // times the page reloaded itself while console capture was on
      notices: [], // things the model should hear about after its next tool call
    });
  }
  return stores.get(tabId);
}

export async function attach(tabId) {
  const state = storeFor(tabId);
  if (attached.has(tabId)) return state;
  await learnedReady;
  try {
    await chrome.debugger.attach(target(tabId), '1.3');
  } catch (err) {
    // Already attached by us in an earlier service-worker lifetime: reuse it.
    if (!/already attached/i.test(err.message)) throw err;
  }
  attached.add(tabId);
  state.inflight.clear(); // requests from before this attachment will never report back
  const { url } = await chrome.tabs.get(tabId).catch(() => ({}));
  if (url && !url.startsWith('about:')) state.pageUrl = url;
  state.quiet = quietRuntime(url);
  state.runtimeOn = !state.quiet && !stealthTabs.has(tabId);
  state.selfReloads = [];
  const enabling = Promise.all([
    send(tabId, 'Page.enable'),
    ...(state.runtimeOn ? [send(tabId, 'Runtime.enable')] : []),
    send(tabId, 'Network.enable'),
  ]).then(() => send(tabId, 'Page.getFrameTree')).then(({ frameTree }) => {
    state.mainFrameId = frameTree.frame.id;
  });
  const answered = await Promise.race([enabling.then(() => true), new Promise((r) => setTimeout(() => r(false), ENABLE_TIMEOUT_MS))]);
  if (!answered) {
    // The page does not answer: almost always a dialog that opened before we attached. Chrome
    // never reports those to the debugger and cannot answer them; only a reload (or the user) closes it.
    const dialog = { type: 'unknown', message: '', preAttach: true, ts: Date.now() };
    state.pendingDialog = dialog;
    enabling.then(() => {
      if (state.pendingDialog === dialog) state.pendingDialog = null;
      return emulateFocus(tabId);
    }).catch(() => {});
    return state;
  }
  await emulateFocus(tabId);
  return state;
}

// Keep pages interactive even when the window is not focused.
function emulateFocus(tabId) {
  return send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

// Notices for the model (e.g. "this site reacts to debugging"), each reported once.
export function takeNotices(tabId) {
  const state = stores.get(tabId);
  return state ? state.notices.splice(0) : [];
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach(target(tabId)).catch(() => {});
}

export async function detachAll() {
  await Promise.all([...attached].map(detach));
}

// Several agents (side-panel runs in different tabs, MCP clients) can be active at
// once. Each marks the tabs it uses; a tab detaches only when nobody uses it.
const users = new Map(); // tabId -> count

export function retain(tabId) {
  users.set(tabId, (users.get(tabId) || 0) + 1);
}

// True when more than one agent is using the tab (a panel run and an MCP session, say), so
// dropping the debugger for a stealth page load would break the other one.
export function isShared(tabId) {
  return (users.get(tabId) || 0) > 1;
}

export async function release(tabId) {
  const n = (users.get(tabId) || 0) - 1;
  if (n > 0) {
    users.set(tabId, n);
    return;
  }
  users.delete(tabId);
  await detach(tabId);
  for (const [child, opener] of openedBy) {
    if (opener !== tabId) continue;
    openedBy.delete(child);
    await release(child);
  }
}

// A tab opened by a tab in use (target=_blank, window.open) is attached at once, so a
// dialog it shows while loading is caught; it is released with its opener.
const openedBy = new Map(); // tabId -> opener tabId

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  if (!users.has(sourceTabId)) return;
  openedBy.set(tabId, sourceTabId);
  retain(tabId);
  attach(tabId).catch(() => {});
});

// The tab's store, whether or not the debugger is attached right now.
export function getState(tabId) {
  return stores.get(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId);
  const state = stores.get(source.tabId);
  if (state) state.runtimeOn = false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  users.delete(tabId);
  stores.delete(tabId);
  openedBy.delete(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const state = stores.get(source.tabId);
  if (!state) return;
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ');
      pushCapped(state.console, { level: params.type, text, ts: Date.now() }, MAX_CONSOLE);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      const text = d.exception?.description || d.text || 'Uncaught exception';
      pushCapped(state.console, { level: 'exception', text, ts: Date.now() }, MAX_CONSOLE);
      break;
    }
    case 'Network.requestWillBeSent': {
      state.network.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        status: null,
        ts: Date.now(),
      });
      // Long-lived connections never "finish"; they would keep the page from looking settled.
      if (!['EventSource', 'WebSocket', 'Ping', 'Other'].includes(params.type)) state.inflight.add(params.requestId);
      if (state.network.size > MAX_NETWORK) {
        state.network.delete(state.network.keys().next().value);
      }
      break;
    }
    case 'Network.responseReceived': {
      const entry = state.network.get(params.requestId);
      if (entry) {
        entry.status = params.response.status;
        entry.mimeType = params.response.mimeType;
        entry.capture = matchesCapture(state, params.response.url);
      }
      break;
    }
    case 'Network.loadingFinished': {
      state.inflight.delete(params.requestId);
      const entry = state.network.get(params.requestId);
      if (entry?.capture) storeBody(source.tabId, state, params.requestId, entry);
      break;
    }
    case 'Network.loadingFailed': {
      state.inflight.delete(params.requestId);
      const entry = state.network.get(params.requestId);
      if (entry) entry.error = params.errorText;
      break;
    }
    case 'Page.javascriptDialogOpening':
      onDialog(source.tabId, state, params);
      break;
    case 'Page.javascriptDialogClosed':
      state.pendingDialog = null;
      break;
    case 'Page.frameRequestedNavigation':
      if (params.frameId === state.mainFrameId) watchSelfReload(source.tabId, state, params);
      break;
    case 'Page.frameStartedNavigating':
      // Before the new page runs any script: no console capture on a quiet site, or when the
      // run keeps the debugger out of the page's sight.
      if (params.frameId === state.mainFrameId && (quietRuntime(params.url) || stealthTabs.has(source.tabId))) setRuntime(source.tabId, state, false);
      break;
    case 'Page.frameNavigated': {
      if (!params.frame.parentId) {
        state.mainFrameId = params.frame.id;
        state.console.length = 0;
        state.inflight.clear();
        state.consoleRequested = false; // the new document starts without capture, as usual
        const { url } = params.frame;
        if (!url.startsWith('about:')) state.pageUrl = url;
        state.quiet = quietRuntime(url);
        setRuntime(source.tabId, state, !state.quiet && !stealthTabs.has(source.tabId));
      }
      break;
    }
    default:
  }
});

// ---------------------------------------------------------------------------
// Pages that reload or blank themselves because the debugger reads their console. Only
// navigations the page starts itself count, not ones right after our own actions. Blanking
// once, or reloading twice within SELF_RELOAD_WINDOW_MS, turns console capture off for that
// site from now on, and the page is loaded once more.

const SELF_RELOAD_WINDOW_MS = 30000;

function watchSelfReload(tabId, state, params) {
  if (!state.runtimeOn || !state.pageUrl) return;
  const sameUrl = params.url.split('#')[0] === state.pageUrl.split('#')[0];
  const blanking = params.url.startsWith('about:blank'); // never caused by our clicks or typing
  if (!blanking && Date.now() - state.lastAgentAction < AGENT_ACTION_GRACE_MS) return;
  if (!blanking && !(sameUrl && ['reload', 'scriptInitiated'].includes(params.reason))) return;
  const now = Date.now();
  state.selfReloads = state.selfReloads.filter((t) => now - t < SELF_RELOAD_WINDOW_MS);
  state.selfReloads.push(now);
  if (!blanking && state.selfReloads.length < 2) return;
  state.selfReloads = [];
  const url = state.pageUrl;
  const host = hostOf(url);
  state.quiet = true;
  setRuntime(tabId, state, false);
  learnQuiet(host);
  state.notices.push(
    `${host} reloads or blanks itself while LocalPilot reads its console (anti-debugging). Console capture is now off for ${host} ` +
      '(read_console_messages stays empty there) and the page was loaded again; clicking, reading and screenshots work as before.',
  );
  // A reload is already on its way and now loads without console capture; a blank page is replaced by the page again.
  if (!sameUrl) setTimeout(() => send(tabId, 'Page.navigate', { url }).catch(() => {}), 300);
}

// ---------------------------------------------------------------------------
// JavaScript dialogs. alert() is accepted and reported. confirm(), prompt() and
// "leave page?" can change or destroy data, so they stay open until the model calls
// handle_dialog (approval-gated). Unanswered ones are dismissed after 60 s.

function onDialog(tabId, state, params) {
  const dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url, ts: Date.now() };
  if (params.type === 'alert') {
    state.dialogs.push(dialog);
    send(tabId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  } else {
    state.pendingDialog = dialog;
    setTimeout(() => {
      if (state.pendingDialog !== dialog) return;
      state.pendingDialog = null;
      state.dialogs.push({ ...dialog, autoDismissed: true });
      send(tabId, 'Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }, DIALOG_TIMEOUT_MS);
  }
  for (const resolve of state.dialogWaiters) resolve(dialog);
  state.dialogWaiters.clear();
}

export async function handleDialog(tabId, accept, promptText) {
  const state = stores.get(tabId);
  const dialog = state?.pendingDialog;
  if (!dialog) throw new Error('No dialog is open on this tab.');
  if (dialog.preAttach) {
    // Chrome cannot answer a dialog that opened before we attached; a reload closes it
    // (as "Cancel"). The reloaded page is fully attached, so its own dialogs are caught.
    const { url } = await chrome.tabs.get(tabId);
    await send(tabId, 'Page.navigate', { url });
    state.pendingDialog = null;
    return { ...dialog, reloaded: true };
  }
  await send(tabId, 'Page.handleJavaScriptDialog', { accept: !!accept, ...(promptText !== undefined ? { promptText: String(promptText) } : {}) });
  state.pendingDialog = null;
  return dialog;
}

// Input commands do not return while a dialog they triggered is open. Race them
// against the dialog so the tool can report it instead of hanging.
export function raceDialog(tabId, promise) {
  const state = storeFor(tabId);
  let waiter;
  const dialogOpened = new Promise((resolve) => {
    waiter = resolve;
    state.dialogWaiters.add(waiter);
  });
  return Promise.race([promise.then(() => null), dialogOpened]).finally(() => state.dialogWaiters.delete(waiter));
}

// ---------------------------------------------------------------------------
// Response body capture: bodies are kept only for URLs matching a capture pattern.

const MAX_CAPTURED_BYTES = 30 * 1024 * 1024;
let captureSeq = 0;

function matchesCapture(state, url) {
  for (const p of state.capturePatterns) if (url.includes(p)) return true;
  return false;
}

async function storeBody(tabId, state, requestId, entry) {
  try {
    const res = await send(tabId, 'Network.getResponseBody', { requestId });
    const body = res.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))) : res.body;
    captureSeq += 1;
    state.captured.push({ seq: captureSeq, url: entry.url, method: entry.method, status: entry.status, mimeType: entry.mimeType, body, ts: Date.now() });
    state.capturedBytes += body.length;
    while (state.capturedBytes > MAX_CAPTURED_BYTES && state.captured.length > 1) {
      state.capturedBytes -= state.captured.shift().body.length;
    }
  } catch {
    // Body evicted or request was a redirect: nothing to store.
  }
}

export async function startCapture(tabId, pattern) {
  const state = await attach(tabId);
  state.capturePatterns.add(pattern);
  return state;
}

export function readCaptured(tabId, { pattern, sinceSeq = 0 } = {}) {
  const state = stores.get(tabId);
  if (!state) return [];
  return state.captured.filter((c) => c.seq > sinceSeq && (!pattern || c.url.includes(pattern)));
}

export function clearCaptured(tabId) {
  const state = stores.get(tabId);
  if (!state) return;
  state.captured = [];
  state.capturedBytes = 0;
}

export function lastCaptureSeq() {
  return captureSeq;
}

// Requests still loading in the tab (for "page settled" checks).
export function inflightCount(tabId) {
  return stores.get(tabId)?.inflight.size ?? 0;
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

// ---------------------------------------------------------------------------
// Input helpers

const KEY_DEFS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let i = 1; i <= 12; i += 1) KEY_DEFS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };
const MODIFIER_KEYS = {
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

function keyDef(name) {
  const lower = name.toLowerCase();
  if (KEY_DEFS[lower]) return KEY_DEFS[lower];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /[a-z]/i.test(name);
    const isDigit = /[0-9]/.test(name);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: name,
    };
  }
  throw new Error(`Unknown key "${name}"`);
}

// Press a combo like "ctrl+a", "Enter", "shift+Tab".
export async function pressCombo(tabId, combo) {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const mainName = parts.pop();
  let modifiers = 0;
  const heldMods = [];
  for (const m of parts) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}"`);
    modifiers |= bit;
    const canonical = { 1: 'alt', 2: 'ctrl', 4: 'meta', 8: 'shift' }[bit];
    heldMods.push(MODIFIER_KEYS[canonical]);
  }
  for (const mk of heldMods) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.keyCode });
  }
  const def = keyDef(mainName);
  // Text is only produced when no command modifier (ctrl/alt/meta) is held.
  const producesText = def.text && (modifiers & 7) === 0;
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: producesText ? 'keyDown' : 'rawKeyDown',
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    text: producesText ? def.text : undefined,
    unmodifiedText: producesText ? def.text : undefined,
  });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode });
  for (const mk of heldMods.reverse()) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.keyCode });
  }
}

export async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let i = 1; i <= clickCount; i += 1) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
  }
}

export function modifierMask(text) {
  if (!text) return 0;
  return text.split('+').reduce((mask, m) => mask | (MODIFIERS[m.trim().toLowerCase()] || 0), 0);
}

// Put files into the <input type=file> matching a CSS selector (searched across same-process frames).
export async function setFileInputFiles(tabId, selector, paths) {
  await attach(tabId);
  await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  const search = await send(tabId, 'DOM.performSearch', { query: selector, includeUserAgentShadowDOM: true });
  try {
    if (!search.resultCount) throw new Error('Could not reach the file input (it may be in a cross-origin iframe).');
    const { nodeIds } = await send(tabId, 'DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: 1 });
    await send(tabId, 'DOM.setFileInputFiles', { files: paths, nodeId: nodeIds[0] });
  } finally {
    await send(tabId, 'DOM.discardSearchResults', { searchId: search.searchId }).catch(() => {});
  }
}
