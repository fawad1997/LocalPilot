// GIF decoder used by the tests to check what src/gif.js writes (frames, palettes, delays, loop).
export function decodeGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => u8() | (u8() << 8);
  const sig = String.fromCharCode(...bytes.slice(0, 6));
  p = 6;
  const width = u16();
  const height = u16();
  const flags = u8();
  p += 2;
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  const frames = [];
  let delay = 0;
  let loop = null;
  const subBlocks = () => {
    const parts = [];
    for (let n = u8(); n; n = u8()) {
      parts.push(bytes.slice(p, p + n));
      p += n;
    }
    const all = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
    let o = 0;
    for (const b of parts) {
      all.set(b, o);
      o += b.length;
    }
    return all;
  };
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      const data = subBlocks();
      if (label === 0xf9) delay = (data[1] | (data[2] << 8)) * 10;
      // NETSCAPE2.0: an 11-byte identifier block, then [1, loop lo, loop hi] (joined by subBlocks).
      if (label === 0xff && String.fromCharCode(...data.slice(0, 11)) === 'NETSCAPE2.0') loop = data[12] | (data[13] << 8);
      continue;
    }
    if (b !== 0x2c) throw new Error(`bad block 0x${b.toString(16)} at ${p - 1}`);
    p += 8;
    const f = u8();
    const size = 1 << ((f & 7) + 1);
    const palette = bytes.slice(p, p + size * 3);
    p += size * 3;
    const min = u8();
    const data = subBlocks();
    frames.push({ delay, palette, indices: lzwDecode(data, min, width * height) });
  }
  return { sig, width, height, frames, loop };
}

function lzwDecode(data, min, expected) {
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i += 1) dict.push([i]);
    dict.push(null, null);
    size = min + 1;
  };
  reset();
  const out = [];
  let bit = 0;
  let prev = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i += 1, bit += 1) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return code;
  };
  while (bit + size <= data.length * 8) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (prev === null) entry = dict[code];
    else if (code < dict.length) {
      entry = dict[code];
      if (dict.length < 4096) dict.push([...dict[prev], entry[0]]);
    } else {
      entry = [...dict[prev], dict[prev][0]];
      dict.push(entry);
    }
    out.push(...entry);
    prev = code;
    if (dict.length === 1 << size && size < 12) size += 1;
  }
  if (out.length !== expected) throw new Error('decoded ' + out.length + ' pixels, expected ' + expected);
  return Uint8Array.from(out);
}

