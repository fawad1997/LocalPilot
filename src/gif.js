// Animated GIF (GIF89a) encoder in plain JS: no build step, works in the service worker.
// Each frame gets its own 256-colour palette (median cut over a 15-bit histogram), then LZW.
//   encodeGif([{ rgba: Uint8ClampedArray, delayMs }], { width, height, loop: 0 }) -> Uint8Array

class ByteWriter {
  constructor(size = 1 << 20) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  u16(v) {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }

  ascii(s) {
    for (let i = 0; i < s.length; i += 1) this.byte(s.charCodeAt(i));
  }

  result() {
    return this.buf.slice(0, this.len);
  }
}

// --- colour quantization -----------------------------------------------------------

const bin15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

// Median cut on a 32x32x32 histogram. Returns { palette: Uint8Array(768), indices: Uint8Array(pixels), colors }.
export function quantize(rgba, maxColors = 256) {
  const count = new Uint32Array(32768);
  const sumR = new Float64Array(32768);
  const sumG = new Float64Array(32768);
  const sumB = new Float64Array(32768);
  const px = rgba.length >> 2;
  for (let i = 0, p = 0; i < px; i += 1, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const k = bin15(r, g, b);
    count[k] += 1;
    sumR[k] += r;
    sumG[k] += g;
    sumB[k] += b;
  }
  const used = [];
  for (let k = 0; k < 32768; k += 1) if (count[k]) used.push(k);

  const chan = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const makeBox = (bins) => {
    let total = 0;
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    for (const k of bins) {
      total += count[k];
      for (let c = 0; c < 3; c += 1) {
        const v = chan(k, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    return { bins, total, axis, range: ranges[axis] };
  };

  const boxes = [makeBox(used)];
  while (boxes.length < maxColors) {
    // Split the box with the most pixels that can still be split (weighted by its spread).
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      if (b.bins.length < 2 || b.range === 0) continue;
      const score = b.total * (b.range + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    const box = boxes[best];
    const axis = box.axis;
    box.bins.sort((a, b) => chan(a, axis) - chan(b, axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.bins.length - 1; i += 1) {
      acc += count[box.bins[i]];
      cut = i + 1;
      if (acc >= box.total / 2) break;
    }
    boxes.splice(best, 1, makeBox(box.bins.slice(0, cut)), makeBox(box.bins.slice(cut)));
  }

  const palette = new Uint8Array(768);
  const binToIndex = new Uint8Array(32768);
  boxes.forEach((box, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const k of box.bins) {
      r += sumR[k];
      g += sumG[k];
      b += sumB[k];
      binToIndex[k] = i;
    }
    palette[i * 3] = Math.round(r / box.total);
    palette[i * 3 + 1] = Math.round(g / box.total);
    palette[i * 3 + 2] = Math.round(b / box.total);
  });
  const indices = new Uint8Array(px);
  for (let i = 0, p = 0; i < px; i += 1, p += 4) indices[i] = binToIndex[bin15(rgba[p], rgba[p + 1], rgba[p + 2])];
  return { palette, indices, colors: boxes.length };
}

// --- LZW -------------------------------------------------------------------------------

// Shared lookup table: key = prefix code << 8 | next index. A generation stamp replaces clearing it.
let codes = null;
let gens = null;
let gen = 0;

export function lzwEncode(indices, minCodeSize, out) {
  if (!codes) {
    codes = new Int32Array(1 << 20);
    gens = new Int32Array(1 << 20);
  }
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  gen += 1;

  out.byte(minCodeSize);
  const block = new Uint8Array(255);
  let blockLen = 0;
  let cur = 0;
  let shift = 0;
  const flushByte = (b) => {
    block[blockLen++] = b;
    if (blockLen === 255) {
      out.byte(255);
      out.bytes(block);
      blockLen = 0;
    }
  };
  const emit = (code) => {
    cur |= code << shift;
    shift += codeSize;
    while (shift >= 8) {
      flushByte(cur & 0xff);
      cur >>>= 8;
      shift -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    if (gens[key] === gen) {
      prefix = codes[key];
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      gen += 1;
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (nextCode >= (1 << codeSize)) codeSize += 1;
      codes[key] = nextCode;
      gens[key] = gen;
      nextCode += 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (shift > 0) flushByte(cur & 0xff);
  if (blockLen) {
    out.byte(blockLen);
    out.bytes(block.subarray(0, blockLen));
  }
  out.byte(0); // block terminator
}

// --- file ------------------------------------------------------------------------------

export function encodeGif(frames, { width, height, loop = 0 } = {}) {
  if (!frames.length) throw new Error('No frames to encode.');
  const out = new ByteWriter(Math.max(1 << 16, width * height));
  out.ascii('GIF89a');
  out.u16(width);
  out.u16(height);
  out.byte(0x00); // no global colour table: every frame has its own
  out.byte(0);
  out.byte(0);
  // Loop forever (NETSCAPE2.0 application extension).
  out.bytes([0x21, 0xff, 0x0b]);
  out.ascii('NETSCAPE2.0');
  out.bytes([0x03, 0x01]);
  out.u16(loop);
  out.byte(0);
  for (const frame of frames) {
    if (frame.rgba.length !== width * height * 4) throw new Error('Every frame must be width x height.');
    const { palette, indices } = quantize(frame.rgba);
    out.bytes([0x21, 0xf9, 0x04, 0x04]); // graphic control: leave the frame in place
    out.u16(Math.max(2, Math.round((frame.delayMs ?? 1000) / 10)));
    out.byte(0);
    out.byte(0);
    out.byte(0x2c); // image descriptor
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0x87); // local colour table, 256 entries
    out.bytes(palette);
    lzwEncode(indices, 8, out);
  }
  out.byte(0x3b);
  return out.result();
}
