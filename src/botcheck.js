// CAPTCHA / bot-check handling. LocalPilot never tries to solve or bypass these:
// it detects them, stops acting, and hands the tab to the user.
import { log } from './logger.js';

const PROVIDER_FRAMES = [
  ['recaptcha', /google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha/],
  ['hcaptcha', /hcaptcha\.com/],
  ['cloudflare-turnstile', /challenges\.cloudflare\.com/],
  ['geetest', /geetest\.com/],
  ['arkose-funcaptcha', /arkoselabs\.com|funcaptcha\.com/],
  ['datadome', /captcha-delivery\.com|datadome/],
  ['tencent-captcha', /captcha\.qcloud\.com|turing\.captcha/],
  ['aws-waf-captcha', /awswaf|captcha\.awswaf/],
];

// Runs in the page. Returns { kind, signals } or null.
function probeInPage(providerSources) {
  const providers = providerSources.map(([k, src]) => [k, new RegExp(src)]);
  const signals = [];
  let kind = null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.src || '';
    for (const [k, re] of providers) {
      // reCAPTCHA v3 / invisible badges are not challenges: require a sizeable, visible frame.
      if (re.test(src) && visible(f) && f.getBoundingClientRect().height > 40) {
        kind ??= k;
        signals.push(`iframe:${k}`);
      }
    }
  }
  const selectors = {
    '#challenge-form, #cf-challenge-running, .cf-turnstile, #turnstile-wrapper': 'cloudflare-challenge',
    '.g-recaptcha': 'recaptcha',
    '.h-captcha': 'hcaptcha',
    '#px-captcha': 'perimeterx',
    '.geetest_holder, .geetest_panel, .geetest_box': 'geetest',
    '#nc_1_wrapper, .nc-container, #aliyunCaptcha-window-popup': 'aliyun-slider',
    '.yidun, .yidun_popup': 'netease-yidun',
    '#tcaptcha_iframe, #tCaptchaDyMainWrap': 'tencent-captcha',
    '[class*="slider-verify" i], [class*="verify-slider" i], [class*="captcha" i][class*="slide" i]': 'slider-captcha',
  };
  for (const [sel, k] of Object.entries(selectors)) {
    const el = document.querySelector(sel);
    if (el && visible(el)) {
      kind ??= k;
      signals.push(`dom:${k}`);
    }
  }
  const title = document.title || '';
  const body = (document.body?.innerText || '').slice(0, 3000);
  const short = body.length < 1500;
  const texts = [
    [/Just a moment\.\.\.|Attention Required! \| Cloudflare|Checking your browser|Checking if the site connection is secure/i, 'cloudflare-challenge', true],
    [/Verify you are human|I'm not a robot|confirm you are not a robot|Are you a robot\?/i, 'human-verification', true],
    [/Press (&|and) Hold/i, 'press-and-hold', true],
    [/unusual traffic from your computer network/i, 'google-unusual-traffic', true],
    [/安全验证|人机验证|请完成验证|拖动滑块|滑动验证|请按住滑块|点击完成验证/, 'chinese-verification', true],
    [/环境存在异常|访问过于频繁|操作过于频繁|请稍后再试/, 'rate-limited', false],
    [/Access denied|Request blocked|You have been blocked|Too Many Requests/i, 'blocked', false],
  ];
  for (const [re, k, strong] of texts) {
    if (re.test(title) || (re.test(body) && (strong ? body.length < 4000 : short))) {
      kind ??= k;
      signals.push(`text:${k}`);
    }
  }
  // A challenge-looking URL alone is not evidence (sites keep the URL after you pass);
  // it only supports another signal. Google's "sorry" page is the exception.
  if (/\/sorry\/index/.test(location.pathname)) {
    kind ??= 'google-unusual-traffic';
    signals.push('url');
  } else if (kind && /security-check|captcha|challenge|verify/i.test(location.href)) {
    signals.push('url');
  }
  return kind ? { kind, signals, url: location.href, title } : null;
}

const SERIAL_PROVIDERS = PROVIDER_FRAMES.map(([k, re]) => [k, re.source]);

export async function detectBotCheck(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: probeInPage, args: [SERIAL_PROVIDERS] });
    return res?.result || null;
  } catch {
    return null; // restricted page or navigating
  }
}

// Is the CSS point on a CAPTCHA widget? Used to refuse clicks on them.
export async function captchaAtPoint(tabId, x, y) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (px, py, providers) => {
        const el = document.elementFromPoint(px, py);
        if (!el) return null;
        const frame = el.closest('iframe');
        if (frame && providers.some(([, src]) => new RegExp(src).test(frame.src || ''))) return frame.src;
        const widget = el.closest('.g-recaptcha, .h-captcha, .cf-turnstile, #px-captcha, .geetest_holder, .geetest_panel, #nc_1_wrapper, .nc-container, .yidun, #tcaptcha_iframe');
        return widget ? widget.className || widget.id : null;
      },
      args: [x, y, SERIAL_PROVIDERS],
    });
    return res?.result || null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After a page-changing tool: if a bot check is showing, pause for the user
// (side panel) or warn the caller (MCP). Returns text to append to the tool result.
export async function handleBotCheck(ctx, toolName) {
  const found = await detectBotCheck(ctx.tabId);
  if (!found) return '';
  let host = '';
  try {
    host = new URL(found.url).hostname;
  } catch {
    // keep empty
  }
  log('bot_check', { runId: ctx.runId, tool: toolName, host, ...found });
  const warning = `BOT CHECK DETECTED (${found.kind}) on ${host}. Do not try to solve, click or bypass it. The user must complete it in the browser.`;
  if (ctx.mcp || ctx.settings.pauseOnBotCheck === false) return `\n\n⚠ ${warning} Ask the user to complete it, then continue.`;

  for (let round = 1; round <= 3; round += 1) {
    const decision = await ctx.requestApproval({ mode: 'verification', host, kind: found.kind, tool: toolName, input: {} });
    log('bot_check_decision', { runId: ctx.runId, host, kind: found.kind, decision, round });
    if (decision !== 'continue') {
      throw new Error(`Stopped at a ${found.kind} check on ${host}. The user chose not to continue.`);
    }
    for (let i = 0; i < 8; i += 1) {
      if (!(await detectBotCheck(ctx.tabId))) {
        log('bot_check_cleared', { runId: ctx.runId, host, kind: found.kind });
        return `\n\nA ${found.kind} check appeared on ${host}; the user completed it. The page may have changed: read it again before acting.`;
      }
      await sleep(1000);
    }
  }
  throw new Error(`The ${found.kind} check on ${host} is still showing. Stopping here.`);
}
