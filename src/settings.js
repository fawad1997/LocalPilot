// Shared settings, stored in chrome.storage.local.

export const PRESETS = {
  freellmapi: { provider: 'openai', baseUrl: 'http://127.0.0.1:31415/v1', model: 'auto' },
  ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5vl:7b' },
  lmstudio: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: '' },
  llamacpp: { provider: 'openai', baseUrl: 'http://localhost:8080/v1', model: '' },
  vllm: { provider: 'openai', baseUrl: 'http://localhost:8000/v1', model: '' },
  anthropic_compatible: { provider: 'anthropic', baseUrl: 'http://localhost:4000', model: '' },
};

// How the agent asks before acting:
//   ask_site   - ask once per site (Allow once / Always allow / Deny)
//   ask_action - ask before every action that changes something
//   plan       - first show a step plan to approve or edit, then act (asking once per site)
//   auto       - act without asking (bypass permissions)
export const PERMISSION_MODES = {
  ask_site: 'Ask once per site',
  ask_action: 'Ask before every action',
  plan: 'Plan, then act',
  auto: 'Act without asking',
};

export const DEFAULTS = {
  provider: 'openai', // 'openai' (chat/completions) | 'anthropic' (messages)
  baseUrl: 'http://localhost:11434/v1', // overridden by src/local-defaults.json
  model: 'qwen2.5vl:7b',
  apiKey: '', // never commit keys: put personal defaults in src/local-defaults.json (gitignored)
  maxSteps: 30,
  maxRetries: 4, // per model call, for 5xx/429/timeouts/network errors
  requestTimeoutSec: 180,
  fallbackModels: '', // comma-separated, tried in order after the main model keeps failing
  logging: true, // JSONL diagnostics in <extension>/logs (via the PC bridge)
  pauseOnBotCheck: true, // hand CAPTCHA / bot checks to the user
  maxTokens: 4096,
  streaming: true, // stream replies (SSE) from OpenAI-style servers; falls back automatically
  summarizeAfterTokens: 24000, // summarize older turns when the prompt grows past this (0 = never)
  temperature: 0.2,
  sendScreenshots: true, // turn off for text-only models
  screenshotMarks: true, // numbered Set-of-Marks badges on screenshots
  screenshotMaxWidth: 1280,
  allowJavascriptTool: false,
  permissionMode: 'ask_site',
  // MCP bridge: lets Claude Code (or another MCP client) drive the browser through
  // host/mcp-server.mjs. The client's own tool-permission prompts gate each call.
  mcpBridge: true,
  mcpPermissionMode: 'auto',
  approvedDomains: [],
  extraSystemPrompt: '',
  // Quantara (D:\AI\Trading): read the local trading bot's dashboard. quantaraToken (its
  // DASHBOARD_TOKEN) only enables quantara_halt, which asks every time.
  quantaraEnabled: false,
  quantaraUrl: 'http://127.0.0.1:8787',
  quantaraToken: '',
  newsFeeds: '', // RSS/Atom URLs for news_collect, one per line (empty = the built-in list)
  recordRuns: false, // save every run as an animated GIF in Downloads/LocalPilot
};

// Optional machine-local defaults (e.g. your API key), kept out of version control.
let localDefaults;
async function getLocalDefaults() {
  if (localDefaults !== undefined) return localDefaults;
  try {
    const res = await fetch(chrome.runtime.getURL('src/local-defaults.json'));
    localDefaults = res.ok ? await res.json() : {};
  } catch {
    localDefaults = {};
  }
  return localDefaults;
}

export async function loadSettings() {
  const local = await getLocalDefaults();
  const stored = (await chrome.storage.local.get('settings')).settings || {};
  // Migrate the old boolean setting.
  if (!stored.permissionMode && stored.askBeforeActing === false) stored.permissionMode = 'auto';
  delete stored.askBeforeActing;
  return { ...DEFAULTS, ...local, ...stored };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
