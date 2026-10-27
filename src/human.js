// Human-like pointer input over Chrome DevTools Protocol.
//
// Input.dispatchMouseEvent produces trusted events, so a page cannot tell a CDP click from a
// real one by looking at isTrusted. What gives automation away is the shape of the input:
// teleporting to the target, an instant press/release with no hover, and perfectly straight
// lines. These helpers draw a slightly curved path, ease out, jitter every step, hover, hold
// the button for a human moment and release with a tiny drift, the way SeleniumBase's CDP mode
// (undetected-testing) clicks CAPTCHA checkboxes.
import { send } from './cdp.js';

export const rand = (min, max) => min + Math.random() * (max - min);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome sometimes never answers Input.dispatchMouseEvent aimed at an out-of-process iframe,
// even though the event is delivered (measured: a CAPTCHA iframe click that passed while the
// command's promise hung). SeleniumBase's CDP mode sends its clicks without waiting for the
// answer for the same reason. So these are fire-and-forget: order is kept by the single CDP
// channel and by the pauses, and success is checked on the page afterwards.
const dispatch = (tabId, params) => {
  send(tabId, 'Input.dispatchMouseEvent', params).catch(() => {});
};

// Last pointer position per tab: the next move starts where the previous one ended.
const lastPoint = new Map(); // tabId -> [x, y]

// Points of a slightly bowed path from one point to another, with jitter. Pure, so tests can
// check it: it starts at `from`, ends at `to`, and every step moves closer.
export function mousePath(from, to, { steps = 24, jitter = 0.7, bend = null } = {}) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const nx = dist ? -dy / dist : 0;
  const ny = dist ? dx / dist : 0;
  const curve = (bend ?? Math.min(48, dist * 0.07)) * (Math.random() < 0.5 ? -1 : 1);
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    if (i === steps) {
      points.push([x1, y1]); // land exactly on the target, without float noise
      break;
    }
    const t = i / steps;
    const eased = 1 - (1 - t) * (1 - t); // easeOutQuad: fast start, slow arrival
    const arc = Math.sin(Math.PI * eased) * curve * 0.5;
    points.push([
      x0 + dx * eased + nx * arc + rand(-jitter, jitter),
      y0 + dy * eased + ny * arc + rand(-jitter, jitter),
    ]);
  }
  return points;
}

// Move the mouse to (x, y) along a human path. Returns the time spent moving.
export async function humanMove(tabId, x, y, { durationMs } = {}) {
  const from = lastPoint.get(tabId) || [Math.max(4, x - rand(120, 320)), Math.max(4, y - rand(80, 200))];
  const dist = Math.hypot(x - from[0], y - from[1]);
  const steps = dist < 8 ? 1 : Math.max(8, Math.min(38, Math.round(dist / rand(16, 28))));
  const duration = durationMs ?? Math.min(750, Math.max(150, dist * rand(0.9, 1.7)));
  const points = mousePath(from, [x, y], { steps });
  const gap = duration / points.length;
  for (const [px, py] of points) {
    dispatch(tabId, { type: 'mouseMoved', x: px, y: py, buttons: 0 });
    await sleep(gap * rand(0.65, 1.45));
  }
  lastPoint.set(tabId, [x, y]);
  return duration;
}

// A human click: move, hover, press, hold, release. `holdMs` > 0 keeps the button down and
// wiggles slightly (needed by "press and hold" checks).
export async function humanClick(tabId, x, y, { button = 'left', clickCount = 1, holdMs = 0 } = {}) {
  await humanMove(tabId, x, y);
  await sleep(rand(40, 110)); // hover before pressing
  // The hand is never perfectly still: settle with a sub-pixel move first.
  dispatch(tabId, { type: 'mouseMoved', x: x + rand(-0.7, 0.7), y: y + rand(-0.7, 0.7), buttons: 0 });
  await sleep(rand(8, 26));
  for (let i = 1; i <= clickCount; i += 1) {
    const px = x + rand(-0.8, 0.8);
    const py = y + rand(-0.8, 0.8);
    dispatch(tabId, { type: 'mousePressed', x: px, y: py, button, buttons: 1, clickCount: i, force: 0.5 });
    if (holdMs > 0 && i === clickCount) {
      const end = Date.now() + holdMs;
      while (Date.now() < end) {
        dispatch(tabId, {
          type: 'mouseMoved', x: px + rand(-1.4, 1.4), y: py + rand(-1.4, 1.4), button, buttons: 1,
        });
        await sleep(rand(90, 190));
      }
    } else {
      await sleep(rand(45, 110));
    }
    dispatch(tabId, { type: 'mouseReleased', x: px, y: py, button, buttons: 0, clickCount: i, force: 0 });
    if (i < clickCount) await sleep(rand(55, 120));
  }
  // Drift away from the click point, as a hand does when it lifts.
  dispatch(tabId, { type: 'mouseMoved', x: x + rand(2, 9), y: y + rand(1, 7), buttons: 0 });
  lastPoint.set(tabId, [x, y]);
}

// Press and hold in one place, for "press and hold" checks (PerimeterX, DataDome).
export async function humanHold(tabId, x, y, holdMs = 10000) {
  await humanClick(tabId, x, y, { holdMs });
}

// Drag along a slow curved path with a small overshoot that settles back, for sliders.
export async function humanDrag(tabId, from, to, { durationMs = rand(600, 950), overshoot = rand(10, 24) } = {}) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  await humanMove(tabId, x0, y0);
  await sleep(rand(60, 140));
  dispatch(tabId, { type: 'mouseMoved', x: x0 + rand(-0.6, 0.6), y: y0 + rand(-0.6, 0.6), buttons: 0 });
  dispatch(tabId, { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1, force: 0.5 });
  await sleep(rand(70, 150));
  const endX = x1 + overshoot;
  const steps = Math.max(14, Math.min(34, Math.round(Math.abs(endX - x0) / 7)));
  const points = mousePath([x0, y0], [endX, y1], { steps, jitter: 1.2, bend: Math.min(18, Math.abs(endX - x0) * 0.04) });
  const gap = durationMs / points.length;
  for (const [px, py] of points) {
    dispatch(tabId, { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1 });
    await sleep(gap * rand(0.7, 1.3));
  }
  await sleep(rand(120, 260)); // let the site catch up, then settle onto the target
  dispatch(tabId, { type: 'mouseMoved', x: x1 + rand(-1, 1), y: y1 + rand(-1, 1), button: 'left', buttons: 1 });
  await sleep(rand(60, 130));
  dispatch(tabId, { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1, force: 0 });
  dispatch(tabId, { type: 'mouseMoved', x: x1 + rand(3, 10), y: y1 + rand(2, 8), buttons: 0 });
  lastPoint.set(tabId, [x1, y1]);
}
