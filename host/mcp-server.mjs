#!/usr/bin/env node
// LocalPilot MCP server (stdio). Register it with Claude Code:
//   claude mcp add localpilot -- node "D:\AI\BrowserExtension\host\mcp-server.mjs"
// It forwards tool calls over a local pipe to the LocalPilot native host, which
// relays them to the extension running in your browser. Chrome must be open
// with LocalPilot installed and the PC bridge set up (node host/install.mjs).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { stateDir } from './localpilot-host.mjs';

const VERSION = '0.4.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CACHE = path.join(stateDir(), 'mcp-tools-cache.json');

const STATUS_TOOL = {
  name: 'localpilot_status',
  description: 'Check whether the LocalPilot browser extension is connected.',
  inputSchema: { type: 'object', properties: {} },
};

const INSTRUCTIONS = [
  'LocalPilot drives the user\'s real browser (their logins and cookies) through the LocalPilot extension.',
  'Calls run in a dedicated, unfocused "LocalPilot MCP" browser window (its own tab group). Start with navigate, tabs_context or tabs_create; every tool takes an optional tab_id.',
  'Screenshots carry numbered marks: click with {"action":"left_click","mark":N}. Refs inside iframes look like f3:ref_7.',
  'confirm()/prompt() dialogs stay open until you call handle_dialog. file_upload attaches files from the jobs folder; downloads_wait saves downloads into it.',
  'Prefer read_page/find refs over screenshot coordinates. Use capture_start + capture_read to read a site\'s own JSON API responses.',
  'Job-board recipes (boss_collect_jobs, liepin_collect_jobs, job51_collect_jobs, zhaopin_collect_jobs, linkedin_collect_jobs) save a CSV and import draft into the jobs folder, skip jobs collected before, and run the import.',
  'Never enter passwords or payment details; ask the user to do it in the browser.',
].join('\n');

// ---------------------------------------------------------------------------
// Pipe client

let sock = null;
let connecting = null;
let nextId = 1;
const pending = new Map();
let usedFallbackList = false;

function readBridge() {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), 'bridge.json'), 'utf8'));
  } catch {
    return null;
  }
}

function connectPipe() {
  if (sock) return Promise.resolve(sock);
  if (connecting) return connecting;
  const bridge = readBridge();
  if (!bridge) {
    return Promise.reject(new Error('LocalPilot is not running: open Chrome with the LocalPilot extension (and run node host/install.mjs once).'));
  }
  connecting = new Promise((resolve, reject) => {
    const s = net.connect(bridge.pipe);
    let buf = '';
    let authed = false;
    const fail = (err) => {
      connecting = null;
      sock = null;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      reject(err);
    };
    s.setEncoding('utf8');
    s.on('connect', () => s.write(`${JSON.stringify({ type: 'auth', token: bridge.token })}\n`));
    s.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!authed) {
          if (msg.type === 'auth' && msg.ok) {
            authed = true;
            sock = s;
            connecting = null;
            resolve(s);
          } else {
            fail(new Error('LocalPilot rejected the connection (stale token). Reload the extension.'));
          }
          continue;
        }
        const p = pending.get(msg.id);
        if (!p) continue;
        if (msg.progress) {
          p.onProgress?.(msg.progress);
          continue;
        }
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      }
    });
    s.on('error', () => fail(new Error('LocalPilot is not reachable: open Chrome with the LocalPilot extension enabled.')));
    s.on('close', () => {
      sock = null;
      connecting = null;
      for (const p of pending.values()) p.reject(new Error('LocalPilot connection closed.'));
      pending.clear();
    });
  });
  return connecting;
}

// Waits up to waitMs for the browser side (e.g. Chrome still starting, or the
// extension reconnecting its host after a service-worker restart).
async function connectWithWait(waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await connectPipe();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// opts.onProgress(progress) receives progress updates; opts.onId(pipeId) exposes the
// pipe-level id so the call can be cancelled.
async function relay(op, name, args, opts = {}) {
  const s = await connectWithWait(opts.waitMs ?? 0);
  const id = nextId++;
  opts.onId?.(id);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    s.write(`${JSON.stringify({ id, op, name, arguments: args })}\n`);
  });
}

function cancelRelay(pipeId) {
  if (!sock || !pending.has(pipeId)) return;
  sock.write(`${JSON.stringify({ op: 'cancel', target: pipeId })}\n`);
  const p = pending.get(pipeId);
  pending.delete(pipeId);
  p.reject(Object.assign(new Error('Cancelled by the client.'), { cancelled: true }));
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over newline-delimited stdio)

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return null;
  }
}

async function listTools() {
  try {
    const { tools } = await relay('list_tools');
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(tools));
    usedFallbackList = false;
    return [STATUS_TOOL, ...tools];
  } catch {
    usedFallbackList = true;
    return [STATUS_TOOL, ...(readCache() || [])];
  }
}

const inflight = new Map(); // JSON-RPC request id -> pipe id
const cancelled = new Set(); // JSON-RPC ids that must not get a response

async function callTool(name, args, rpcId, progressToken) {
  if (name === 'localpilot_status') {
    try {
      const { tools } = await relay('list_tools');
      if (usedFallbackList) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      usedFallbackList = false;
      return { content: [{ type: 'text', text: `LocalPilot connected. ${tools.length} browser tools available.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
  }
  try {
    const result = await relay('call_tool', name, args || {}, {
      waitMs: 15000,
      onId: (pipeId) => inflight.set(rpcId, pipeId),
      onProgress: progressToken === undefined
        ? undefined
        : (p) => write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: p.progress, ...(p.total ? { total: p.total } : {}), ...(p.message ? { message: p.message } : {}) } }),
    });
    return { content: result.content?.length ? result.content : [{ type: 'text', text: 'ok' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  } finally {
    inflight.delete(rpcId);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        result = {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'localpilot', version: VERSION },
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: await listTools() };
        break;
      case 'tools/call':
        result = await callTool(params?.name, params?.arguments, id, params?._meta?.progressToken);
        if (cancelled.delete(id)) return; // client cancelled: no response, per MCP
        break;
      case 'notifications/cancelled': {
        const rid = params?.requestId;
        cancelled.add(rid);
        if (inflight.has(rid)) cancelRelay(inflight.get(rid));
        return;
      }
      default:
        if (!isRequest) return; // notifications (initialized, cancelled, …)
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
    if (isRequest) write({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err.message || err) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));
