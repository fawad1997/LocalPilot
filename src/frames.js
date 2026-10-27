// Where an iframe sits in the top-level viewport.
//
// A click point that a page script measured inside an iframe is relative to that frame; CDP
// input needs top-level viewport pixels. CDP answers this exactly: the owner element's box
// from DOM.getBoxModel is already in main-frame coordinates, even for a cross-origin or nested
// frame (checked in Chrome), so one DOM.getFrameOwner + DOM.getBoxModel per frame is enough and
// there is no URL matching to get wrong after a redirect.
//
// The scripting fallback walks the parent chain and matches each <iframe> by URL; it is used
// only when the DOM domain cannot answer (a frame without layout, a sandboxed frame).
import { send } from './cdp.js';

async function domOffset(tabId, frameId) {
  const { backendNodeId } = await send(tabId, 'DOM.getFrameOwner', { frameId }, { timeoutMs: 5000 });
  const { model } = await send(tabId, 'DOM.getBoxModel', { backendNodeId }, { timeoutMs: 5000 });
  const quad = model?.content || model?.border;
  if (!quad || quad.length < 8) throw new Error('the frame has no box');
  return { x: quad[0], y: quad[1] };
}

async function scriptOffset(tabId, frameId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  let x = 0;
  let y = 0;
  for (let cur = byId.get(frameId); cur && cur.frameId !== 0; cur = byId.get(cur.parentFrameId)) {
    const siblings = frames.filter((f) => f.parentFrameId === cur.parentFrameId && f.url === cur.url).sort((a, b) => a.frameId - b.frameId);
    const index = siblings.findIndex((f) => f.frameId === cur.frameId);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [cur.parentFrameId] },
      func: (url, i) => {
        const same = [...document.querySelectorAll('iframe, frame')].filter((f) => {
          try {
            return new URL(f.src || 'about:blank', location.href).href === url || (!f.src && url.startsWith('about:'));
          } catch {
            return false;
          }
        });
        const el = same[i] || same[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + el.clientLeft, y: r.top + el.clientTop };
      },
      args: [cur.url, Math.max(0, index)],
    });
    if (!res?.result) throw new Error(`Could not locate frame ${frameId} on the page.`);
    x += res.result.x;
    y += res.result.y;
  }
  return { x, y };
}

// Offset of a frame's viewport inside the top-level viewport (CSS px). Throws when the frame
// cannot be located (e.g. it went away while loading).
export async function frameOffset(tabId, frameId) {
  if (!frameId) return { x: 0, y: 0 };
  try {
    return await domOffset(tabId, frameId);
  } catch {
    return scriptOffset(tabId, frameId);
  }
}
