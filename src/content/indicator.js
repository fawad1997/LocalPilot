// Injected on demand: glowing frame + Stop button while the agent controls the tab.
(() => {
  if (window.__lpIndicator) return;
  const HOST_ID = '__localpilot_indicator__';

  function show() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .frame { position: fixed; inset: 0; pointer-events: none;
          box-shadow: inset 0 0 0 3px #2f80ed, inset 0 0 24px rgba(47,128,237,.55);
          animation: pulse 2s ease-in-out infinite; }
        @keyframes pulse { 50% { box-shadow: inset 0 0 0 3px #56a0ff, inset 0 0 36px rgba(86,160,255,.7); } }
        @media (prefers-reduced-motion: reduce) { .frame { animation: none; } }
        .pill { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
          pointer-events: auto; display: flex; align-items: center; gap: 10px;
          font: 500 13px/1 system-ui, sans-serif; color: #fff; background: #1b2a41;
          padding: 8px 8px 8px 14px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
        button { font: inherit; color: #fff; background: #d64545; border: 0; border-radius: 999px;
          padding: 6px 12px; cursor: pointer; }
        button:hover { background: #b83232; }
      </style>
      <div class="frame"></div>
      <div class="pill">LocalPilot is working <button type="button">Stop</button></div>`;
    shadow.querySelector('button').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
    });
    document.documentElement.appendChild(host);
  }

  function hide() {
    document.getElementById(HOST_ID)?.remove();
  }

  // Hidden during screenshots so the overlay does not confuse the model.
  window.__lpIndicator = { show, hide };
})();
