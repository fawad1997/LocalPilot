// Application assistant: fill the open application form from cv_data.json and attach the
// tailored CV, then STOP. The agent never submits: the user reviews the form and presses
// Submit themselves, then confirms in the panel, and only then is the application logged
// to application_tracker.json (through the allowlisted log-application script).
import * as cdp from '../cdp.js';
import * as pc from '../pcbridge.js';
import { log } from '../logger.js';
import { requireHost, sleep } from './common.js';

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Submit guard: after apply_assist filled a form, the agent may not submit it on that site.

const guardedTabs = new Map(); // tabId -> host of the filled form

export function isGuarded(tabId) {
  return guardedTabs.has(tabId);
}

async function activeGuard(tabId) {
  const host = guardedTabs.get(tabId);
  if (!host) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || hostOf(tab.url) !== host) {
    guardedTabs.delete(tabId);
    return null;
  }
  return host;
}

const REFUSAL = 'Refused: LocalPilot never submits job applications. The form was filled by apply_assist; the user reviews it and presses Submit in the tab themselves. Tell the user it is ready for them.';

// Throws when the action would submit the guarded form. kind: 'click' {x, y} | 'key' {text} | 'type' {text} | 'js'.
export async function checkSubmitGuard(ctx, kind, detail = {}) {
  if (!(await activeGuard(ctx.tabId))) return;
  if (kind === 'js') throw new Error(REFUSAL);
  if (kind === 'type' && !/\n/.test(detail.text || '')) return;
  if (kind === 'key' && !/\b(enter|return)\b/i.test(detail.text || '')) return;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: ctx.tabId },
    args: [kind, detail.x ?? 0, detail.y ?? 0],
    func: (k, x, y) => {
      const SUBMIT_TEXT = /^(submit|apply|apply now|send|send application|submit application|complete application|finish|confirm|投递|提交|申请|立即申请|立即投递|确认投递|确认提交|发送)/i;
      let doc = document;
      let el;
      if (k === 'click') {
        el = doc.elementFromPoint(x, y);
        // Descend into same-origin iframes.
        while (el && el.tagName === 'IFRAME') {
          let inner;
          try {
            inner = el.contentDocument;
          } catch {
            inner = null;
          }
          if (!inner) break;
          const r = el.getBoundingClientRect();
          x -= r.left;
          y -= r.top;
          doc = inner;
          el = doc.elementFromPoint(x, y);
        }
        const b = el?.closest?.('button, input[type=submit], input[type=image], a, [role=button]');
        if (!b) return false;
        const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
        const submitType = (b.tagName === 'BUTTON' && b.type === 'submit' && b.form) || (b.tagName === 'INPUT' && /^(submit|image)$/i.test(b.type));
        return SUBMIT_TEXT.test(label) || (submitType && !label);
      }
      // Enter (or a typed newline) in a single-line form field submits the form.
      el = doc.activeElement;
      while (el && el.tagName === 'IFRAME') {
        try {
          el = el.contentDocument?.activeElement;
        } catch {
          break;
        }
      }
      return !!(el && el.form && el.tagName !== 'TEXTAREA');
    },
  }).catch(() => [{ result: false }]);
  if (res?.result) {
    log('apply_submit_refused', { runId: ctx.runId, kind });
    throw new Error(REFUSAL);
  }
}

// ---------------------------------------------------------------------------
// Profile from cv_data.json

export function profileFrom(cv) {
  const p = cv.personal || {};
  const parts = String(p.name || '').trim().split(/\s+/);
  const loc = String(p.location || '').split(',').map((s) => s.trim()).filter(Boolean);
  const url = (v, prefix) => (!v ? '' : /^https?:/.test(v) ? v : `${prefix}${v}`);
  const github = url(p.github, 'https://github.com/');
  return {
    fullName: p.name || '',
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
    email: p.email || '',
    phone: p.phone || '',
    city: loc.length > 1 ? loc[loc.length - 2] : loc[0] || '',
    country: loc.length > 1 ? loc[loc.length - 1] : '',
    linkedin: url(p.linkedin, 'https://www.linkedin.com/in/'),
    github,
    website: p.website || github,
    title: p.title || '',
    nationality: p.nationality || '',
    summary: cv.summary || '',
  };
}

// Runs inside every frame of the page.
function fillFrame(profile, answers, nonce) {
  const SENSITIVE = /password|passwort|passport|身份证|id ?(card|number)|ssn|social security|card number|cvv|iban|bank|银行/i;
  const PERSONAL = /salary|薪资|期望|gender|性别|date of birth|birthday|出生|marital|婚/i; // only from explicit answers
  const RULES = [
    ['email', /e-?mail|邮箱|电子邮件/i],
    ['phone', /phone|mobile|\btel\b|手机|电话/i],
    ['linkedin', /linkedin|领英/i],
    ['github', /github/i],
    ['website', /website|portfolio|personal (site|url|page)|个人网站|作品集/i],
    ['firstName', /first.?name|given.?name|forename|vorname|^名$/i],
    ['lastName', /last.?name|family.?name|surname|nachname|姓氏|^姓$/i],
    ['fullName', /full.?name|^name\b|your name|姓名|^名字/i],
    ['nationality', /nationality|citizenship|国籍/i],
    ['country', /country|国家/i],
    ['city', /\bcity\b|\btown\b|location|城市|所在地|现居|居住地/i],
    ['title', /current (job )?title|headline|current (position|role)|当前职位|目前职位/i],
    ['summary', /summary|about (you|yourself|me)|cover letter|motivation|自我介绍|自我评价|求职信|个人简介/i],
  ];
  const AUTOCOMPLETE = {
    'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', email: 'email', tel: 'phone', 'tel-national': 'phone',
    'address-level2': 'city', country: 'country', 'country-name': 'country', url: 'website', 'organization-title': 'title',
  };
  const textOf = (n) => (n?.innerText || n?.textContent || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const byFor = el.id && el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const by = ids.map((id) => textOf(document.getElementById(id))).join(' ');
    return (textOf(byFor) || by || el.getAttribute('aria-label') || textOf(el.closest('label')) || el.placeholder || el.name || el.id || '').slice(0, 120);
  };
  const setNative = (el, v) => {
    let proto = Object.getPrototypeOf(el);
    let desc;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
    if (desc?.set) desc.set.call(el, v);
    else el.value = v;
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
  };
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const filled = [];
  const skipped = [];
  const kept = [];
  const files = [];
  for (const el of all) {
    const type = (el.type || '').toLowerCase();
    if (el.disabled || el.readOnly || ['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes(type)) continue;
    if (type !== 'file' && !el.getClientRects().length) continue;
    const label = labelOf(el);
    if (type === 'file') {
      files.push({ el, label });
      continue;
    }
    if (type === 'password' || SENSITIVE.test(label)) {
      skipped.push({ label, reason: 'sensitive: left for you' });
      continue;
    }
    if (String(el.value || '').trim() && el.tagName !== 'SELECT') {
      kept.push(label);
      continue;
    }
    const low = label.toLowerCase();
    let value = Object.entries(answers || {}).find(([k]) => k && low.includes(k.toLowerCase()))?.[1];
    if (value === undefined && PERSONAL.test(label)) {
      skipped.push({ label, reason: 'personal decision: left for you' });
      continue;
    }
    if (value === undefined) {
      const key = AUTOCOMPLETE[(el.getAttribute('autocomplete') || '').toLowerCase()] || RULES.find(([, re]) => re.test(label))?.[0];
      if (key === 'summary' && el.tagName !== 'TEXTAREA') value = undefined;
      else value = key ? profile[key] : undefined;
    }
    if (value === undefined || value === null || value === '') {
      skipped.push({ label, reason: 'no matching data' });
      continue;
    }
    value = String(value);
    if (el.tagName === 'SELECT') {
      const want = value.toLowerCase();
      const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
        || [...el.options].find((o) => o.value && o.text.toLowerCase().includes(want));
      if (!opt) {
        skipped.push({ label, reason: `no option matching "${value}"` });
        continue;
      }
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push({ label, value: opt.text.trim() });
      continue;
    }
    setNative(el, value);
    filled.push({ label, value: value.length > 80 ? `${value.slice(0, 80)}…` : value });
  }
  const cvInput = files.find((f) => /resume|\bcv\b|简历|curriculum|lebenslauf/i.test(f.label) || /pdf/i.test(f.el.accept || '')) || files[0];
  if (cvInput) cvInput.el.setAttribute('data-lp-apply', nonce);
  return { url: location.href, filled, skipped, kept, file: cvInput ? cvInput.label || 'file input' : null };
}

// ---------------------------------------------------------------------------
// Pending applications (filled, waiting for the user to say they submitted)

const pendingKey = (id) => `apply:${id}`;

export async function pendingApplications(tabId) {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([k, v]) => k.startsWith('apply:') && (tabId === undefined || v.panelTabId === tabId)).map(([, v]) => v);
}

// Called from the panel ("I submitted it" / "Not submitted"). Only then is the tracker touched.
export async function resolveApplication(id, submitted) {
  const key = pendingKey(id);
  const rec = (await chrome.storage.session.get(key))[key];
  if (!rec) throw new Error('This application is no longer pending.');
  await chrome.storage.session.remove(key);
  if (!submitted) {
    log('apply_not_submitted', { id, company: rec.company, role: rec.role });
    return `Not logged: ${rec.company} — ${rec.role} was not submitted.`;
  }
  const host = await pc.probe();
  if (!host?.scripts.some((s) => s.name === 'log-application')) {
    await chrome.storage.session.set({ [key]: rec });
    throw new Error('The log-application script is not allowlisted in host/config.json, so the tracker was not updated.');
  }
  const payload = { company: rec.company, role: rec.role, country: rec.country, jobUrl: rec.jobUrl, cvPath: rec.cvPath, source: 'localpilot' };
  const res = await pc.call('run_script', { name: 'log-application', args: ['add', JSON.stringify(payload)] });
  log('apply_logged', { id, exitCode: res.exitCode, stdout: res.stdout.slice(0, 300), stderr: res.stderr.slice(0, 300) });
  if (res.exitCode !== 0) {
    await chrome.storage.session.set({ [key]: rec });
    throw new Error(`log-application failed (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim() || `Logged ${rec.company} — ${rec.role}.`;
}

// ---------------------------------------------------------------------------

async function run(ctx, input) {
  const { root } = requireHost(ctx);
  const company = String(input.company || '').trim();
  const role = String(input.role || '').trim();
  if (!company || !role) throw new Error('company and role are required.');
  const tab = await chrome.tabs.get(ctx.tabId);
  const host = hostOf(tab.url);
  if (!/^https?:/.test(tab.url)) throw new Error('Open the application form in the tab first.');
  const status = (t) => ctx.emit?.({ type: 'status', text: t });

  status('apply_assist: reading cv_data.json…');
  const cvData = await pc.call('read_file', { root, path: input.cv_data_path || 'cv_data.json' });
  const profile = profileFrom(JSON.parse(cvData.content));
  const cvFile = input.cv_path ? await pc.call('resolve_path', { root, path: input.cv_path }) : null;

  status(`apply_assist: filling the form on ${host}…`);
  const nonce = Math.random().toString(36).slice(2, 10);
  const frames = await chrome.scripting.executeScript({
    target: { tabId: ctx.tabId, allFrames: true },
    func: fillFrame,
    args: [profile, input.answers || {}, nonce],
  });
  const results = frames.map((f) => f.result).filter(Boolean);
  const filled = results.flatMap((r) => r.filled);
  const skipped = results.flatMap((r) => r.skipped);
  const kept = results.flatMap((r) => r.kept);
  const fileLabel = results.find((r) => r.file)?.file;

  let upload = 'No CV given (cv_path), nothing attached.';
  if (cvFile) {
    if (!fileLabel) upload = `No file input found on the page; attach ${cvFile.path} yourself.`;
    else {
      try {
        await cdp.setFileInputFiles(ctx.tabId, `[data-lp-apply="${nonce}"]`, [cvFile.path]);
        upload = `Attached ${cvFile.path} (${Math.round(cvFile.size / 1024)} KB) to "${fileLabel}".`;
      } catch (err) {
        upload = `Could not attach the CV (${err.message}); attach ${cvFile.path} yourself.`;
      }
    }
  }
  await chrome.scripting.executeScript({
    target: { tabId: ctx.tabId, allFrames: true },
    args: [nonce],
    func: (n) => document.querySelectorAll(`[data-lp-apply="${n}"]`).forEach((el) => el.removeAttribute('data-lp-apply')),
  }).catch(() => {});
  await sleep(300);

  guardedTabs.set(ctx.tabId, host);
  const id = crypto.randomUUID();
  const record = {
    id, company, role, country: input.country || 'China', jobUrl: input.job_url || tab.url, cvPath: input.cv_path || '',
    host, createdAt: new Date().toISOString(), panelTabId: ctx.panelTabId ?? ctx.tabId,
    filled, skipped, kept, upload,
  };
  await chrome.storage.session.set({ [pendingKey(id)]: record });
  ctx.emit?.({ type: 'apply_review', ...record });
  log('apply_assist', { runId: ctx.runId, host, company, role, filled: filled.length, skipped: skipped.length, kept: kept.length, upload });

  const lines = [
    `Filled ${filled.length} field(s) on ${host} for ${role} at ${company}:`,
    ...filled.map((f) => `- ${f.label}: ${f.value}`),
    kept.length ? `Already filled, left as is: ${kept.join(', ')}` : '',
    skipped.length ? `Not filled (for the user): ${skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}` : '',
    upload,
    '',
    'STOP HERE. Do not click Submit / Apply / 投递 and do not press Enter in the form: LocalPilot never submits applications.',
    'You may fill the remaining fields the user asks for with form_input, but tell the user to review the form and press Submit themselves. A card in the panel lets them confirm afterwards; only then is it logged to application_tracker.json.',
  ];
  return [{ type: 'text', text: lines.filter((l, i) => l || i === lines.length - 3).join('\n') }];
}

export default {
  definition: {
    name: 'apply_assist',
    description:
      'Fill the job application form open in this tab from the user\'s cv_data.json (name, email, phone, links, city, summary…) and attach the tailored CV PDF. ' +
      'It never submits: afterwards the user reviews the form and presses Submit themselves, then confirms in the panel so the application is logged to application_tracker.json. ' +
      'Never click Submit/Apply yourself after this tool, even if asked.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name, for the tracker.' },
        role: { type: 'string', description: 'Job title applied for, for the tracker.' },
        cv_path: { type: 'string', description: 'Tailored CV PDF, relative to the jobs root, e.g. "China/Applications/Acme_FullStack/CV_Fawad.pdf".' },
        country: { type: 'string', description: 'Country folder for the tracker (default "China").' },
        job_url: { type: 'string', description: 'Job posting URL (default: the current tab).' },
        answers: { type: 'object', description: 'Extra answers by field label text, e.g. {"notice period": "1 month"}. Matched case-insensitively against field labels.', additionalProperties: { type: 'string' } },
        cv_data_path: { type: 'string', description: 'Default "cv_data.json" in the jobs root.' },
      },
      required: ['company', 'role'],
    },
  },
  domains: [],
  mcp: false, // the review card and confirmation live in the side panel
  approval: async (ctx) => {
    const tab = await chrome.tabs.get(ctx.tabId).catch(() => null);
    const h = hostOf(tab?.url || '');
    return h ? `fill a form and upload PC files on ${h}` : null;
  },
  promptHint: 'To fill a job application form, use apply_assist (fills from cv_data.json, attaches the CV). Never click Submit/Apply on an application: the user submits it.',
  run,
};
