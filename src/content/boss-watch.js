// Read-only watcher for the BOSS直聘 unread badge. It makes no requests to the site: BOSS pushes new
// messages to the open page itself, and this only reads the 消息 badge when that part of the page
// changes. A count that goes up is reported to the background worker (notification + local signal file).
(() => {
  if (window.__lpBossWatch) return;
  window.__lpBossWatch = true;

  let last = null;
  let timer = null;

  function readCount() {
    const link = [...document.querySelectorAll('a')].find((a) => /^\s*消息/.test(a.textContent || ''));
    if (!link) return null;
    const m = (link.textContent || '').match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function check() {
    timer = null;
    const n = readCount();
    if (n == null || n === last) return;
    const prev = last;
    last = n;
    if (prev == null) return; // first read after load: baseline only
    try { chrome.runtime.sendMessage({ type: 'boss-unread', count: n, previous: prev }); } catch { /* extension reloaded */ }
  }

  // Debounced: the badge can flicker while the page re-renders.
  new MutationObserver(() => { if (!timer) timer = setTimeout(check, 1500); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(check, 3000);
})();
