// Quantara tools: read the local trading bot's own dashboard (D:\AI\Trading\quantara_v0.1,
// http://127.0.0.1:8787). Read-only, except quantara_halt (the bot's emergency stop: no new
// entries), which asks every time. Nothing here can resume trading, close positions or change
// settings; those stay on Quantara's own dashboard.
const text = (t) => ({ type: 'text', text: t });

export const QUANTARA_READ_TOOLS = ['quantara_status', 'quantara_trades', 'quantara_analysis', 'quantara_research'];
// Asked before every call, even in "Act without asking" mode or after "Allow rest of task".
export const ALWAYS_ASK_TOOLS = ['quantara_halt'];
export const QUANTARA_TOOLS = [...QUANTARA_READ_TOOLS, ...ALWAYS_ASK_TOOLS];

const ANALYSIS_KINDS = ['why_not_trading', 'sessions', 'blocked', 'losses', 'portfolio', 'scoreboard'];
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_CHARS = 6000;

// Quantara's dashboard binds to localhost only; so does this client.
export function quantaraBaseUrl(settings) {
  let url;
  try {
    url = new URL(String(settings.quantaraUrl || 'http://127.0.0.1:8787'));
  } catch {
    throw new Error(`Quantara URL "${settings.quantaraUrl}" is not a valid URL.`);
  }
  if (!/^https?:$/.test(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Quantara URL must be on this PC (http://127.0.0.1, localhost or [::1]).');
  }
  return url.origin;
}

export function quantaraToolDefinitions(settings) {
  if (!settings?.quantaraEnabled) return [];
  const defs = [
    {
      name: 'quantara_status',
      description:
        'Quantara trading bot (local, DEMO/DRY_RUN): is it running and allowed to trade, why not, today\'s P/L, open positions, risk state, emergency stop, stopped symbols, next news event. Read-only.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'quantara_trades',
      description: 'Quantara closed trades: today (default), or losing trades over the last `hours`. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          losses_only: { type: 'boolean', description: 'Only losing trades (uses `hours`, default 168).' },
          hours: { type: 'number' },
          limit: { type: 'number', description: 'Max rows (default 30).' },
        },
      },
    },
    {
      name: 'quantara_analysis',
      description:
        'Quantara analysis. kind: why_not_trading (how many chances were evaluated and the reasons they were skipped), sessions (results per trading session/hour), blocked (signals refused by risk/cost gates), losses, portfolio, scoreboard (per strategy). Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ANALYSIS_KINDS },
          hours: { type: 'number', description: 'Look-back window in hours (Quantara default 48; losses 168).' },
          symbol: { type: 'string', description: 'sessions only: one symbol, e.g. XAUUSDm' },
        },
        required: ['kind'],
      },
    },
    {
      name: 'quantara_research',
      description: 'Quantara research lab: the latest verdict per symbol and strategy, and whether it currently blocks live entries. Read-only.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
  if (settings.quantaraToken) {
    defs.push({
      name: 'quantara_halt',
      description:
        'Engage Quantara\'s emergency stop: no new entries; open positions keep their broker-side stop and target. Only when the user explicitly asks to halt or stop the bot. The user is asked to confirm every time. Resuming is done by the user on the Quantara dashboard.',
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Short reason, e.g. "user asked from LocalPilot"' } },
        required: ['reason'],
      },
    });
  }
  return defs;
}

export function quantaraPromptLines(settings) {
  if (!settings?.quantaraEnabled) return [];
  return [
    '',
    'Quantara (the user\'s local trading bot, DEMO/DRY_RUN) can be read with quantara_status, quantara_trades, quantara_analysis and quantara_research.',
    '- These tools only read. Quote numbers exactly as returned and use the plain-language labels they include.',
    '- Do not give trading or investment advice, predict prices, or recommend changing the bot\'s settings. Report what the bot did and why.',
    '- A group (session, strategy, symbol) with fewer than 30 trades is not evidence of anything: say there is not enough data yet.',
    ...(settings.quantaraToken ? ['- quantara_halt engages the emergency stop. Use it only when the user explicitly asks to halt or stop the bot; never on your own judgement.'] : []),
  ];
}

// ---------------------------------------------------------------------------
// Plain-language labels: Quantara's own dashboard glossary (app/dashboard/static/glossary.js).

const glossaries = new Map(); // base URL -> { CODE: say }

export function parseGlossary(source) {
  const out = {};
  const re = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*\{\s*say\s*:\s*"((?:[^"\\]|\\.)*)"/gm;
  for (const m of String(source || '').matchAll(re)) out[m[1]] = m[2].replace(/\\"/g, '"');
  return out;
}

export function humanise(code) {
  const s = String(code || '').replace(/_/g, ' ').toLowerCase().trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

async function glossaryFor(base) {
  if (glossaries.has(base)) return glossaries.get(base);
  let map = {};
  try {
    const res = await fetchWithTimeout(`${base}/static/glossary.js`, {}, 5000);
    if (res.ok) map = parseGlossary(await res.text());
  } catch {
    // labels are a nicety; codes are still returned
  }
  glossaries.set(base, map);
  return map;
}

function label(glossary, code) {
  if (code == null || code === '') return code;
  return glossary[code] || humanise(code);
}

// ---------------------------------------------------------------------------
// Trimming: the model gets a few KB of what matters, never the whole state.

const DROP_KEYS = new Set(['login', 'server', 'signal', 'regime_detail', 'health_details', 'microstructure', 'exit_model', 'extra', 'features', 'client_order_id', 'order_ticket', 'position_id', 'signal_id', 'id']);

export function compact(value, depth = 0, maxArray = 15) {
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((v) => compact(v, depth + 1, maxArray));
    if (value.length > maxArray) items.push(`… ${value.length - maxArray} more`);
    return items;
  }
  if (value && typeof value === 'object') {
    if (depth >= 5) return '{…}';
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k) || v == null) continue;
      out[k] = compact(v, depth + 1, maxArray);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) return Math.round(value * 10000) / 10000;
  return value;
}

function clip(json) {
  return json.length > MAX_CHARS ? `${json.slice(0, MAX_CHARS)}… (truncated)` : json;
}

export function summarizeState(state, glossary = {}) {
  const s = state || {};
  const a = s.account || {};
  const r = s.risk || {};
  const m = s.market || {};
  const trading = s.symbol_trading || {};
  const stopped = Object.entries(trading).filter(([, v]) => v && v.enabled === false).map(([sym, v]) => ({ symbol: sym, reason: v.reason || '', by: v.by || '' }));
  const components = s.components && typeof s.components === 'object' ? s.components : {};
  return compact({
    system_status: s.system_status,
    system_status_says: label(glossary, s.system_status),
    environment: s.environment,
    startup_state: s.startup_state,
    why: (s.status_reasons || []).slice(0, 5).map((x) => ({ code: x.code, says: label(glossary, x.code), message: x.message })),
    blockers: s.blockers,
    health: Array.isArray(components) ? components : Object.fromEntries(Object.entries(components).map(([k, v]) => [k, typeof v === 'object' ? v?.status ?? v : v])),
    emergency_stop: s.kill_switch ? { engaged: !!s.kill_switch.engaged, reason: s.kill_switch.reason, by: s.kill_switch.by, at: s.kill_switch.at } : undefined,
    risk: { state: r.state, says: label(glossary, r.state), size_multiplier: r.multiplier, daily_pnl: r.daily_pnl, daily_loss_remaining: r.daily_loss_remaining, drawdown: r.drawdown, reason: r.reason },
    account: { currency: a.currency, balance: a.balance, equity: a.equity, floating_pnl: a.floating_pnl, today_pnl: a.today_pnl, today_return: a.today_return, today_realized: a.today_realized, margin_level: a.margin_level },
    open_positions: (s.positions || []).map((p) => ({ symbol: p.symbol, side: p.side, volume: p.volume, entry: p.entry, current: p.current, stop: p.sl, target: p.tp, floating_pnl: p.floating_pnl, strategy: p.strategy, managed: p.managed })),
    symbols_running: Array.isArray(s.symbols) ? s.symbols.length - stopped.length : undefined,
    symbols_stopped: stopped,
    market: { symbol: s.symbol, session: m.session, spread_points: m.spread_points, spread_limit_points: m.spread_limit_points, event_state: m.event_state, next_event: m.next_event, regime: m.regime, research_block: m.research_block },
    waiting_signals: (s.pending_signals || []).length,
    server_time_utc: s.server_time_utc,
  });
}

export function summarizeCandidates(data, glossary = {}) {
  const groups = (data?.groups || []).slice(0, 15).map((g) => ({
    symbol: g.symbol, strategy: g.strategy_id, stage: g.stage, gate: g.gate,
    reason: g.reason, says: label(glossary, g.reason), count: g.count, outcomes: g.outcomes,
  }));
  return compact({ days: data?.days, chances_evaluated: data?.evaluations, top_reasons: groups });
}

// ---------------------------------------------------------------------------
// HTTP

async function fetchWithTimeout(url, init = {}, ms = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(base, path) {
  let res;
  try {
    res = await fetchWithTimeout(base + path);
  } catch {
    throw new Error(`Quantara dashboard not reachable at ${base}. Start it with scripts\\7_run_bot.bat (or scripts\\6_run_simulation.bat) in D:\\AI\\Trading\\quantara_v0.1.`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Quantara ${path} returned HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}.`);
  return body;
}

export async function runQuantaraTool(ctx, name, input = {}) {
  if (!QUANTARA_TOOLS.includes(name)) return null;
  if (!ctx.settings.quantaraEnabled) throw new Error('Quantara tools are off. Turn them on in Settings → Quantara.');
  const base = quantaraBaseUrl(ctx.settings);
  const glossary = await glossaryFor(base);
  switch (name) {
    case 'quantara_status': {
      const state = await getJson(base, '/api/state');
      return [text(`Quantara status (${base}):\n${clip(JSON.stringify(summarizeState(state, glossary)))}`)];
    }
    case 'quantara_trades': {
      const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200);
      if (input.losses_only) {
        const hours = Number(input.hours) || 168;
        const data = await getJson(base, `/api/analysis/losses?hours=${hours}&limit=${limit}`);
        return [text(`Quantara losing trades, last ${hours} h:\n${clip(JSON.stringify(compact(data, 0, limit)))}`)];
      }
      const rows = await getJson(base, '/api/trades/today');
      const trades = (rows || []).slice(0, limit).map((t) => ({
        closed_at: t.closed_at, symbol: t.symbol, direction: t.direction, strategy: t.strategy_id, volume: t.filled_volume ?? t.requested_volume,
        entry: t.entry_price, exit: t.exit_price, exit_reason: t.exit_reason, exit_says: label(glossary, t.exit_reason),
        net_pnl: t.net_pnl, r_multiple: t.r_multiple, peak_r: t.mfe_r, session: t.session,
      }));
      const total = (rows || []).reduce((sum, t) => sum + (Number(t.net_pnl) || 0), 0);
      return [text(`Quantara trades closed today (UTC): ${(rows || []).length}, net ${Math.round(total * 100) / 100}\n${clip(JSON.stringify(compact(trades, 0, limit)))}`)];
    }
    case 'quantara_analysis': {
      const kind = String(input.kind || '');
      if (!ANALYSIS_KINDS.includes(kind)) throw new Error(`kind must be one of ${ANALYSIS_KINDS.join(', ')}.`);
      if (kind === 'why_not_trading') {
        const days = Math.max(0.1, Math.min((Number(input.hours) || 24) / 24, 365));
        const data = await getJson(base, `/api/candidates/summary?days=${days}`);
        return [text(`Why Quantara is not trading more (last ${Math.round(days * 24)} h):\n${clip(JSON.stringify(summarizeCandidates(data, glossary)))}`)];
      }
      const params = new URLSearchParams();
      if (input.hours) params.set('hours', String(Number(input.hours)));
      if (input.symbol && kind === 'sessions') params.set('symbol', String(input.symbol));
      const qs = params.toString();
      const data = await getJson(base, `/api/analysis/${kind}${qs ? `?${qs}` : ''}`);
      return [text(`Quantara analysis "${kind}":\n${clip(JSON.stringify(compact(data, 0, 12)))}`)];
    }
    case 'quantara_research': {
      const data = await getJson(base, '/api/research/lab');
      const view = {
        created_at: data?.latest?.created_at,
        live_gate: data?.live_gate,
        gate_strategies: data?.gate_strategies,
        verdict_counts: data?.verdict_counts,
        per_strategy: data?.per_strategy,
      };
      return [text(`Quantara research lab:\n${clip(JSON.stringify(compact(view, 0, 12)))}`)];
    }
    case 'quantara_halt': {
      if (!ctx.settings.quantaraToken) throw new Error('No Quantara dashboard token is set in Settings, so halt is not available.');
      let res;
      try {
        res = await fetchWithTimeout(`${base}/api/control/halt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dashboard-token': ctx.settings.quantaraToken },
          body: JSON.stringify({ reason: `LocalPilot: ${String(input.reason || 'user asked').slice(0, 200)}` }),
        }, 20000);
      } catch {
        throw new Error(`Quantara dashboard not reachable at ${base}; the bot was NOT halted.`);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(`Quantara refused the halt (HTTP ${res.status}): ${body.error || 'unknown error'}. The bot was NOT halted.`);
      return [text('Quantara emergency stop engaged: no new entries. Open positions keep their broker-side stop and target. Resume it yourself on the Quantara dashboard when ready.')];
    }
    default:
      return null;
  }
}
