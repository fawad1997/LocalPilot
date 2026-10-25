import { loadSettings, saveSettings } from '../settings.js';
import { createProvider } from '../providers.js';

const log = document.getElementById('log');
const empty = document.getElementById('empty');
const statusEl = document.getElementById('status');
const form = document.getElementById('composer');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const modelLabel = document.getElementById('model-label');
const connDot = document.getElementById('conn-dot');

const SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

let port;
let running = false;
const toolCards = new Map();
let savedTasks = [];
let liveReply = null; // streaming assistant bubble

// ---------------------------------------------------------------------------
// Rendering

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Small, safe markdown subset: code fences, inline code, bold, italics, links, lists.
function renderMarkdown(src) {
  const parts = src.split(/```(?:[\w-]*)\n?([\s\S]*?)```/g);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      html += `<pre><code>${escapeHtml(part)}</code></pre>`;
      return;
    }
    const paragraphs = part.trim().split(/\n{2,}/).filter(Boolean);
    for (const p of paragraphs) {
      let inner = escapeHtml(p)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      if (/^\s*([-*]|\d+\.)\s/.test(p)) {
        const items = inner.split(/\n/).map((l) => l.replace(/^\s*([-*]|\d+\.)\s+/, ''));
        const tag = /^\s*\d+\./.test(p) ? 'ol' : 'ul';
        html += `<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`;
      } else {
        html += `<p>${inner.replace(/\n/g, '<br>')}</p>`;
      }
    }
  });
  return html;
}

function scrollToBottom() {
  log.scrollTop = log.scrollHeight;
}

function add(el) {
  empty.hidden = true;
  log.appendChild(el);
  scrollToBottom();
  return el;
}

function addUser(text, files = []) {
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  if (files.length) {
    const list = document.createElement('div');
    list.className = 'msg-files';
    list.textContent = files.map((n) => `📎 ${n}`).join('  ');
    el.appendChild(list);
  }
  return add(el);
}

const ATTACH_NOTE = '[Files the user attached in the chat.';
// File names from the attachment note the agent adds to a user message.
function attachedNames(text) {
  return [...text.matchAll(/^- (.+) \([^()]*, \d+ KB\)$/gm)].map((m) => m[1]);
}

function endLiveReply() {
  liveReply?.remove();
  liveReply = null;
}

// Streamed text shows as plain text until the final reply replaces it.
function appendDelta(text) {
  if (!liveReply) {
    liveReply = document.createElement('div');
    liveReply.className = 'msg assistant streaming';
    liveReply.dataset.raw = '';
    add(liveReply);
  }
  liveReply.dataset.raw += text;
  liveReply.textContent = liveReply.dataset.raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/<tool_call>[\s\S]*$/, '').trimStart();
  scrollToBottom();
}

function addAssistant(text) {
  endLiveReply();
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = renderMarkdown(text);
  return add(el);
}

// The approved plan as a checklist the agent ticks off (plan_update); one card, updated in place.
function renderPlan(items) {
  let card = log.querySelector('.plan-card:last-of-type');
  if (!card || card.dataset.done === '1') {
    card = document.createElement('div');
    card.className = 'msg plan-card';
    add(card);
  }
  card.textContent = '';
  const head = document.createElement('strong');
  head.textContent = `Plan ${items.filter((i) => i.done).length}/${items.length}`;
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = `${it.done ? '☑' : '☐'} ${it.n}. ${it.text}`;
    li.className = it.done ? 'done' : '';
    ul.append(li);
  }
  card.append(head, ul);
  card.dataset.done = items.every((i) => i.done) ? '1' : '0';
}

function addNote(text, cls = 'note') {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  return add(el);
}

function addRetry() {
  const wrap = document.createElement('div');
  wrap.className = 'msg retry';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Retry';
  btn.addEventListener('click', () => {
    if (running) return;
    wrap.remove();
    setRunning(true);
    port.postMessage({ type: 'retry' });
  });
  wrap.append(btn, ' the last step. Your conversation is kept.');
  add(wrap);
  btn.focus();
}

function describeInput(name, input = {}) {
  if (name === 'computer') {
    const target = input.ref || (input.coordinate ? `(${input.coordinate.join(', ')})` : '');
    const extra = input.text ? ` "${input.text}"` : input.scroll_direction ? ` ${input.scroll_direction}` : '';
    return `${input.action}${target ? ` ${target}` : ''}${extra}`;
  }
  if (name === 'navigate') return input.url;
  if (name === 'find') return `"${input.query}"`;
  if (name === 'form_input') return `${input.ref} = "${input.value}"`;
  if (name === 'read_page') return input.filter || 'all';
  if (name === 'javascript_tool') return (input.code || '').slice(0, 60);
  const json = JSON.stringify(input);
  return json === '{}' ? '' : json;
}

function addToolCard(id, name, input) {
  const d = document.createElement('details');
  d.className = 'tool';
  d.innerHTML = `<summary><span class="name"></span><span class="arg"></span><span class="state">…</span></summary><div class="body"><pre class="input"></pre></div>`;
  d.querySelector('.name').textContent = name;
  d.querySelector('.arg').textContent = describeInput(name, input);
  d.querySelector('.input').textContent = JSON.stringify(input, null, 2);
  toolCards.set(id, d);
  return add(d);
}

function finishToolCard(id, ok, content) {
  const d = toolCards.get(id);
  if (!d) return;
  const state = d.querySelector('.state');
  state.textContent = ok ? '✓' : '✕';
  state.className = `state ${ok ? 'ok' : 'fail'}`;
  const body = d.querySelector('.body');
  for (const block of content || []) {
    if (block.type === 'image') {
      const img = document.createElement('img');
      img.alt = 'Screenshot';
      img.src = `data:${block.mediaType};base64,${block.data}`;
      body.appendChild(img);
    } else if (block.text) {
      const pre = document.createElement('pre');
      pre.textContent = block.text;
      body.appendChild(pre);
    }
  }
  if (!ok) d.open = true;
}

function addPlanApproval({ id, plan }) {
  const node = document.createElement('div');
  node.className = 'approval plan';
  node.dataset.id = id;
  node.innerHTML = `<div class="approval-text"><strong>Plan</strong> — approve it, edit it, or cancel. Nothing has been done yet.</div>
    <pre class="plan-text"></pre><textarea hidden aria-label="Edit the plan"></textarea>
    <div class="approval-actions"><button type="button" class="primary" data-act="approve">Approve</button><button type="button" data-act="edit">Edit</button><button type="button" class="danger" data-act="deny">Cancel</button></div>`;
  node.querySelector('.plan-text').textContent = plan;
  const area = node.querySelector('textarea');
  area.value = plan;
  const resolve = (decision, text) => {
    port.postMessage({ type: 'approval', id, decision, text });
    node.classList.add('resolved');
    node.querySelectorAll('button').forEach((b) => (b.disabled = true));
    node.querySelector('.approval-text').append(` → ${decision === 'deny' ? 'cancelled' : decision === 'edit' ? 'approved with edits' : 'approved'}`);
  };
  node.querySelector('[data-act="approve"]').addEventListener('click', () => {
    if (!area.hidden && area.value.trim() !== plan.trim()) resolve('edit', area.value);
    else resolve('approve');
  });
  node.querySelector('[data-act="edit"]').addEventListener('click', (ev) => {
    area.hidden = false;
    node.querySelector('.plan-text').hidden = true;
    ev.target.hidden = true;
    node.querySelector('[data-act="approve"]').textContent = 'Approve edited plan';
    area.focus();
  });
  node.querySelector('[data-act="deny"]').addEventListener('click', () => resolve('deny'));
  add(node);
  node.querySelector('.primary').focus();
}

// apply_assist filled a form: the user submits it in the tab, then tells us here.
function addApplyReview(e) {
  if (log.querySelector(`.approval.apply[data-id="${e.id}"]`)) return;
  const node = document.createElement('div');
  node.className = 'approval apply';
  node.dataset.id = e.id;
  node.innerHTML = `<div class="approval-text"><strong></strong></div>
    <p class="apply-warn">LocalPilot did not submit. Review the form in the tab and press Submit yourself.</p>
    <details><summary></summary><ul class="filled"></ul></details>
    <p class="skipped"></p><p class="upload"></p>
    <div class="approval-actions"><button type="button" class="primary" data-act="yes">I submitted it — log it</button><button type="button" data-act="no">Not submitted</button></div>`;
  node.querySelector('strong').textContent = `Application ready: ${e.role} at ${e.company} (${e.host})`;
  node.querySelector('summary').textContent = `${e.filled.length} field(s) filled`;
  for (const f of e.filled) {
    const li = document.createElement('li');
    li.textContent = `${f.label}: ${f.value}`;
    node.querySelector('.filled').appendChild(li);
  }
  node.querySelector('.skipped').textContent = e.skipped.length ? `Left for you: ${e.skipped.map((x) => x.label).join(', ')}` : '';
  node.querySelector('.upload').textContent = e.upload || '';
  node.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    node.querySelectorAll('button').forEach((x) => (x.disabled = true));
    port.postMessage({ type: 'apply_confirm', id: e.id, submitted: b.dataset.act === 'yes' });
  }));
  add(node);
}

function addApproval({ id, mode, host, tool, input, kind, plan, onceOnly }) {
  if (mode === 'plan') {
    addPlanApproval({ id, plan });
    return;
  }
  const node = document.getElementById('approval-tpl').content.firstElementChild.cloneNode(true);
  node.dataset.id = id;
  if (mode === 'ask_action') {
    const [once, always] = node.querySelectorAll('button');
    once.textContent = 'Allow';
    always.textContent = 'Allow rest of task';
    always.dataset.decision = 'task';
  }
  if (mode === 'verification') {
    const [cont, , stop] = node.querySelectorAll('button');
    cont.textContent = "I've solved it, continue";
    cont.dataset.decision = 'continue';
    node.querySelectorAll('button')[1].remove();
    stop.textContent = 'Stop';
    node.classList.add('verification');
    node.querySelector('.approval-text').innerHTML = 'LocalPilot paused: <strong></strong> showed a verification (<span></span>).<br><small>Complete it yourself in the tab. LocalPilot never solves CAPTCHAs.</small>';
    node.querySelector('strong').textContent = host;
    node.querySelector('span').textContent = String(kind || 'bot check').replace(/-/g, ' ');
  } else if (onceOnly) {
    // Asked every time (e.g. Quantara's emergency stop): no "Always allow".
    node.querySelectorAll('button')[1].remove();
    node.querySelector('.approval-text').innerHTML = `Allow LocalPilot to do this now: <strong></strong>?<br><small></small>`;
    node.querySelector('strong').textContent = host;
    node.querySelector('small').textContent = `${tool}: ${describeInput(tool, input)}`;
  } else {
    node.querySelector('.approval-text').innerHTML = `Allow LocalPilot to act on <strong></strong>?<br><small></small>`;
    node.querySelector('strong').textContent = host;
    node.querySelector('small').textContent = `${tool}: ${describeInput(tool, input)}`;
  }
  node.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      port.postMessage({ type: 'approval', id, decision: btn.dataset.decision });
      node.classList.add('resolved');
      node.querySelector('.approval-text').append(` → ${btn.textContent}`);
    });
  });
  add(node);
  node.querySelector('.primary').focus();
}

function renderHistory(messages) {
  log.querySelectorAll('.msg, details.tool, .approval').forEach((n) => n.remove());
  toolCards.clear();
  empty.hidden = messages.length > 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (m.role === 'user' && b.type === 'text' && b.text.startsWith(ATTACH_NOTE)) {
        const users = log.querySelectorAll('.msg.user');
        const names = attachedNames(b.text);
        if (users.length && names.length) {
          const list = document.createElement('div');
          list.className = 'msg-files';
          list.textContent = names.map((n) => `📎 ${n}`).join('  ');
          users[users.length - 1].appendChild(list);
        }
      } else if (m.role === 'user' && b.type === 'text') addUser(b.text);
      else if (m.role === 'assistant' && b.type === 'text' && b.text.trim()) addAssistant(b.text);
      else if (b.type === 'tool_use') addToolCard(b.id, b.name, b.input);
      else if (b.type === 'tool_result') finishToolCard(b.toolUseId, !b.isError, b.content);
    }
  }
}

function setRunning(value) {
  running = value;
  sendBtn.innerHTML = value ? STOP_ICON : SEND_ICON;
  sendBtn.classList.toggle('stop', value);
  sendBtn.setAttribute('aria-label', value ? 'Stop' : 'Send');
  statusEl.hidden = !value;
  if (value) statusEl.textContent = 'Working…';
}

// ---------------------------------------------------------------------------
// Port to the service worker

// This panel instance belongs to one tab (?tabId= set by the service worker).
let panelTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function resolvePanelTab() {
  if (!panelTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    panelTabId = tab?.id ?? null;
  }
  return panelTabId;
}

async function refreshTabLabel() {
  const tab = await chrome.tabs.get(panelTabId).catch(() => null);
  document.getElementById('tab-label').textContent = tab ? `This tab: ${tab.title || tab.url}` : '';
}

async function connect() {
  const tabId = await resolvePanelTab();
  port = chrome.runtime.connect({ name: `sidepanel:${tabId}` });
  port.onMessage.addListener(onEvent);
  port.postMessage({ type: 'tasks_list' });
  port.onDisconnect.addListener(() => {
    setRunning(false);
    setTimeout(connect, 500);
  });
}

function onEvent(e) {
  switch (e.type) {
    case 'history':
      renderHistory(e.messages);
      setRunning(e.running);
      break;
    case 'status':
      statusEl.textContent = e.text;
      break;
    case 'assistant_delta':
      if (e.reset) endLiveReply();
      else appendDelta(e.text);
      break;
    case 'apply_review':
      addApplyReview(e);
      break;
    case 'apply_resolved': {
      const card = log.querySelector(`.approval.apply[data-id="${e.id}"]`);
      if (card) {
        card.classList.add('resolved');
        card.querySelectorAll('button').forEach((b) => (b.disabled = !e.ok ? false : true));
      }
      addNote(e.text, e.ok ? 'notice' : 'error');
      break;
    }
    case 'tasks':
      savedTasks = e.tasks;
      renderTasks();
      if (!helpSection.hidden) renderHelpCommands();
      break;
    case 'task_error':
      taskError.hidden = false;
      taskError.textContent = e.text;
      break;
    case 'assistant':
      addAssistant(e.text);
      break;
    case 'tool_start':
      endLiveReply();
      addToolCard(e.id, e.name, e.input);
      statusEl.textContent = `Running ${e.name}…`;
      break;
    case 'tool_result':
      finishToolCard(e.id, e.ok, e.content);
      break;
    case 'approval':
      if (!log.querySelector(`.approval[data-id="${e.id}"]`)) addApproval(e);
      statusEl.textContent = 'Waiting for your approval…';
      break;
    case 'approval_resolved': {
      const card = log.querySelector(`.approval[data-id="${e.id}"]`);
      if (card && !card.classList.contains('resolved')) {
        card.classList.add('resolved');
        card.querySelector('.approval-text').append(` → ${e.decision}`);
      }
      break;
    }
    case 'error':
      addNote(e.text, 'error');
      break;
    case 'notice':
      addNote(e.text, 'notice');
      break;
    case 'plan_progress':
      renderPlan(e.items);
      break;
    case 'judge':
      // The check after a task: did it really do what was asked?
      addNote(`${e.verdict === 'success' ? '✓ Checked: done' : `⚠ Checked: ${e.verdict === 'partial' ? 'only partly done' : 'not done'}`}. ${e.reason}${e.blockedBy && e.blockedBy !== 'none' ? ` (blocked by: ${e.blockedBy})` : ''}`, e.verdict === 'success' ? 'judge-ok' : 'judge-bad');
      break;
    case 'done':
      endLiveReply();
      if (e.reason === 'stopped') addNote('Stopped.');
      if (e.text) addNote(e.text);
      if (e.canRetry) addRetry();
      setRunning(false);
      break;
    default:
  }
}

setInterval(() => {
  try {
    port?.postMessage({ type: 'ping' });
  } catch {
    // reconnect handles it
  }
}, 20000);

// ---------------------------------------------------------------------------
// Composer

// Built-in commands; saved tasks are listed after them in the "/" menu.
const BUILTIN_COMMANDS = [
  { name: 'help', hint: 'Setup, commands and examples', run: () => showSection('help') },
  { name: 'tasks', hint: 'Saved tasks and daily schedules', run: () => showSection('tasks') },
  { name: 'attach', hint: 'Attach files to your next message', run: () => attachInput.click() },
  { name: 'new', hint: 'Start a new chat', run: () => port.postMessage({ type: 'reset' }) },
  {
    name: 'test',
    hint: 'Test this website for bugs (report + GIF)',
    run: (extra) => submit(`Test this website for bugs with test_website${extra ? ` (${extra})` : ''}. Then explain the most important problems in plain words, and how to fix them.`),
  },
  {
    name: 'record',
    hint: 'Do a task and record it as a GIF: /record <task>',
    run: (extra) => (extra
      ? submit(`Start gif_recorder with the title "${extra.replace(/"/g, "'").slice(0, 80)}". Then do this task: ${extra}
When you are done, export the GIF with gif_recorder and tell me where it was saved.`)
      : addNote('Type what to record after /record, for example: /record search this site for pricing', 'error')),
  },
];

function clearComposer() {
  promptEl.value = '';
  autosize();
  hideSlashMenu();
}

function submit(text) {
  const prompt = text.trim();
  if (running) return;
  if (!prompt && !pendingFiles.length) return;
  // "/name extra words" runs a built-in command or a saved task.
  const slash = prompt.match(/^\/([\p{L}\p{N}_-]+)(?:\s+([\s\S]*))?$/u);
  const builtin = slash && BUILTIN_COMMANDS.find((c) => c.name === slash[1].toLowerCase());
  if (builtin) {
    clearComposer();
    builtin.run((slash[2] || '').trim());
    return;
  }
  const files = pendingFiles.splice(0);
  renderAttachments();
  const names = files.map((f) => f.name);
  if (slash) {
    const task = savedTasks.find((t) => t.name.toLowerCase() === slash[1].toLowerCase());
    if (!task) {
      pendingFiles.push(...files);
      renderAttachments();
      addNote(`No command or saved task "/${slash[1]}". Type / to see the list, or open Saved tasks to create one.`, 'error');
      return;
    }
    addUser(`/${task.name}${slash[2] ? ` ${slash[2]}` : ''}\n${task.prompt}`, names);
    setRunning(true);
    port.postMessage({ type: 'run_saved', id: task.id, extra: slash[2] || '', attachments: files });
  } else {
    const p = prompt || 'I attached these files.';
    addUser(p, names);
    setRunning(true);
    port.postMessage({ type: 'run', prompt: p, attachments: files });
  }
  clearComposer();
}

// ---------------------------------------------------------------------------
// Attachments (paperclip, drag and drop, paste)

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const attachInput = document.getElementById('attach-input');
const attachList = document.getElementById('attach-list');
const pendingFiles = []; // { name, type, size, data (base64) }

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (file.size > MAX_FILE_BYTES) {
      addNote(`"${file.name}" is larger than 15 MB and was not attached.`, 'error');
      continue;
    }
    pendingFiles.push({ name: file.name, type: file.type, size: file.size, data: await readAsBase64(file) });
  }
  renderAttachments();
  promptEl.focus();
}

function renderAttachments() {
  attachList.textContent = '';
  attachList.hidden = !pendingFiles.length;
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'file-chip';
    chip.textContent = `📎 ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = `Remove ${f.name}`;
    x.setAttribute('aria-label', `Remove ${f.name}`);
    x.addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    attachList.appendChild(chip);
  });
}

document.getElementById('attach').addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  addFiles([...attachInput.files]);
  attachInput.value = '';
});
document.body.addEventListener('dragover', (ev) => {
  if ([...(ev.dataTransfer?.types || [])].includes('Files')) {
    ev.preventDefault();
    document.body.classList.add('dropping');
  }
});
document.body.addEventListener('dragleave', (ev) => {
  if (!ev.relatedTarget) document.body.classList.remove('dropping');
});
document.body.addEventListener('drop', (ev) => {
  document.body.classList.remove('dropping');
  if (!ev.dataTransfer?.files?.length) return;
  ev.preventDefault();
  addFiles([...ev.dataTransfer.files]);
});
promptEl.addEventListener('paste', (ev) => {
  const files = [...(ev.clipboardData?.files || [])];
  if (!files.length) return;
  ev.preventDefault();
  addFiles(files);
});

// ---------------------------------------------------------------------------
// "/" menu: built-in commands and saved tasks

const slashMenu = document.getElementById('slash-menu');
let slashItems = [];
let slashIndex = 0;

function hideSlashMenu() {
  slashMenu.hidden = true;
  slashItems = [];
}

function commandItems(filter = '') {
  const f = filter.toLowerCase();
  return [
    ...BUILTIN_COMMANDS.map((c) => ({ name: c.name, hint: c.hint, kind: 'command' })),
    ...savedTasks.map((t) => ({ name: t.name, hint: t.prompt, kind: t.when || t.daily ? `task · ${t.when || `daily ${t.daily}`}` : 'task' })),
  ].filter((c) => c.name.toLowerCase().startsWith(f));
}

function updateSlashMenu() {
  const m = promptEl.value.match(/^\/([\p{L}\p{N}_-]*)$/u);
  if (!m) return hideSlashMenu();
  slashItems = commandItems(m[1]);
  if (!slashItems.length) return hideSlashMenu();
  slashIndex = Math.min(slashIndex, slashItems.length - 1);
  slashMenu.textContent = '';
  slashItems.forEach((c, i) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.id = `slash-${i}`;
    li.setAttribute('aria-selected', String(i === slashIndex));
    li.innerHTML = '<span class="slash-name"></span><span class="slash-kind"></span><span class="slash-hint"></span>';
    li.querySelector('.slash-name').textContent = `/${c.name}`;
    li.querySelector('.slash-kind').textContent = c.kind;
    li.querySelector('.slash-hint').textContent = c.hint;
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      pickSlash(i);
    });
    slashMenu.appendChild(li);
  });
  slashMenu.hidden = false;
  promptEl.setAttribute('aria-activedescendant', `slash-${slashIndex}`);
}

function pickSlash(i) {
  const c = slashItems[i];
  if (!c) return;
  if (c.kind === 'command') submit(`/${c.name}`);
  else {
    // Saved task: fill it in so extra words can be added, Enter runs it.
    promptEl.value = `/${c.name} `;
    hideSlashMenu();
    promptEl.focus();
  }
}

// ---------------------------------------------------------------------------
// Saved tasks

const taskList = document.getElementById('task-list');
const taskForm = document.getElementById('task-form');
const taskError = document.getElementById('task-error');

function renderTasks() {
  taskList.textContent = '';
  if (!savedTasks.length) {
    const li = document.createElement('li');
    li.className = 'task-meta';
    li.textContent = 'No saved tasks yet.';
    taskList.appendChild(li);
  }
  for (const t of savedTasks) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="task-name"></span><span class="task-when"></span><button type="button" data-act="run">Run</button><button type="button" data-act="edit">Edit</button><button type="button" data-act="del">Delete</button><span class="task-meta"></span><span class="task-meta task-steps"></span><span class="task-meta task-last"></span>';
    li.querySelector('.task-name').textContent = `/${t.name}`;
    li.querySelector('.task-when').textContent = [t.when ?? (t.daily ? `daily ${t.daily}` : ''), t.watch ? 'page watch' : '', t.notifyOn === 'change' ? 'notify on change' : t.notifyOn === 'keyword' ? `notify on "${t.keyword}"` : ''].filter(Boolean).join(' · ');
    li.querySelector('.task-meta').textContent = `${t.url ? `${t.url} — ` : ''}${t.watch ? `watching ${t.watch.selector || 'the main content'}` : t.prompt}`;
    const stepsEl = li.querySelector('.task-steps');
    if (t.replaySteps && t.useReplay !== false) {
      stepsEl.textContent = `${t.replaySteps} saved steps: runs without the AI `;
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.textContent = 'Forget steps';
      forget.addEventListener('click', () => port.postMessage({ type: 'task_forget_steps', id: t.id }));
      stepsEl.append(forget);
    } else stepsEl.remove();
    const last = li.querySelector('.task-last');
    if (t.lastRun) {
      last.textContent = `Last run ${new Date(t.lastRun.at).toLocaleString()}: ${t.lastRun.ok ? 'OK' : 'needs attention'} — ${t.lastRun.text.slice(0, 160)}`;
      last.classList.toggle('fail', !t.lastRun.ok);
    } else last.remove();
    li.querySelector('[data-act="run"]').addEventListener('click', () => submit(`/${t.name}`));
    li.querySelector('[data-act="edit"]').addEventListener('click', () => {
      document.getElementById('task-name').value = t.name;
      document.getElementById('task-url').value = t.url;
      document.getElementById('task-prompt').value = t.prompt;
      const s = t.schedule || (t.daily ? { kind: 'daily', time: t.daily } : null);
      document.getElementById('task-schedule').value = s?.kind || 'off';
      if (s?.time) document.getElementById('task-daily').value = s.time.padStart(5, '0');
      if (s?.minutes) document.getElementById('task-interval').value = s.minutes;
      document.getElementById('task-notify').value = t.notifyOn || 'always';
      document.getElementById('task-keyword').value = t.keyword || '';
      document.getElementById('task-watch-on').checked = !!t.watch;
      document.getElementById('task-watch-selector').value = t.watch?.selector || '';
      document.getElementById('task-replay').checked = t.useReplay !== false;
      document.getElementById('task-sites').value = (t.allowedDomains || []).join(', ');
      syncTaskForm();
    });
    li.querySelector('[data-act="del"]').addEventListener('click', () => port.postMessage({ type: 'task_delete', id: t.id }));
    taskList.appendChild(li);
  }
}

document.getElementById('toggle-tasks').addEventListener('click', () => showSection('tasks'));

document.getElementById('task-use-tab').addEventListener('click', async () => {
  const tab = await chrome.tabs.get(panelTabId).catch(() => null);
  if (tab?.url) document.getElementById('task-url').value = tab.url;
});

// Shows only the inputs the chosen schedule / notify / watch options use.
function syncTaskForm() {
  const kind = document.getElementById('task-schedule').value;
  document.getElementById('task-daily').hidden = !['daily', 'weekdays'].includes(kind);
  document.getElementById('task-interval-wrap').hidden = kind !== 'interval';
  document.getElementById('task-keyword').hidden = document.getElementById('task-notify').value !== 'keyword';
  document.getElementById('task-watch-selector').hidden = !document.getElementById('task-watch-on').checked;
  document.getElementById('task-replay-wrap').hidden = document.getElementById('task-watch-on').checked; // a watch never uses the AI anyway
}
for (const id of ['task-schedule', 'task-notify', 'task-watch-on']) document.getElementById(id).addEventListener('change', syncTaskForm);
taskForm.addEventListener('reset', () => setTimeout(syncTaskForm));

taskForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  taskError.hidden = true;
  const val = (id) => document.getElementById(id).value.trim();
  const kind = val('task-schedule');
  const watching = document.getElementById('task-watch-on').checked;
  port.postMessage({
    type: 'task_save',
    task: {
      name: val('task-name'),
      url: val('task-url'),
      prompt: val('task-prompt'),
      schedule: kind === 'off' ? null : kind === 'interval' ? { kind, minutes: Number(val('task-interval')) } : { kind, time: val('task-daily') },
      notifyOn: val('task-notify'),
      keyword: val('task-keyword'),
      watch: watching ? { selector: val('task-watch-selector') } : null,
      useReplay: document.getElementById('task-replay').checked,
      allowedDomains: val('task-sites'),
    },
  });
  taskForm.reset();
});

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (running) port.postMessage({ type: 'stop' });
  else submit(promptEl.value);
});

promptEl.addEventListener('keydown', (ev) => {
  if (!slashMenu.hidden && slashItems.length) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      slashIndex = (slashIndex + (ev.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
      updateSlashMenu();
      return;
    }
    if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing)) {
      ev.preventDefault();
      // Enter on a fully typed name runs it; otherwise it completes the highlighted entry.
      const typed = promptEl.value.slice(1).toLowerCase();
      if (ev.key === 'Enter' && slashItems.some((c) => c.name.toLowerCase() === typed)) submit(promptEl.value);
      else pickSlash(slashIndex);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      hideSlashMenu();
      return;
    }
  }
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    if (!running) submit(promptEl.value);
  }
});

function autosize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 160)}px`;
}
promptEl.addEventListener('input', () => {
  autosize();
  slashIndex = 0;
  updateSlashMenu();
});
promptEl.addEventListener('blur', () => setTimeout(hideSlashMenu, 150));

document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => submit(chip.textContent)));
document.getElementById('new-chat').addEventListener('click', () => port.postMessage({ type: 'reset' }));
document.getElementById('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// Help: setup status, commands, examples

const helpSection = document.getElementById('help');
const EXAMPLES = [
  { group: 'Read', items: ['Summarize this page', 'List every price on this page as a table', 'What does this page say about refunds?'] },
  { group: 'Act', items: ['Find the contact link and open it', 'Fill this form with my name Jane Doe and email jane@example.com, but do not submit', 'Search this site for "pricing" and open the first result'] },
  { group: 'Several tabs', items: ['Read the open issues in this tab, open https://staging.example.com in a new tab, test each issue there, then come back and write what you found in a comment on each issue'] },
  { group: 'Files', items: ['Upload the attached file to the resume field', 'Read the attached CSV and fill one row of it into this form'] },
  { group: 'PC bridge', pc: true, items: ['Save this table as a CSV in the jobs folder', 'Find 全栈工程师 jobs on BOSS in Wuhan, 40 jobs, and save them', 'Collect 30 Python jobs on Liepin in Shenzhen', 'Get LinkedIn Full Stack Engineer jobs in Amsterdam', 'Fill this application for Full Stack Engineer at Acme with my tailored CV', 'Save every result on this page and the next 2 pages as a CSV in the jobs folder'] },
  { group: 'Trading (Quantara)', items: ['How is Quantara doing today?', 'Why is Quantara not trading more today?', 'Which trading sessions have worked so far for Quantara?'] },
  { group: 'Trading research', pc: true, items: ['Collect the USD high-impact economic calendar for 2025 for Quantara', 'Collect today\'s gold and USD news headlines for Quantara'] },
  { group: 'Memory', items: ['Remember for this site: the search URL is the one in the address bar now'] },
  { group: 'Testing', items: ['/test', 'Test this website for bugs, at most 5 pages, and record a GIF', '/record search this site for "pricing" and open the first result'] },
];

function renderHelpCommands() {
  const ul = document.getElementById('help-commands');
  ul.textContent = '';
  for (const c of commandItems()) {
    const li = document.createElement('li');
    li.innerHTML = '<button type="button" class="link"></button> <span class="hint"></span>';
    li.querySelector('button').textContent = `/${c.name}`;
    li.querySelector('.hint').textContent = c.kind === 'command' ? c.hint : `${c.kind}: ${c.hint.slice(0, 90)}`;
    li.querySelector('button').addEventListener('click', () => {
      promptEl.value = `/${c.name}${c.kind === 'command' ? '' : ' '}`;
      promptEl.focus();
      updateSlashMenu();
    });
    ul.appendChild(li);
  }
  const li = document.createElement('li');
  li.className = 'hint';
  li.textContent = savedTasks.length ? 'Saved tasks run with /name. Add more in Saved tasks.' : 'Save a prompt in Saved tasks (bookmark icon) to run it as /name or every day.';
  ul.appendChild(li);
}

function renderExamples(pcOn) {
  const box = document.getElementById('help-examples');
  box.textContent = '';
  for (const g of EXAMPLES) {
    const h = document.createElement('div');
    h.className = 'ex-group';
    h.textContent = g.pc && !pcOn ? `${g.group} (needs the PC bridge, see Setup)` : g.group;
    box.appendChild(h);
    for (const text of g.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip ex';
      b.textContent = text;
      b.addEventListener('click', () => {
        promptEl.value = text;
        autosize();
        promptEl.focus();
      });
      box.appendChild(b);
    }
  }
}

async function refreshHelp() {
  const host = await refreshPcBadge();
  const ok = connDot.classList.contains('ok');
  document.getElementById('help-model-dot').className = `dot ${ok ? 'ok' : 'bad'}`;
  document.getElementById('help-model').textContent = ok ? `Model server: connected (${modelLabel.textContent})` : `Model server: not reachable. ${setupHint.textContent || ''}`;
  document.getElementById('help-pc-dot').className = `dot ${host ? 'ok' : 'bad'}`;
  document.getElementById('help-pc').textContent = host ? `PC bridge: on. Folders: ${host.roots.map((r) => `${r.name} = ${r.path}`).join(', ')}` : 'PC bridge: off. Follow these steps to turn it on:';
  document.getElementById('pc-steps').hidden = !!host;
  const cmds = await chrome.commands?.getAll?.().catch(() => []) || [];
  const key = cmds.find((c) => c.name === 'toggle-side-panel')?.shortcut;
  document.getElementById('help-shortcut').textContent = key ? `Shortcut: ${key} opens this panel.` : 'Tip: set a keyboard shortcut for this panel at chrome://extensions/shortcuts.';
  renderHelpCommands();
  renderExamples(!!host);
}

function showSection(which) {
  for (const [id, btn] of [['help', 'toggle-help'], ['tasks', 'toggle-tasks']]) {
    const open = id === which ? document.getElementById(id).hidden : false;
    document.getElementById(id).hidden = !open;
    document.getElementById(btn).setAttribute('aria-expanded', String(open));
    if (open && id === 'help') refreshHelp();
    if (open && id === 'tasks') {
      port.postMessage({ type: 'tasks_list' });
      if (!document.getElementById('task-prompt').value && promptEl.value.trim() && !promptEl.value.startsWith('/')) document.getElementById('task-prompt').value = promptEl.value.trim();
    }
  }
}

document.getElementById('toggle-help').addEventListener('click', () => showSection('help'));
document.getElementById('empty-help').addEventListener('click', () => showSection('help'));
document.getElementById('pc-badge').addEventListener('click', () => {
  showSection(helpSection.hidden ? 'help' : null);
  document.getElementById('help-setup').open = true;
});
document.getElementById('pc-recheck').addEventListener('click', refreshHelp);
helpSection.addEventListener('click', (ev) => {
  const copy = ev.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(document.getElementById(copy.dataset.copy).textContent).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    }).catch(() => {});
  }
  const open = ev.target.closest('[data-open]');
  if (open?.dataset.open === 'settings') chrome.runtime.openOptionsPage();
  if (open?.dataset.open === 'extensions') chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
});

// ---------------------------------------------------------------------------
// Model status

const modeSelect = document.getElementById('mode-select');
const modelSelect = document.getElementById('model-select');

// models: ids, or { id, name, note } from listModelInfo. The server's name shows what a
// model really is (e.g. "claude-opus-4-5 · Opus slot (routed to gemini-flash)").
function setModelOptions(models, current) {
  const info = new Map(models.map((m) => (typeof m === 'string' ? [m, { id: m }] : [m.id, m])));
  const list = [...new Set([current, ...info.keys()].filter(Boolean))];
  modelSelect.textContent = '';
  for (const id of list) {
    const m = info.get(id) || { id };
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = [id, m.name, m.note && `(${m.note})`].filter(Boolean).join(' · ');
    opt.title = opt.textContent;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = current;
  modelSelect.title = modelSelect.selectedOptions[0]?.textContent || '';
}

function showMode(mode) {
  modeSelect.value = mode;
  modeSelect.closest('.picker').classList.toggle('danger', mode === 'auto');
}

async function refreshModel() {
  const settings = await loadSettings();
  modelLabel.textContent = `${settings.model || '(no model set)'} · ${settings.baseUrl}`;
  showMode(settings.permissionMode);
  setModelOptions([], settings.model);
  try {
    const models = await createProvider(settings).listModelInfo();
    setModelOptions(models, settings.model);
    connDot.className = 'dot ok';
    connDot.title = 'Model server reachable';
    setupHint.hidden = true;
  } catch (err) {
    connDot.className = 'dot bad';
    connDot.title = `Model server unreachable: ${err.message}`;
    setupHint.hidden = false;
    setupHint.textContent = /HTTP 40[13]/.test(err.message)
      ? 'The model server rejected the request. Set your API key in Settings (gear icon).'
      : `Can't reach the model server at ${settings.baseUrl}. Check it is running, or change the URL in Settings (gear icon).`;
  }
}
const setupHint = document.getElementById('setup-hint');

modeSelect.addEventListener('change', () => {
  showMode(modeSelect.value);
  saveSettings({ permissionMode: modeSelect.value });
});
modelSelect.addEventListener('change', () => saveSettings({ model: modelSelect.value }));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) refreshModel();
});

async function refreshPcBadge() {
  const badge = document.getElementById('pc-badge');
  const host = await chrome.runtime.sendMessage({ type: 'PC_STATUS' }).catch(() => null);
  badge.textContent = host ? 'PC: on' : 'PC: off';
  badge.classList.toggle('ok', !!host);
  badge.title = host
    ? `PC bridge connected. Roots: ${host.roots.map((r) => `${r.name} = ${r.path}`).join(', ')}`
    : 'PC bridge not set up. Click for the steps.';
  return host;
}

refreshModel();
refreshPcBadge();
connect().then(refreshTabLabel);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === panelTabId && (info.title || info.url)) refreshTabLabel();
});
promptEl.focus();
