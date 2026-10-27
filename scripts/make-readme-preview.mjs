// Makes the README's moving preview (docs/img/tour-preview.gif) from the site video
// (site/media/hero.mp4): GitHub does not play videos stored in a repo, so the README shows a
// short GIF that links to the site, where the full video plays with sound.
// Uses the installed Google Chrome (headless, temporary profile): Chromium builds cannot decode
// H.264. Frames are drawn to a canvas and encoded with LocalPilot's own GIF encoder (src/gif.js).
//   node scripts/make-readme-preview.mjs [--from 0] [--to 8] [--fps 10] [--width 720]
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const from = arg('from', 0);
const to = arg('to', 8);
const fps = arg('fps', 10);
const width = arg('width', 720);
const out = path.join(root, 'docs', 'img', 'tour-preview.gif');

const TYPES = { '.mp4': 'video/mp4', '.js': 'text/javascript', '.html': 'text/html' };
const PAGE = '<!doctype html><video id="v" muted preload="auto"></video>';
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const gif = await page.evaluate(async ({ from, to, fps, width }) => {
    const { encodeGif } = await import('/src/gif.js');
    const video = document.getElementById('v');
    // A blob URL can be seeked without HTTP range requests (this little server has none).
    video.src = URL.createObjectURL(await (await fetch('/site/media/hero.mp4')).blob());
    await new Promise((r, j) => { video.onloadeddata = r; video.onerror = () => j(new Error('This Chrome cannot decode the video.')); });
    const height = Math.round((width * video.videoHeight) / video.videoWidth / 2) * 2;
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let t = from; t < Math.min(to, video.duration); t += 1 / fps) {
      video.currentTime = t;
      await new Promise((r) => { video.onseeked = r; });
      g.drawImage(video, 0, 0, width, height);
      frames.push({ rgba: g.getImageData(0, 0, width, height).data, delayMs: 1000 / fps });
    }
    const bytes = encodeGif(frames, { width, height });
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), frames: frames.length, width, height };
  }, { from, to, fps, width });
  fs.writeFileSync(out, Buffer.from(gif.b64, 'base64'));
  console.log(`${path.relative(root, out)}: ${gif.frames} frames, ${gif.width}x${gif.height}, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
} finally {
  await browser.close();
  server.close();
}
