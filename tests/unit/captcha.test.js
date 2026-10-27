// Pure parts of the CAPTCHA solver and the human pointer path: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// cdp.js and logger.js touch chrome.* at module load; a stub is enough here.
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => Promise.resolve({}) });
globalThis.chrome = stub;
const cap = await import('../../src/captcha.js');
const human = await import('../../src/human.js');

test('human pointer: the path ends on the target, moves forward, and is not a straight teleport', () => {
  const from = [100, 100];
  const to = [500, 300];
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const ux = (to[0] - from[0]) / len;
  const uy = (to[1] - from[1]) / len;
  for (let run = 0; run < 25; run += 1) {
    const points = human.mousePath(from, to, { steps: 24 });
    assert.equal(points.length, 24);
    assert.deepEqual(points.at(-1), to, 'ends exactly on the target');
    const first = points[0];
    const firstLeg = Math.hypot(first[0] - from[0], first[1] - from[1]);
    assert.ok(firstLeg > 0, 'starts moving');
    assert.ok(firstLeg < len / 2, 'does not jump straight to the target');
    const projected = points.map(([x, y]) => (x - from[0]) * ux + (y - from[1]) * uy);
    for (let i = 1; i < projected.length; i += 1) {
      assert.ok(projected[i] >= projected[i - 1] - 2.5, `step ${i} moves forward (${projected[i - 1]} -> ${projected[i]})`);
    }
    assert.ok(projected.at(-1) >= len - 0.001, 'reaches the target along the direction');
  }
});

test('human pointer: with no bend the path stays near the line, and jitter differs per run', () => {
  const from = [0, 0];
  const to = [300, 0];
  const a = human.mousePath(from, to, { steps: 12, bend: 0, jitter: 0.7 });
  const b = human.mousePath(from, to, { steps: 12, bend: 0, jitter: 0.7 });
  for (const [, y] of a) assert.ok(Math.abs(y) <= 1.5, `stays near the line (${y})`);
  assert.notDeepEqual(a, b, 'each run is slightly different');
  assert.deepEqual(human.mousePath(from, to, { steps: 1 }), [to]);
});

test('captcha verdict: tokens mean solved; picture grids and unsupported checks need the user', () => {
  assert.equal(cap.verdict(null), 'none');
  assert.equal(cap.verdict({ tokens: {}, candidates: [], challengeText: false }), 'none');
  assert.equal(cap.verdict({ tokens: { turnstile: 40 }, candidates: [] }), 'solved');
  assert.equal(cap.verdict({ tokens: { turnstile: 12 }, candidates: [] }), 'none', 'empty tokens do not count');
  assert.equal(cap.verdict({ tokens: {}, imageChallenge: true, candidates: [{ provider: 'recaptcha' }] }), 'needs-user');
  assert.equal(cap.verdict({ tokens: {}, unsupported: 'arkose', candidates: [{ provider: 'arkose' }] }), 'unsupported');
  assert.equal(cap.verdict({ tokens: {}, candidates: [{ provider: 'turnstile' }] }), 'challenge');
  assert.equal(cap.verdict({ tokens: {}, candidates: [], challengeText: true }), 'challenge');
  assert.equal(cap.tokensPassed({ a: 13 }), true);
  assert.equal(cap.tokensPassed({ a: 12 }), false);
  assert.equal(cap.tokensPassed({}), false);
});

test('captcha description: says what is showing, and that an image grid is for the user', () => {
  const none = cap.describeChallenge({ tokens: {}, candidates: [], challengeText: false });
  assert.match(none, /No CAPTCHA or bot check/);
  const grid = cap.describeChallenge({ tokens: {}, imageChallenge: true, candidates: [{ provider: 'recaptcha' }] });
  assert.match(grid, /reCAPTCHA/);
  assert.match(grid, /needs you/);
  const arkose = cap.describeChallenge({ tokens: {}, unsupported: 'arkose', candidates: [] });
  assert.match(arkose, /cannot be solved by clicking/);
  const turnstile = cap.describeChallenge({ tokens: {}, candidates: [{ provider: 'turnstile', topPoint: { x: 120, y: 80 } }] });
  assert.match(turnstile, /Cloudflare Turnstile/);
  assert.match(turnstile, /\(120, 80\)/);
  const unreachable = cap.describeChallenge({ tokens: {}, candidates: [], challengeText: true });
  assert.match(unreachable, /not reachable/);
});

test('captcha providers: clicking helps on the checkbox-style ones, not on Arkose', () => {
  for (const p of ['turnstile', 'cloudflare-challenge', 'recaptcha', 'hcaptcha', 'geetest', 'aliyun-slider', 'datadome']) {
    assert.ok(cap.SOLVABLE.has(p), `${p} is click-solvable`);
  }
  assert.ok(!cap.SOLVABLE.has('arkose'));
  assert.ok(!cap.SOLVABLE.has('tencent-captcha'));
  assert.equal(cap.PROVIDER_LABELS.hcaptcha, 'hCaptcha');
});
