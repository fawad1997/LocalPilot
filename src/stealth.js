// Page loads with the debugger disconnected.
//
// The strongest part of SeleniumBase's UC mode is not JavaScript patching: it opens the page
// while it is *not* attached to the browser over CDP, lets the bot check run in a normal
// browser, and only then reconnects (uc_open_with_reconnect). Chrome's debugger can be dropped
// and taken again the same way, so a Cloudflare/DataDome challenge that runs during load sees
// an ordinary browser with no automation channel open.
import { attach, detach, isAttached, isShared } from './cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves when the tab has finished loading (or after the timeout). Uses the tab's own
// loading→complete events; a navigation answered entirely from cache may never report
// "loading", so a short grace period also accepts a tab that is already complete.
export function waitTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let settled = false;
    let loading = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') {
        loading = true;
        clearTimeout(grace);
      }
      if (info.status === 'complete' && loading) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    const grace = setTimeout(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status === 'complete') finish();
    }, 2500);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// Navigate with the debugger detached, wait for the page and its first checks to settle,
// then attach again. `reconnectMs` is the quiet time after load; SeleniumBase uses 2-4 s.
export async function stealthNavigate(tabId, url, { reconnectMs = 1500 } = {}) {
  const wasAttached = isAttached(tabId);
  const canDrop = wasAttached && !isShared(tabId); // another agent may be using the tab
  if (canDrop) await detach(tabId);
  try {
    await chrome.tabs.update(tabId, { url });
    await waitTabComplete(tabId);
    if (canDrop) await sleep(reconnectMs + Math.random() * 1400);
  } finally {
    await attach(tabId).catch(() => {});
  }
}
