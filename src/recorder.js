// Run recorder: a screenshot after each action, then an animated GIF with a caption bar
// ("3. Click 'Add to cart'" + what the agent said) and a red marker where it clicked.
// Files are saved through chrome.downloads (Downloads/LocalPilot/…), so no PC bridge is needed;
// with the bridge they can also be copied into a PC root.
import { encodeGif } from './gif.js';
import * as pc from './pcbridge.js';

export const MAX_FRAMES = 120;
const BAR = 64;

export function startRecording(ctx, title = '') {
  ctx.recording = { title: String(title || '').slice(0, 200), frames: [], startedAt: Date.now() };
  return ctx.recording;
}

export function stopRecording(ctx) {
  const rec = ctx.recording;
  ctx.recording = null;
  return rec;
}

// Keeps the first frame and the most recent ones when a long run exceeds MAX_FRAMES.
export function addFrame(rec, frame) {
  rec.frames.push({ ...frame, at: Date.now() });
  if (rec.frames.length > MAX_FRAMES) rec.frames.splice(1, 1);
  return rec.frames.length;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// One short line for the caption bar.
// label: the clicked element's visible text, when known ("Add to cart").
export function describeAction(name, input = {}, label = '') {
  const target = label ? `"${clip(label, 50)}"` : input.ref || (input.mark !== undefined ? `mark ${input.mark}` : Array.isArray(input.coordinate) ? `(${input.coordinate.join(', ')})` : '');
  switch (name) {
    case 'navigate':
      return ['back', 'forward'].includes(input.url) ? `Go ${input.url}` : `Open ${clip(input.url, 70)}`;
    case 'tabs_create':
      return `Open a new tab${input.url ? `: ${clip(input.url, 60)}` : ''}`;
    case 'switch_tab':
      return `Switch to tab ${input.tab_id}`;
    case 'form_input':
      return `Fill ${input.ref} with "${clip(input.value, 40)}"`;
    case 'file_upload':
      return `Upload ${clip(input.attachment || input.path, 50)}`;
    case 'handle_dialog':
      return `${input.accept ? 'Accept' : 'Dismiss'} the dialog`;
    case 'extract_list':
      return `Read the list${input.pages > 1 ? ` (${input.pages} pages)` : ''}`;
    case 'computer':
      switch (input.action) {
        case 'left_click': return `Click ${target}`;
        case 'right_click': return `Right-click ${target}`;
        case 'double_click': return `Double-click ${target}`;
        case 'triple_click': return `Triple-click ${target}`;
        case 'type': return `Type "${clip(input.text, 40)}"`;
        case 'key': return `Press ${clip(input.text, 30)}`;
        case 'scroll': return `Scroll ${input.scroll_direction || 'down'}`;
        case 'left_click_drag': return 'Drag';
        default: return input.action;
      }
    default:
      return name.replace(/_/g, ' ');
  }
}

// Tools after which a frame is captured while recording.
export function recordsAfter(name, input = {}) {
  if (['navigate', 'tabs_create', 'switch_tab', 'form_input', 'file_upload', 'handle_dialog'].includes(name)) return true;
  if (name === 'extract_list') return Number(input.pages) > 1;
  return name === 'computer' && ['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'scroll', 'left_click_drag'].includes(input.action);
}

// --- drawing -------------------------------------------------------------------------

function fitText(g, text, maxWidth) {
  let t = String(text || '');
  if (g.measureText(t).width <= maxWidth) return t;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function wrap(g, text, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) lines[maxLines - 1] = fitText(g, lines[maxLines - 1], maxWidth);
  return lines;
}

async function decodeJpeg(base64) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

const FONT = '"Segoe UI", system-ui, -apple-system, Arial, sans-serif';

function drawTitle(g, w, h, title, sub) {
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#1e3a8a');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#60a5fa';
  g.font = `700 22px ${FONT}`;
  g.fillText('LocalPilot', 40, h / 2 - 70);
  g.fillStyle = '#ffffff';
  g.font = `600 28px ${FONT}`;
  wrap(g, title || 'Recorded run', w - 80, 3).forEach((line, i) => g.fillText(line, 40, h / 2 - 25 + i * 36));
  g.fillStyle = '#cbd5e1';
  g.font = `400 16px ${FONT}`;
  g.fillText(fitText(g, sub, w - 80), 40, h - 40);
}

function drawBar(g, w, h, step, action, note) {
  g.fillStyle = '#0f172a';
  g.fillRect(0, h - BAR, w, BAR);
  g.fillStyle = '#3b82f6';
  g.beginPath();
  g.arc(26, h - BAR + 22, 13, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = `700 13px ${FONT}`;
  g.textAlign = 'center';
  g.fillText(String(step), 26, h - BAR + 27);
  g.textAlign = 'left';
  g.font = `600 16px ${FONT}`;
  g.fillText(fitText(g, action, w - 64), 48, h - BAR + 28);
  g.fillStyle = '#cbd5e1';
  g.font = `400 13px ${FONT}`;
  g.fillText(fitText(g, note, w - 64), 48, h - BAR + 50);
}

function drawMarker(g, x, y) {
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.arc(x, y, 16, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 4;
  g.strokeStyle = '#ef4444';
  g.fillStyle = 'rgba(239,68,68,0.25)';
  g.beginPath();
  g.arc(x, y, 16, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#ef4444';
  g.beginPath();
  g.arc(x, y, 3, 0, Math.PI * 2);
  g.fill();
}

// frames: [{ jpeg, cssW, cssH, action, note, url, point: [x, y] (CSS px) }]
export async function composeFrames(rec, { width = 800, delayMs = 1400 } = {}) {
  if (!rec?.frames.length) throw new Error('Nothing was recorded yet.');
  const first = await decodeJpeg(rec.frames[0].jpeg);
  const imgH = Math.round((first.height * width) / first.width);
  first.close();
  const height = imgH + BAR;
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const out = [];
  const date = new Date(rec.startedAt).toLocaleString();
  drawTitle(g, width, height, rec.title, `${date} · ${rec.frames.length} step${rec.frames.length === 1 ? '' : 's'}`);
  out.push({ rgba: g.getImageData(0, 0, width, height).data, delayMs: 1800 });
  for (const [i, f] of rec.frames.entries()) {
    const bmp = await decodeJpeg(f.jpeg);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, width, imgH);
    const drawH = Math.round((bmp.height * width) / bmp.width);
    g.drawImage(bmp, 0, 0, width, Math.min(drawH, imgH)); // same-size viewports; taller ones are cropped
    bmp.close();
    if (f.point && f.cssW) drawMarker(g, (f.point[0] * width) / f.cssW, (f.point[1] * width) / f.cssW);
    drawBar(g, width, height, i + 1, f.action || 'Page', f.note || f.url || '');
    out.push({ rgba: g.getImageData(0, 0, width, height).data, delayMs: i === rec.frames.length - 1 ? 3000 : f.delayMs || delayMs });
  }
  return { frames: out, width, height };
}

export async function buildGif(rec, opts) {
  const { frames, width, height } = await composeFrames(rec, opts);
  return encodeGif(frames, { width, height });
}

// --- saving -----------------------------------------------------------------------------

export function toBase64(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function safeFileName(s) {
  return String(s || 'run').replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run';
}

// Saves into Downloads/LocalPilot/<name> and resolves with the final path.
export async function saveDownload(data, name, mime) {
  const url = `data:${mime};base64,${toBase64(data)}`;
  const id = await chrome.downloads.download({ url, filename: `LocalPilot/${name}`, conflictAction: 'uniquify', saveAs: false });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === 'complete') return { id, path: item.filename };
    if (item?.state === 'interrupted') throw new Error(`Saving ${name} failed: ${item.error}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Saving ${name} timed out.`);
}

// Optional copy into a PC root (needs the PC bridge); returns the copied path or null.
export async function copyToRoot(ctx, path, saveTo, fileName) {
  if (!saveTo?.root) return null;
  if (!ctx.host) throw new Error('save_to needs the PC bridge (node host/install.mjs).');
  const rel = saveTo.path ? `${String(saveTo.path).replace(/[\\/]+$/, '')}/${fileName}` : fileName;
  return (await pc.call('import_download', { src: path, root: saveTo.root, path: rel, overwrite: !!saveTo.overwrite })).path;
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
