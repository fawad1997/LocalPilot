// CAPTCHA solving, ported from SeleniumBase's CDP mode (see D:\AI\undetected-testing).
//
// What the reference relies on, and what is done here:
//   - a real browser with no WebDriver (the extension is one) and trusted input events;
//   - clicking the real checkbox inside the provider's frame, found in the page, not at a
//     guessed page position;
//   - a human-shaped pointer path (human.js) instead of a jump-and-click;
//   - for Cloudflare's "verify you are human" checkbox, one click at the widget itself;
//   - for sliders, a curved drag with a small overshoot; for "press and hold", a long hold.
//
// It cannot solve picture grids (reCAPTCHA/hCaptcha image challenges), Arkose, or a login:
// those report `needs-user`, and the normal pause hands the tab over.
import { attach, detach, send } from './cdp.js';
import { humanClick, humanDrag, humanHold } from './human.js';
import { frameOffset } from './frames.js';
import { log } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scan must never hang a run: if a frame does not answer, work with what came back.
const withDeadline = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

export const PROVIDER_LABELS = {
  turnstile: 'Cloudflare Turnstile',
  'cloudflare-challenge': 'Cloudflare challenge',
  recaptcha: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  'human-verification': '“I am not a robot” check',
  'friendly-captcha': 'Friendly Captcha',
  geetest: 'GeeTest',
  'aliyun-slider': 'Aliyun slider',
  'tencent-captcha': 'Tencent CAPTCHA',
  'netease-yidun': 'NetEase Yidun',
  datadome: 'DataDome',
  perimeterx: 'PerimeterX',
  arkose: 'Arkose FunCaptcha',
};

export const SOLVABLE = new Set(['turnstile', 'cloudflare-challenge', 'recaptcha', 'hcaptcha', 'human-verification', 'friendly-captcha', 'geetest', 'aliyun-slider', 'datadome']);

// Runs in every frame. Returns what the frame shows: tokens (proof of success), clickable
// widgets with a point in this frame's coordinates, and signals that only the user can solve.
function probePage() {
  const out = {
    href: location.href,
    title: document.title || '',
    ready: document.readyState,
    tokens: {},
    candidates: [],
    imageChallenge: false,
    unsupported: null,
    holdText: false,
    challengeText: false,
  };
  const u = location.href;
  const inCf = /(^|\.)challenges\.cloudflare\.com$/.test(location.hostname) || /challenge-platform/.test(u);
  const inRecaptcha = /recaptcha/.test(location.hostname + location.pathname);
  const inHcaptcha = /(^|\.)hcaptcha\.com$/.test(location.hostname);
  const inDatadome = /captcha-delivery\.com/.test(u);

  const visible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    // Clipped or parked off-screen (reCAPTCHA's invisible badge keeps its checkbox at -186px)
    // is not clickable, and clicking that spot would open a challenge instead of passing one.
    if (r.right < 1 || r.bottom < 1 || r.left > innerWidth - 1 || r.top > innerHeight - 1) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    return Number(s.opacity || 1) > 0.05;
  };
  const centerOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const add = (provider, strategy, priority, point, extra = {}) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    out.candidates.push({ provider, strategy, priority, point: { x: point.x, y: point.y }, ...extra });
  };

  // --- success tokens ---
  for (const [name, sel] of Object.entries({
    turnstile: 'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
    recaptcha: 'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"]',
    hcaptcha: 'textarea[name="h-captcha-response"], input[name="h-captcha-response"]',
    friendly: 'input[name="frc-captcha-response"], input[name="frc-captcha-solution"]',
    generic: 'input[name="captcha-token"], input[name="incap-captcha-token"]',
  })) {
    const el = document.querySelector(sel);
    const value = el && typeof el.value === 'string' ? el.value.trim() : '';
    if (value.length > 12) out.tokens[name] = value.length;
  }

  // --- challenges a click cannot pass: hand these to the user ---
  if (document.querySelector('#rc-imageselect, .rc-imageselect-instructions, #rc-imageselect-target, iframe[title*="recaptcha challenge" i], iframe[title*="hCaptcha challenge" i]')) {
    out.imageChallenge = true;
  }
  if (/select all (images|squares)|click each (image|square)|select each image|please click each image|choose all images|click on all (images|squares)/i.test(
    document.body ? document.body.innerText.slice(0, 3000) : '',
  )) out.imageChallenge = true;
  if (document.querySelector('#arkose, iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], [class*="funcaptcha"]')) out.unsupported = 'arkose';
  if (document.querySelector('#tcaptcha_iframe, #tCaptchaDyMainWrap')) out.unsupported = 'tencent-captcha';
  if (document.querySelector('.yidun_popup, .yidun_intellisense, .yidun_modal')) out.unsupported = 'netease-yidun';
  if (document.querySelector('.geetest_item_wrap, .geetest_item')) out.imageChallenge = true; // icon selection

  // --- the real checkbox inside a provider's own frame (most precise) ---
  // The class names below are Cloudflare's widget markup; matching them (not only the frame
  // URL) also catches Turnstile-shaped widgets served from elsewhere.
  if (inCf || document.querySelector('.cb-lb, .cb-i, #cf-stage')) {
    const icon = document.querySelector('.cb-i, #cf-stage span[class*="cb-i"]');
    const label = document.querySelector('label.cb-lb, .cb-lb');
    const box = document.querySelector('input[type="checkbox"]');
    if (visible(icon)) add('turnstile', 'click', inCf ? 96 : 88, centerOf(icon));
    else if (visible(label)) add('turnstile', 'click', inCf ? 92 : 84, { x: label.getBoundingClientRect().left + 14, y: centerOf(label).y });
    else if (visible(box)) add('turnstile', 'click', inCf ? 90 : 82, centerOf(box));
  }
  // We are inside the provider frame, but its markup is unfamiliar or in a shadow root: the
  // checkbox of a Turnstile/hCaptcha widget sits just inside the frame's top-left corner.
  if (inCf && !out.candidates.length) add('turnstile', 'click', 62, { x: 27, y: 30 });
  if (inRecaptcha && !out.candidates.length) add('recaptcha', 'click', 60, { x: 28, y: 30 });
  if (inHcaptcha && !out.candidates.length) add('hcaptcha', 'click', 60, { x: 31, y: 36 });
  if (inRecaptcha) {
    const anchor = document.querySelector('#recaptcha-anchor, .recaptcha-checkbox');
    if (visible(anchor)) add('recaptcha', 'click', 96, centerOf(anchor));
  }
  if (inHcaptcha) {
    const cb = document.querySelector('#checkbox, div[role="checkbox"], .checkbox');
    if (visible(cb)) add('hcaptcha', 'click', 96, centerOf(cb));
  }
  if (inDatadome) {
    const slider = document.querySelector('div.slider, [class*="captcha"] div[class*="slider"]');
    const target = document.querySelector('div.sliderTarget, [class*="sliderTarget"]');
    if (visible(slider)) {
      const from = centerOf(slider);
      const to = visible(target) ? centerOf(target) : { x: from.x + 240, y: from.y };
      add('datadome', 'drag', 94, from, { to: { x: to.x + 22, y: to.y + 3 } });
    }
  }

  // --- sliders drawn by the page itself ---
  const geetest = document.querySelector('.geetest_slider_button, .geetest_slider_btn');
  if (visible(geetest)) {
    const track = geetest.closest('.geetest_slider_track, .geetest_slider, .geetest_holder') || document.querySelector('.geetest_holder');
    const from = centerOf(geetest);
    const rect = track ? track.getBoundingClientRect() : null;
    add('geetest', 'drag', 90, from, { to: { x: (rect ? rect.right : from.x + 260) - 6, y: from.y } });
  }
  const nc = document.querySelector('#nc_1_n1z');
  if (visible(nc)) {
    const track = nc.closest('.nc_scale, #nc_1_wrapper, .nc-container') || document.querySelector('#nc_1_wrapper');
    const from = centerOf(nc);
    const rect = track ? track.getBoundingClientRect() : null;
    add('aliyun-slider', 'drag', 93, from, { to: { x: (rect ? rect.right : from.x + 260) - 8, y: from.y } });
  }

  // --- widget containers, when the inside of the provider frame cannot be read ---
  const containers = [
    ['.cf-turnstile', 'turnstile', 27, 30, 45],
    ['.cf-turnstile-wrapper', 'turnstile', 27, 30, 44],
    ['#challenge-stage', 'cloudflare-challenge', 27, 30, 50],
    ['#challenge-form div > div', 'cloudflare-challenge', 27, 29, 47],
    ['[class*="cf-turnstile"]', 'turnstile', 27, 30, 42],
    ['.g-recaptcha', 'recaptcha', 28, 30, 45],
    ['.h-captcha', 'hcaptcha', 31, 36, 45],
    ['.frc-captcha', 'friendly-captcha', 27, 34, 44],
    ['#px-captcha', 'perimeterx', 0, 0, 72],
    ['#ddv1-captcha', 'datadome', 0, 0, 40],
  ];
  for (const [sel, provider, dx, dy, priority] of containers) {
    const el = document.querySelector(sel);
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 30) continue;
    if (provider === 'perimeterx' || provider === 'datadome') {
      add(provider, 'hold', priority, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, { holdMs: 10000 });
    } else {
      add(provider, 'click', priority, { x: r.left + dx, y: r.top + dy }, { w: r.width, h: r.height });
    }
  }

  // --- provider iframes: click near their checkbox / hold in their middle ---
  for (const f of document.querySelectorAll('iframe')) {
    if (!visible(f)) continue;
    const src = f.src || '';
    const r = f.getBoundingClientRect();
    if (/challenges\.cloudflare\.com/.test(src) && r.width > 140) {
      // A Turnstile widget is ~65 px tall; a taller frame is an opened image/selection challenge.
      if (r.height > 110) out.imageChallenge = true;
      else if (r.height > 40) add('turnstile', 'click', 60, { x: r.left + 27, y: r.top + 30 });
    } else if (/google\.com\/recaptcha/.test(src) && r.height > 40) {
      // The invisible reCAPTCHA badge sits at the bottom right; it is not a challenge.
      if (!(r.left > innerWidth - 140 && r.top > innerHeight - 140)) add('recaptcha', 'click', 62, { x: r.left + 28, y: r.top + 30 });
    } else if (/hcaptcha\.com/.test(src) && r.height > 40) {
      if (r.height > 120) out.imageChallenge = true; // the checkbox widget is ~78 px tall
      else add('hcaptcha', 'click', 62, { x: r.left + 31, y: r.top + 36 });
    } else if (/captcha-delivery\.com/.test(src) && r.width > 200 && r.height > 60) {
      add('datadome', 'hold', 40, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, { holdMs: 9000 });
    } else if (/arkoselabs|funcaptcha/.test(src)) {
      out.unsupported = 'arkose';
    }
  }
  if (inCf && window.innerHeight > 110) out.imageChallenge = true;

  const bodyText = document.body ? document.body.innerText.slice(0, 4000) : '';
  if (/press\s*(&|and)\s*hold/i.test(bodyText)) out.holdText = true;
  out.challengeText = /just a moment|verify you are human|checking (if the site connection is secure|your browser)|attention required|are you a robot|i'?m not a robot|unusual traffic|安全验证|人机验证|请完成验证|拖动滑块|滑动验证|请按住滑块|点击完成验证/i.test(
    `${document.title} ${bodyText}`.slice(0, 5000),
  );

  // --- plain "I am not a robot!" / "Verify you are human" controls (Brotector and friends) ---
  if (/i'?m not a robot|i am not a robot|verify you are human/i.test(bodyText)) {
    const labelRe = /^(i'?m not a robot!?|i am not a robot!?|verify you are human|are you a robot\??)$/i;
    const seen = new Set();
    const take = (root) => {
      for (const el of root.querySelectorAll('button, [role="button"], [role="checkbox"], a.button, label, div[class*="btn"], div[class*="button"]')) {
        if (seen.has(el)) continue;
        seen.add(el);
        const label = String(el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
        if (!labelRe.test(label)) continue;
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 16) continue;
        add('human-verification', 'click', 58, centerOf(el), { label });
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) take(el.shadowRoot);
    };
    take(document);
  }
  return out;
}

// CDP can see into shadow roots (closed ones included), where some challenges keep their
// widget. Its box model also applies CSS transforms, so a rotated widget still gets the right
// point. Used only when the page scan finds nothing, and only for known challenge markup.
async function cdpShadowCandidates(tabId) {
  // Every CDP call here is time-bounded: one unanswered command must not stall the whole run
  // (and, over MCP, every other call queued behind it).
  await send(tabId, 'DOM.enable', {}, { timeoutMs: 3000 }).catch(() => {});
  const { root } = await send(tabId, 'DOM.getDocument', { depth: -1, pierce: true }, { timeoutMs: 5000 });
  const found = [];
  let budget = 20000;
  let nodes = 0;
  const walk = (node, depth) => {
    if (budget-- < 0 || depth > 60) return;
    nodes += 1;
    const name = String(node.nodeName || '').toUpperCase();
    const attrs = node.attributes || [];
    const attr = (k) => {
      const i = attrs.indexOf(k);
      return i >= 0 ? String(attrs[i + 1] || '') : '';
    };
    const cls = attr('class');
    const id = attr('id');
    if (name === 'IFRAME') {
      const src = attr('src');
      if (/challenges\.cloudflare\.com/.test(src)) found.push({ node: node.nodeId, provider: 'turnstile', spec: 'iframe' });
      else if (/google\.com\/recaptcha/.test(src)) found.push({ node: node.nodeId, provider: 'recaptcha', spec: 'iframe' });
      else if (/hcaptcha\.com/.test(src)) found.push({ node: node.nodeId, provider: 'hcaptcha', spec: 'iframe' });
      else if (src) found.push({ node: node.nodeId, provider: 'turnstile', spec: 'iframe', generic: true });
    } else if (/(^|\s)(cb-i|cb-lb)(\s|$)/.test(cls)) {
      found.push({ node: node.nodeId, provider: 'turnstile', spec: 'widget' });
    } else if (id === 'challenge-stage' || /(^|\s)(cf-turnstile|challenge-stage)(\s|$)/.test(cls)) {
      found.push({ node: node.nodeId, provider: 'cloudflare-challenge', spec: 'container' });
    } else if (name === 'BUTTON' || attr('role') === 'button' || name === 'LABEL') {
      const text = (node.children || []).filter((c) => c.nodeName === '#text').map((c) => c.nodeValue || '').join(' ').trim();
      if (/i'?m not a robot|i am not a robot|verify you are human/i.test(text)) {
        found.push({ node: node.nodeId, provider: 'human-verification', spec: 'button' });
      }
    }
    for (const child of node.children || []) walk(child, depth + 1);
    for (const shadow of node.shadowRoots || []) walk(shadow, depth + 1);
    if (node.contentDocument) walk(node.contentDocument, depth + 1);
  };
  walk(root, 0);
  const offsets = { turnstile: [27, 30], recaptcha: [28, 30], hcaptcha: [31, 36], 'cloudflare-challenge': [27, 30] };
  const out = [];
  for (const hit of found.slice(0, 8)) {
    const { model } = await send(tabId, 'DOM.getBoxModel', { nodeId: hit.node }, { timeoutMs: 3000 }).catch(() => ({}));
    const quad = model?.content;
    if (!quad || quad.length < 8) continue;
    const w = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]);
    const h = Math.hypot(quad[4] - quad[2], quad[5] - quad[3]);
    if (w < 6 || h < 6 || w > 1200 || h > 1200) continue;
    if (hit.generic && !(w >= 140 && w <= 600 && h >= 40 && h <= 160)) continue; // not widget-shaped
    const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    const [dx, dy] = offsets[hit.provider] || [0, 0];
    // Widgets and iframes: click near their top-left corner, where the checkbox is.
    // A plain button: click its middle.
    const point = hit.spec === 'button' ? { x: cx, y: cy } : { x: quad[0] + dx, y: quad[1] + dy };
    out.push({
      provider: hit.provider,
      strategy: 'click',
      priority: hit.spec === 'widget' ? 94 : hit.spec === 'button' ? 57 : hit.generic ? 40 : hit.spec === 'iframe' ? 59 : 55,
      point,
      topPoint: point,
      frameId: 0,
      frameUrl: 'shadow-dom',
    });
  }
  log('captcha_deep_scan', { tabId, nodes, found: found.length, usable: out.length });
  return out;
}

// Everything the frames show right now: tokens, widgets with top-level click points, and
// signals that this needs the user. Frames are injected one at a time because one sandboxed
// frame must not take the others down with it. `deep` also pierces closed shadow roots.
export async function scanChallenge(tabId, { deep = false } = {}) {
  await attach(tabId);
  const all = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const ordered = [...all].sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0)).slice(0, 16);
  if (!ordered.length) ordered.push({ frameId: 0, url: '' });
  const frames = [];
  for (const frame of ordered) {
    try {
      const [r] = await withDeadline(
        chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, func: probePage }),
        5000,
        [],
      );
      if (r?.result && typeof r.result === 'object') frames.push({ frameId: frame.frameId, url: frame.url || r.result.href || '', ...r.result });
    } catch {
      // Sandboxed frame, or it went away while loading: the other frames still count.
    }
  }
  const candidates = [];
  for (const frame of frames) {
    if (!frame.candidates.length) continue;
    let off;
    try {
      off = await withDeadline(frameOffset(tabId, frame.frameId), 8000, null);
    } catch {
      off = null;
    }
    if (!off) continue; // frame went away, or cannot be located: the remaining frames still count
    for (const c of frame.candidates) {
      candidates.push({
        ...c,
        frameId: frame.frameId,
        frameUrl: frame.url,
        topPoint: { x: c.point.x + off.x, y: c.point.y + off.y },
        ...(c.to ? { topTo: { x: c.to.x + off.x, y: c.to.y + off.y } } : {}),
      });
    }
  }
  const top = frames.find((f) => f.frameId === 0) || {};
  const result = {
    url: top.href || '',
    title: top.title || '',
    tokens: Object.assign({}, ...frames.map((f) => f.tokens)),
    candidates,
    imageChallenge: frames.some((f) => f.imageChallenge),
    unsupported: frames.find((f) => f.unsupported)?.unsupported || null,
    holdText: frames.some((f) => f.holdText),
    challengeText: frames.some((f) => f.challengeText),
    frames: frames.length,
  };
  if (deep && !candidates.length) {
    const extra = await cdpShadowCandidates(tabId).catch(() => []);
    if (extra.length) result.candidates = extra;
  }
  result.candidates.sort((a, b) => b.priority - a.priority);
  return result;
}

// Is a success token there? Tokens are what a form posts, so they are proof the check passed.
export function tokensPassed(tokens = {}) {
  return Object.values(tokens).some((n) => Number(n) > 12);
}

// One word for the current state: solved | needs-user | unsupported | challenge | none.
export function verdict(scan) {
  if (!scan) return 'none';
  if (tokensPassed(scan.tokens)) return 'solved';
  if (scan.imageChallenge) return 'needs-user';
  if (scan.unsupported) return 'unsupported';
  if (scan.candidates.length) return 'challenge';
  if (scan.challengeText) return 'challenge';
  return 'none';
}

const STRATEGY_LABEL = {
  turnstile: 'the Turnstile checkbox',
  'cloudflare-challenge': 'the Cloudflare checkbox',
  recaptcha: "reCAPTCHA's “I'm not a robot” box",
  hcaptcha: "hCaptcha's “I am human” box",
  'human-verification': 'the “I am not a robot” button',
  'friendly-captcha': 'the Friendly Captcha box',
  geetest: 'the GeeTest slider',
  'aliyun-slider': 'the slider',
  datadome: 'the DataDome check',
  perimeterx: 'the “press and hold” area',
};

export function describeChallenge(scan) {
  const state = verdict(scan);
  if (state === 'none') return 'No CAPTCHA or bot check is showing in this tab.';
  const provider = scan.candidates[0]?.provider;
  const label = PROVIDER_LABELS[provider] || provider || 'a bot check';
  if (state === 'solved') return `The ${label} check is already passed (its success token is on the page).`;
  if (state === 'needs-user') return `A ${label} picture/selection challenge is showing. That needs you: solve it in the tab.`;
  if (state === 'unsupported') return `${PROVIDER_LABELS[scan.unsupported] || scan.unsupported} cannot be solved by clicking. Solve it in the tab.`;
  if (!scan.candidates.length) return `A ${label} check is showing, but its widget is not reachable. Solve it in the tab.`;
  return `A ${label} check is showing: ${STRATEGY_LABEL[provider] || 'a widget'} at (${Math.round(scan.candidates[0].topPoint.x)}, ${Math.round(scan.candidates[0].topPoint.y)}).`;
}

// Scroll the top-level page when the widget is outside the viewport. Returns true when it
// scrolled, so the caller measures the widget again before clicking.
async function scrollToShow(tabId, point) {
  const metrics = await send(tabId, 'Page.getLayoutMetrics', {}, { timeoutMs: 4000 }).catch(() => null);
  const vp = metrics?.cssVisualViewport || metrics?.layoutViewport;
  if (!vp) return false;
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  let dx = 0;
  let dy = 0;
  if (point.x < 10) dx = point.x - 60;
  else if (point.x > w - 10) dx = point.x - w + 60;
  if (point.y < 10) dy = point.y - 60;
  else if (point.y > h - 10) dy = point.y - h + 60;
  if (!dx && !dy) return false;
  await chrome.scripting.executeScript({ target: { tabId }, func: (x, y) => window.scrollBy(x, y), args: [dx, dy] }).catch(() => {});
  await sleep(250);
  return true;
}

async function waitUntilSettled(tabId, ms, provider) {
  const end = Date.now() + ms;
  let scan = null;
  while (Date.now() < end) {
    await sleep(provider === 'turnstile' || provider === 'cloudflare-challenge' ? 750 : 600);
    scan = await scanChallenge(tabId);
    if (verdict(scan) !== 'challenge' || scan.imageChallenge) return scan;
  }
  return scan || (await scanChallenge(tabId));
}

// A Cloudflare interstitial draws its widget a moment after the page itself, so a scan right
// after load can legitimately see nothing. Wait for it before deciding it is not there.
async function waitForWidget(tabId, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(700);
    const scan = await scanChallenge(tabId).catch(() => null);
    if (scan?.candidates?.length) return scan;
  }
  return null;
}

function result(status, { provider = null, clicks = 0, scan = null, reason = '', started = Date.now() } = {}) {
  return { status, provider, clicks, reason, ms: Date.now() - started, scan };
}

// Try to pass the check showing in the tab. Never throws for a failed attempt: the caller
// decides whether to hand over to the user.
//   status: solved | none | needs-user | unsupported | failed
const HARD_TIMEOUT_MS = 90000;

export async function solveChallenge(tabId, opts = {}) {
  const started = Date.now();
  // Hard ceiling: a browser command that never answers must not block this run (over MCP it
  // would also block every call queued behind it). The attempt keeps going in the background
  // at worst, and the check is re-read next time.
  const guard = new Promise((resolve) => {
    setTimeout(() => resolve({ status: 'failed', provider: null, clicks: 0, reason: 'timeout', ms: Date.now() - started, scan: null }), HARD_TIMEOUT_MS);
  });
  return Promise.race([solveInner(tabId, opts), guard]);
}

async function solveInner(tabId, { attempts = 2, settleMs = 800 } = {}) {
  const started = Date.now();
  const budgetMs = 75000; // a stuck page must hand the check over, not hold the browser
  await attach(tabId);
  await sleep(settleMs); // Turnstile and hCaptcha often pass on their own shortly after load
  let scan = await scanChallenge(tabId);
  let clicks = 0;
  let provider = null;
  for (let round = 0; round < 14; round += 1) {
    if (Date.now() - started > budgetMs) break;
    const state = verdict(scan);
    log('captcha_round', { tabId, round, state, candidates: scan?.candidates?.length ?? -1, deep: scan?.candidates?.[0]?.frameUrl === 'shadow-dom' });
    if (state !== 'challenge') return result(state, { provider, clicks, scan, started });
    const cand = scan.candidates[0];
    if (!cand) {
      // Late-rendering widget first, then closed shadow roots (Cloudflare's newer challenge UI).
      const late = await waitForWidget(tabId, 8000);
      if (late) {
        scan = late;
        continue;
      }
      const deepScan = await scanChallenge(tabId, { deep: true }).catch((err) => {
        log('captcha_scan_error', { tabId, error: String(err?.message || err) });
        return null;
      });
      log('captcha_deep_result', { tabId, candidates: deepScan?.candidates?.length ?? -1 });
      if (deepScan?.candidates?.length) {
        scan = deepScan;
        continue;
      }
      return result('failed', { provider, clicks, scan, reason: 'no widget found', started });
    }
    if (clicks >= attempts) return result('failed', { provider, clicks, scan, reason: 'still showing', started });

    if (await scrollToShow(tabId, cand.topPoint)) {
      // A candidate from the shadow-DOM scan is already in top-level pixels; keep using that
      // source after the scroll, otherwise the next shallow scan would lose it again.
      scan = await scanChallenge(tabId, { deep: scan.candidates[0]?.frameUrl === 'shadow-dom' });
      continue;
    }

    const deep = scan.candidates[0]?.frameUrl === 'shadow-dom';
    const freshScan = await scanChallenge(tabId, { deep });
    const fresh = freshScan.candidates[0];
    if (!fresh) {
      if (deep) return result('failed', { provider, clicks, scan: freshScan, reason: 'shadow widget lost', started });
      continue;
    }
    provider = fresh.provider;
    log('captcha_click', {
      tabId, provider, strategy: fresh.strategy, frame: String(fresh.frameUrl).slice(0, 140),
      x: Math.round(fresh.topPoint.x), y: Math.round(fresh.topPoint.y),
    });
    if (!SOLVABLE.has(provider) && provider !== 'perimeterx') {
      return result('unsupported', { provider, clicks, scan, reason: provider, started });
    }
    try {
      if (fresh.strategy === 'drag' && fresh.topTo) await humanDrag(tabId, fresh.topPoint, fresh.topTo);
      else if (fresh.strategy === 'hold') await humanHold(tabId, fresh.topPoint.x, fresh.topPoint.y, fresh.holdMs || 10000);
      else await humanClick(tabId, fresh.topPoint.x, fresh.topPoint.y);
    } catch (err) {
      // The gesture threw (the page navigated in the middle of it, or the debugger dropped):
      // reconnect and let the next round try again with fresh coordinates.
      log('captcha_click_error', { tabId, provider, error: String(err.message || err) });
      await detach(tabId).catch(() => {});
      await attach(tabId).catch(() => {});
    }
    clicks += 1;
    log('captcha_stage', { tabId, stage: 'clicked', provider, clicks, round });
    const waitMs = /turnstile|cloudflare/.test(provider) ? 9000 : 6000;
    scan = await waitUntilSettled(tabId, waitMs, provider);
    log('captcha_stage', { tabId, stage: 'settled', verdict: verdict(scan), tokens: Object.keys(scan.tokens).length, candidates: scan.candidates.length });
  }
  return result('failed', { provider, clicks, scan, reason: 'still showing', started });
}
