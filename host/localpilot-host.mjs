// LocalPilot native messaging host.
// Chrome starts this over stdio (see install.mjs). It gives the extension a small,
// sandboxed set of PC capabilities defined in config.json:
//   - list/read/write files inside configured roots (writes limited to data file types)
//   - write CSV files (UTF-8 BOM so Excel shows Chinese correctly)
//   - run allowlisted Node scripts inside a root (no shell, timeout, capped output)
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const MAX_OUT_MESSAGE = 900 * 1024; // Chrome caps host -> extension messages at 1 MB
const WRITABLE_EXTENSIONS = new Set(['.csv', '.json', '.md', '.txt', '.html', '.tsv']);
// Downloads that may be copied into a root: documents, data and images, never executables or scripts.
const IMPORTABLE_EXTENSIONS = new Set([...WRITABLE_EXTENSIONS, '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.zip', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function loadConfig(file = process.env.LOCALPILOT_HOST_CONFIG || path.join(HOST_DIR, 'config.json')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    roots: cfg.roots || [],
    scripts: cfg.scripts || [],
    downloadsDir: cfg.downloadsDir,
    maxReadBytes: cfg.maxReadBytes || 1024 * 1024,
    scriptTimeoutMs: cfg.scriptTimeoutMs || 120000,
  };
}

export function logDir() {
  return process.env.LOCALPILOT_LOG_DIR || path.join(HOST_DIR, '..', 'logs');
}

function log(line) {
  try {
    fs.appendFileSync(path.join(HOST_DIR, 'localpilot-host.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging is best effort
  }
}

// ---------------------------------------------------------------------------
// Sandbox

const sameCase = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;

function isInside(parent, child) {
  const rel = path.relative(sameCase(parent), sameCase(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function nearestExisting(p) {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
  return cur;
}

export function resolveInRoot(cfg, rootName, relPath = '.') {
  const root = cfg.roots.find((r) => r.name === rootName);
  if (!root) throw new Error(`Unknown root "${rootName}". Roots: ${cfg.roots.map((r) => r.name).join(', ')}`);
  const rel = String(relPath ?? '.');
  // Block alternate data streams and device paths (C:\x, \\?\, file.txt:stream).
  if (/:/.test(rel) || rel.startsWith('\\\\')) throw new Error('Path must be relative to the root.');
  const rootReal = fs.realpathSync.native(root.path);
  const abs = path.resolve(rootReal, rel);
  if (!isInside(rootReal, abs)) throw new Error(`Path escapes root "${rootName}".`);
  // Symlinks/junctions: the real location must also stay inside the root.
  const real = fs.realpathSync.native(nearestExisting(abs));
  if (!isInside(rootReal, real)) throw new Error(`Path resolves outside root "${rootName}".`);
  return { root, abs, rootReal };
}

// ---------------------------------------------------------------------------
// CSV

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const cols = columns?.length ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Methods

// ---------------------------------------------------------------------------
// Search: files by name (substring or * ? wildcards) and/or by text inside text files.

const SEARCH_SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build']);
const SEARCHABLE_TEXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.html', '.htm', '.xml', '.yml', '.yaml', '.log', '.js', '.mjs', '.ts', '.py', '.ini', '.cfg', '.toml', '.sql', '.tex', '.bib', '.srt', '.vtt']);
const SEARCH_MAX_ENTRIES = 50000;
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIME_MS = 8000;

export function namePattern(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  if (!/[*?]/.test(n)) return (s) => s.toLowerCase().includes(n);
  const re = new RegExp(`^${n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (s) => re.test(s);
}

function firstMatchingLine(file, needle) {
  const content = fs.readFileSync(file, 'utf8');
  const lower = content.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) return null;
  const lineNo = lower.slice(0, at).split('\n').length;
  const start = content.lastIndexOf('\n', at) + 1;
  const end = content.indexOf('\n', at);
  const line = content.slice(start, end < 0 ? undefined : end).trim();
  return { line: lineNo, snippet: line.length > 200 ? `${line.slice(Math.max(0, at - start - 60), at - start + 140)}…` : line };
}

function searchFiles(cfg, { root, path: rel = '.', name, text, limit = 50 }) {
  const matchName = namePattern(name);
  const needle = String(text || '').trim().toLowerCase();
  if (!matchName && !needle) throw new Error('Give name (part of a file name, or a pattern like *.pdf) and/or text to look for inside files.');
  const { abs } = resolveInRoot(cfg, root, rel);
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const started = Date.now();
  const results = [];
  let scanned = 0;
  let stopped = '';
  const stack = [abs];
  while (stack.length && !stopped) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      scanned += 1;
      if (scanned > SEARCH_MAX_ENTRIES) stopped = `stopped after ${SEARCH_MAX_ENTRIES} entries`;
      else if (Date.now() - started > SEARCH_TIME_MS) stopped = `stopped after ${SEARCH_TIME_MS / 1000} s`;
      if (stopped) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
        if (matchName?.(e.name) && !needle) results.push({ path: path.relative(abs, full), type: 'dir' });
      } else if (e.isFile()) {
        if (matchName && !matchName(e.name)) continue;
        const st = fs.statSync(full, { throwIfNoEntry: false });
        if (!st) continue;
        let hit = {};
        if (needle) {
          if (!SEARCHABLE_TEXT.has(path.extname(e.name).toLowerCase()) || st.size > SEARCH_MAX_FILE_BYTES) continue;
          try {
            hit = firstMatchingLine(full, needle);
          } catch {
            hit = null;
          }
          if (!hit) continue;
        }
        results.push({ path: path.relative(abs, full), type: 'file', size: st.size, modified: st.mtime.toISOString(), ...hit });
      }
      if (results.length >= max) {
        stopped = `first ${max} matches`;
        break;
      }
    }
  }
  return { path: abs, results, scanned, truncated: stopped };
}

function writeChecked(cfg, { root, path: rel, content, overwrite = false }) {
  const { root: r, abs } = resolveInRoot(cfg, root, rel);
  if (!r.writable) throw new Error(`Root "${root}" is read-only.`);
  const ext = path.extname(abs).toLowerCase();
  if (!WRITABLE_EXTENSIONS.has(ext)) {
    throw new Error(`Writing ${ext || 'extensionless'} files is not allowed. Allowed: ${[...WRITABLE_EXTENSIONS].join(' ')}`);
  }
  if (fs.existsSync(abs) && !overwrite) throw new Error(`${rel} already exists. Pass overwrite: true or choose another name.`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { path: abs, bytes: Buffer.byteLength(content) };
}

export function createHandlers(cfg) {
  return {
    hello() {
      return {
        version: VERSION,
        roots: cfg.roots.map((r) => ({ name: r.name, path: r.path, writable: !!r.writable })),
        scripts: cfg.scripts.map((s) => ({ name: s.name, root: s.root, description: s.description || '', internal: !!s.internal })),
      };
    },

    list_dir({ root, path: rel = '.', limit = 500 }) {
      const { abs } = resolveInRoot(cfg, root, rel);
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, limit)
        .map((e) => {
          const full = path.join(abs, e.name);
          const st = fs.statSync(full, { throwIfNoEntry: false });
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? null : st?.size ?? null, modified: st?.mtime.toISOString() ?? null };
        });
      return { path: abs, entries };
    },

    read_file({ root, path: rel, maxBytes }) {
      const { abs } = resolveInRoot(cfg, root, rel);
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error(`${rel} is a directory. Use list_dir.`);
      const cap = Math.min(maxBytes || cfg.maxReadBytes, cfg.maxReadBytes, MAX_OUT_MESSAGE - 4096);
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, cap));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return { path: abs, size: st.size, truncated: st.size > cap, content: buf.toString('utf8') };
      } finally {
        fs.closeSync(fd);
      }
    },

    write_file(params) {
      return writeChecked(cfg, params);
    },

    search(params) {
      return searchFiles(cfg, params);
    },

    write_csv({ root, path: rel, columns, rows, overwrite = false, bom = true }) {
      if (!Array.isArray(rows)) throw new Error('rows must be an array of objects.');
      const content = (bom ? '\uFEFF' : '') + toCsv(columns, rows);
      return { ...writeChecked(cfg, { root, path: rel, content, overwrite }), rows: rows.length };
    },

    // Absolute path of an existing file inside a root (for browser file uploads).
    resolve_path({ root, path: rel }) {
      const { abs } = resolveInRoot(cfg, root, rel);
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (!st || !st.isFile()) throw new Error(`${rel} is not a file in root "${root}".`);
      return { path: abs, size: st.size };
    },

    // Copy a finished browser download (must be in the Downloads folder) into a root.
    import_download({ src, root, path: rel, overwrite = false }) {
      const downloads = fs.realpathSync.native(cfg.downloadsDir || path.join(os.homedir(), 'Downloads'));
      const real = fs.realpathSync.native(String(src));
      if (!isInside(downloads, real)) throw new Error(`Only files from ${downloads} can be imported.`);
      const ext = path.extname(rel || real).toLowerCase();
      if (!IMPORTABLE_EXTENSIONS.has(ext)) throw new Error(`Importing ${ext || 'extensionless'} files is not allowed. Allowed: ${[...IMPORTABLE_EXTENSIONS].join(' ')}`);
      const target = rel || path.basename(real);
      const { root: r, abs } = resolveInRoot(cfg, root, target);
      if (!r.writable) throw new Error(`Root "${root}" is read-only.`);
      if (fs.existsSync(abs) && !overwrite) throw new Error(`${target} already exists. Pass overwrite: true or choose another name.`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(real, abs);
      return { path: abs, bytes: fs.statSync(abs).size };
    },

    // Diagnostics from the extension, appended as JSON lines to <extension>/logs.
    append_log({ lines }) {
      if (!Array.isArray(lines) || lines.some((l) => typeof l !== 'string')) throw new Error('lines must be strings.');
      const text = lines.map((l) => l.replace(/[\r\n]+/g, ' ')).join('\n');
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('log batch too large.');
      const dir = logDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `localpilot-${new Date().toISOString().slice(0, 10)}.jsonl`);
      if (text) fs.appendFileSync(file, `${text}\n`, 'utf8');
      return { file, lines: lines.length };
    },

    run_script({ name, args = [] }) {
      const script = cfg.scripts.find((s) => s.name === name);
      if (!script) throw new Error(`Script "${name}" is not allowlisted. Allowed: ${cfg.scripts.map((s) => s.name).join(', ') || 'none'}`);
      if (!Array.isArray(args) || args.length > 20 || args.some((a) => typeof a !== 'string' || a.length > 1000)) {
        throw new Error('args must be up to 20 strings.');
      }
      const { abs: file, rootReal } = resolveInRoot(cfg, script.root, script.file);
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [file, ...args], { cwd: rootReal, shell: false, windowsHide: true });
        let stdout = '';
        let stderr = '';
        const cap = 64 * 1024;
        child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-cap)));
        child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-cap)));
        const timer = setTimeout(() => child.kill(), cfg.scriptTimeoutMs);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ exitCode: code, signal, stdout, stderr, timedOut: signal === 'SIGTERM' });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ exitCode: null, stdout, stderr: String(err.message) });
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// MCP relay: a local pipe that host/mcp-server.mjs (started by Claude Code or any
// MCP client) connects to. Calls are forwarded to the extension, which runs the
// browser tool and answers. Clients must present the token from bridge.json,
// which lives in the user's profile.

export function stateDir() {
  return process.env.LOCALPILOT_STATE_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'LocalPilot');
}

export function pipePath() {
  if (process.env.LOCALPILOT_PIPE) return process.env.LOCALPILOT_PIPE;
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
  return process.platform === 'win32' ? `\\\\.\\pipe\\localpilot-${user}` : path.join(os.tmpdir(), `localpilot-${user}.sock`);
}

function startRelay(sendToExtension) {
  const pipe = pipePath();
  const token = crypto.randomBytes(24).toString('hex');
  const calls = new Map(); // callId -> { socket, id, timer }
  let seq = 0;
  let sessions = 0;

  const server = net.createServer((socket) => {
    let authed = false;
    let session = null; // one per MCP client (Claude Code session): its own tab in the browser
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!authed) {
          const given = Buffer.from(String(msg.token || ''));
          authed = msg.type === 'auth' && given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token));
          socket.write(`${JSON.stringify({ type: 'auth', ok: authed })}\n`);
          if (!authed) socket.end();
          else session = /^[\w-]{1,64}$/.test(String(msg.session || '')) ? msg.session : `s${(sessions += 1)}`;
          continue;
        }
        if (msg.op === 'cancel') {
          for (const [callId, c] of calls) {
            if (c.socket === socket && c.id === msg.target) {
              calls.delete(callId);
              clearTimeout(c.timer);
              sendToExtension({ type: 'mcp_cancel', callId });
            }
          }
          continue;
        }
        seq += 1;
        const callId = `c${seq}`;
        const timer = setTimeout(() => {
          calls.delete(callId);
          socket.write(`${JSON.stringify({ id: msg.id, ok: false, error: 'LocalPilot extension did not answer in time.' })}\n`);
        }, 10 * 60 * 1000);
        calls.set(callId, { socket, id: msg.id, timer });
        sendToExtension({ type: 'mcp', callId, session, op: msg.op, name: msg.name, arguments: msg.arguments || {} });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!authed) return;
      // The client is gone: stop its unfinished calls and free its tab.
      for (const [callId, c] of calls) {
        if (c.socket !== socket) continue;
        calls.delete(callId);
        clearTimeout(c.timer);
        sendToExtension({ type: 'mcp_cancel', callId });
      }
      sendToExtension({ type: 'mcp_session_end', session });
    });
  });

  server.on('error', (err) => {
    // Another browser/profile already serves the pipe; that one handles MCP clients.
    log(`relay not started: ${err.code || err.message}`);
  });
  const bridgeFile = path.join(stateDir(), 'bridge.json');
  server.listen(pipe, () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(bridgeFile, JSON.stringify({ pipe, token, pid: process.pid, started: new Date().toISOString() }));
    log(`relay listening on ${pipe}`);
    // Remove our bridge.json on exit so clients don't try a dead pipe with a stale token.
    process.on('exit', () => {
      try {
        if (JSON.parse(fs.readFileSync(bridgeFile, 'utf8')).pid === process.pid) fs.unlinkSync(bridgeFile);
      } catch {
        // already gone or replaced by another host
      }
    });
  });

  return {
    progress(msg) {
      const call = calls.get(msg.callId);
      if (call && !call.socket.destroyed) call.socket.write(`${JSON.stringify({ id: call.id, progress: msg.progress })}\n`);
    },
    deliver(msg) {
      const call = calls.get(msg.callId);
      if (!call) return;
      calls.delete(msg.callId);
      clearTimeout(call.timer);
      if (!call.socket.destroyed) {
        call.socket.write(`${JSON.stringify({ id: call.id, ok: msg.ok, result: msg.result, error: msg.error })}\n`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Native messaging framing: 4-byte little-endian length + UTF-8 JSON.

function send(obj) {
  let json = JSON.stringify(obj);
  if (Buffer.byteLength(json) > MAX_OUT_MESSAGE) {
    json = JSON.stringify({ id: obj.id, ok: false, error: 'Response too large for native messaging (1 MB limit). Narrow the request.' });
  }
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function serve() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    log(`config error: ${err.message}`);
  }
  const handlers = cfg ? createHandlers(cfg) : {};
  const relay = process.env.LOCALPILOT_NO_RELAY ? null : startRelay(send);
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const msg = buffer.subarray(4, 4 + len).toString('utf8');
      buffer = buffer.subarray(4 + len);
      let req;
      try {
        req = JSON.parse(msg);
      } catch {
        send({ ok: false, error: 'Invalid JSON' });
        continue;
      }
      if (req.type === 'mcp_result') {
        relay?.deliver(req);
        continue;
      }
      if (req.type === 'mcp_progress') {
        relay?.progress(req);
        continue;
      }
      if (!cfg) {
        send({ id: req.id, ok: false, error: `Host config missing or invalid: ${path.join(HOST_DIR, 'config.json')}` });
        continue;
      }
      const fn = handlers[req.method];
      if (!fn) {
        send({ id: req.id, ok: false, error: `Unknown method ${req.method}` });
        continue;
      }
      try {
        const result = await fn(req.params || {});
        if (req.method !== 'append_log') log(`${req.method} ok ${JSON.stringify(req.params || {}).slice(0, 200)}`);
        send({ id: req.id, ok: true, result });
      } catch (err) {
        log(`${req.method} error ${err.message}`);
        send({ id: req.id, ok: false, error: String(err.message || err) });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
