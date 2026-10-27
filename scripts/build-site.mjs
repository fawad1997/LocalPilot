// Builds the GitHub Pages site into _site/: site/ plus the demo media it links to, copied
// at their repo paths so the GIFs live in git only once. When site/media/hero.mp4 exists,
// the hero swaps the demo GIF for the video. Used by .github/workflows/pages.yml.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const MEDIA = /\.(gif|png|jpe?g|webp|mp4|webm)$/i;

// Empty rather than delete _site/: on Windows a preview server running inside it locks the folder.
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(out)) fs.rmSync(path.join(out, name), { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
for (const dir of ['examples/demo-ai', 'examples/real', 'examples/demo', 'docs/img', 'icons']) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (!MEDIA.test(name)) continue;
    fs.mkdirSync(path.join(out, dir), { recursive: true });
    fs.copyFileSync(path.join(root, dir, name), path.join(out, dir, name));
  }
}
fs.copyFileSync(path.join(root, 'icons/icon-128.png'), path.join(out, 'favicon.png'));

const hasVideo = fs.existsSync(path.join(out, 'media/hero.mp4'));
const hasPoster = fs.existsSync(path.join(out, 'media/hero.jpg'));
let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
if (hasVideo) {
  html = html
    .replace(/<!--HERO-GIF-->[\s\S]*?<!--\/HERO-GIF-->/, '')
    .replace(/<!--HERO-VIDEO([\s\S]*?)-->/, '$1')
    .replace(/<!--VIDEO-CARD([\s\S]*?)-->/, '$1')
    .replaceAll(' poster="media/hero.jpg"', hasPoster ? ' poster="media/hero.jpg"' : '');
}
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Built ${path.relative(root, out)}/ (hero: ${hasVideo ? 'video' : 'GIF'})`);
