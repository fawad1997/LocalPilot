import { loadSettings, saveSettings, PRESETS } from '../settings.js';
import { createProvider } from '../providers.js';
import { quantaraBaseUrl } from '../quantara.js';
import { allNotes, removeNote } from '../sitenotes.js';

const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ['provider', 'baseUrl', 'model', 'apiKey', 'extraSystemPrompt', 'permissionMode', 'fallbackModels', 'quantaraUrl', 'quantaraToken', 'newsFeeds', 'searchEngine', 'searchUrl', 'actionMode', 'helperModel'];
const NUMBER_FIELDS = ['maxSteps', 'maxTokens', 'temperature', 'screenshotMaxWidth', 'maxRetries', 'requestTimeoutSec', 'summarizeAfterTokens'];
const BOOL_FIELDS = ['judgeRuns', 'sendPageState', 'sendScreenshots', 'screenshotMarks', 'allowJavascriptTool', 'mcpBridge', 'logging', 'pauseOnBotCheck', 'captchaSolver', 'streaming', 'quantaraEnabled', 'recordRuns'];

let domains = [];

// Saved values: one per line, "name = value" or "name = value | site.com, other.org".
export function parseSavedValues(textValue) {
  return String(textValue || '').split('\n').map((line) => line.match(/^\s*(\w+)\s*=\s*(.*?)\s*(?:\|\s*(.*))?$/)).filter((m) => m && m[2])
    .map((m) => ({ name: m[1], value: m[2], sites: (m[3] || '').trim() }));
}

function formatSavedValues(values) {
  return (values || []).map((v) => `${v.name} = ${v.value}${v.sites ? ` | ${v.sites}` : ''}`).join('\n');
}

function fill(settings) {
  for (const k of TEXT_FIELDS) $(k).value = settings[k] ?? '';
  $('savedValues').value = formatSavedValues(settings.savedValues);
  for (const k of NUMBER_FIELDS) $(k).value = settings[k];
  for (const k of BOOL_FIELDS) $(k).checked = !!settings[k];
  domains = [...settings.approvedDomains];
  renderDomains();
}

function read() {
  const out = { approvedDomains: domains, savedValues: parseSavedValues($('savedValues').value) };
  for (const k of TEXT_FIELDS) out[k] = $(k).value.trim();
  for (const k of NUMBER_FIELDS) out[k] = Number($(k).value);
  for (const k of BOOL_FIELDS) out[k] = $(k).checked;
  return out;
}

function renderDomains() {
  const ul = $('domains');
  ul.textContent = '';
  if (!domains.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'None yet. Choose "Always allow" in the side panel to add one.';
    ul.appendChild(li);
    return;
  }
  for (const d of domains) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Remove';
    btn.addEventListener('click', () => {
      domains = domains.filter((x) => x !== d);
      renderDomains();
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

// Learned by cdp.js when a site reloads itself under console capture.
async function renderQuietHosts() {
  const ul = $('quiet-hosts');
  ul.textContent = '';
  const hosts = (await chrome.storage.local.get('quietHosts')).quietHosts || [];
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'None yet.';
    ul.appendChild(li);
    return;
  }
  for (const host of [...hosts].sort()) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = host;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Forget';
    btn.addEventListener('click', async () => {
      const now = (await chrome.storage.local.get('quietHosts')).quietHosts || [];
      await chrome.storage.local.set({ quietHosts: now.filter((h) => h !== host) });
      renderQuietHosts();
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

async function renderNotes() {
  const ul = $('site-notes');
  ul.textContent = '';
  const notes = await allNotes();
  const sites = Object.keys(notes).sort();
  if (!sites.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'None yet. The agent adds them with site_note.';
    ul.appendChild(li);
    return;
  }
  for (const site of sites) {
    notes[site].forEach((note, i) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${site}: ${note.text}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        await removeNote(site, i + 1);
        renderNotes();
      });
      li.append(span, btn);
      ul.appendChild(li);
    });
  }
}

$('preset').addEventListener('change', () => {
  const p = PRESETS[$('preset').value];
  if (!p) return;
  $('provider').value = p.provider;
  $('baseUrl').value = p.baseUrl;
  if (p.model) $('model').value = p.model;
});

$('toggle-key').addEventListener('click', () => {
  const show = $('apiKey').type === 'password';
  $('apiKey').type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? 'Hide' : 'Show';
});

$('test').addEventListener('click', async () => {
  const out = $('test-result');
  out.className = 'hint';
  out.textContent = 'Connecting…';
  try {
    const models = await createProvider({ ...(await loadSettings()), ...read() }).listModels();
    const list = $('models');
    list.textContent = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
    out.className = 'hint ok';
    out.textContent = models.length ? `Connected. ${models.length} model(s): ${models.slice(0, 8).join(', ')}${models.length > 8 ? '…' : ''}` : 'Connected, but the server listed no models.';
  } catch (err) {
    out.className = 'hint bad';
    let msg = `Failed: ${err.message}`;
    if (/11434/.test($('baseUrl').value)) msg += '\nOllama: set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.';
    out.textContent = msg;
  }
});

$('quantara-test').addEventListener('click', async () => {
  const out = $('quantara-result');
  out.className = 'hint';
  out.textContent = 'Connecting…';
  try {
    const base = quantaraBaseUrl({ quantaraUrl: $('quantaraUrl').value.trim() });
    const res = await fetch(`${base}/api/state`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    out.className = 'hint ok';
    out.textContent = `Connected. Quantara is ${state.system_status || state.startup_state || 'running'} (${state.environment || 'unknown mode'}).`;
  } catch (err) {
    out.className = 'hint bad';
    out.textContent = `Failed: ${err.message}. Is the bot running (scripts\\7_run_bot.bat)?`;
  }
});

$('save').addEventListener('click', async () => {
  const values = read();
  try {
    if (values.quantaraUrl) quantaraBaseUrl(values);
  } catch (err) {
    $('saved').textContent = err.message;
    return;
  }
  await saveSettings(values);
  $('saved').textContent = 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});

fill(await loadSettings());
renderNotes();
renderQuietHosts();
