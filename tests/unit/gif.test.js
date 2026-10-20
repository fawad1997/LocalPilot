import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGif, quantize } from '../../src/gif.js';
import { decodeGif } from '../gif-decode.mjs';

function frame(w, h, fn, delayMs = 500) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return { rgba, delayMs };
}

test('gif: header, loop, delays and exact pixels for few-colour frames', () => {
  const w = 37;
  const h = 23;
  const colors = [[255, 0, 0], [0, 128, 255], [255, 255, 255], [16, 16, 16]];
  const frames = [
    frame(w, h, (x, y) => colors[(x + y) % 4], 1200),
    frame(w, h, (x) => colors[x % 2], 3000),
  ];
  const gif = encodeGif(frames, { width: w, height: h });
  const d = decodeGif(gif);
  assert.equal(d.sig, 'GIF89a');
  assert.deepEqual([d.width, d.height, d.frames.length, d.loop], [w, h, 2, 0]);
  assert.deepEqual(d.frames.map((f) => f.delay), [1200, 3000]);
  for (const [fi, f] of d.frames.entries()) {
    for (let i = 0; i < w * h; i += 1) {
      const k = f.indices[i] * 3;
      const got = [f.palette[k], f.palette[k + 1], f.palette[k + 2]];
      const src = frames[fi].rgba;
      // Colours are exact when a frame has fewer than 256 distinct 15-bit colours (rounded to the bin mean).
      assert.deepEqual(got, [src[i * 4], src[i * 4 + 1], src[i * 4 + 2]], `frame ${fi} pixel ${i}`);
    }
  }
  assert.equal(gif.at(-1), 0x3b);
});

test('gif: noisy full-colour frame survives LZW table resets and stays close in colour', () => {
  const w = 160;
  const h = 120;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const f = frame(w, h, (x, y) => [Math.floor(rnd() * 256), (x * 2) & 255, (y * 2) & 255]);
  const d = decodeGif(encodeGif([f], { width: w, height: h }));
  let err = 0;
  for (let i = 0; i < w * h; i += 1) {
    const k = d.frames[0].indices[i] * 3;
    for (let c = 0; c < 3; c += 1) err += Math.abs(d.frames[0].palette[k + c] - f.rgba[i * 4 + c]);
  }
  assert.ok(err / (w * h * 3) < 24, `mean channel error ${err / (w * h * 3)}`);
});

test('gif: quantize keeps at most 256 colours and maps every pixel', () => {
  const f = frame(64, 64, (x, y) => [x * 4, y * 4, (x * y) & 255]);
  const q = quantize(f.rgba);
  assert.ok(q.colors <= 256 && q.colors > 200, `colours: ${q.colors}`);
  assert.equal(q.indices.length, 64 * 64);
  assert.ok(Math.max(...q.indices) < q.colors);
  assert.throws(() => encodeGif([], { width: 1, height: 1 }), /No frames/);
});
