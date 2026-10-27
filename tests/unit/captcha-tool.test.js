// The solver tool is only offered when CAPTCHA solving is turned on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// tools.js pulls in modules that register chrome.* listeners at load; stub them.
const store = {};
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => Promise.resolve({}) });
globalThis.chrome = new Proxy({}, {
  get: (t, k) => (k === 'storage'
    ? new Proxy({ local: { get: async (key) => ({ [key]: store[key] }), set: async (obj) => Object.assign(store, obj) } }, { get: (s, key) => s[key] ?? stub })
    : stub),
});
const { toolDefinitions } = await import('../../src/tools.js');
const { DEFAULTS } = await import('../../src/settings.js');

const names = (settings) => toolDefinitions(settings, null, []).map((d) => d.name);

test('CAPTCHA solving is off by default, and can be switched on in Settings', () => {
  assert.equal(DEFAULTS.captchaSolver, false, 'a fresh install never solves CAPTCHAs');
  const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
  assert.match(html, /id="captchaSolver"/, 'the option exists in the Settings page');
  assert.match(html, /Try to solve CAPTCHA checks myself/);
});

test('captcha_solve is defined only with CAPTCHA solving on', () => {
  assert.ok(!names({}).includes('captcha_solve'), 'off by default');
  assert.ok(!names({ captchaSolver: false }).includes('captcha_solve'));
  const on = names({ captchaSolver: true });
  assert.ok(on.includes('captcha_solve'));
  assert.ok(on.includes('computer'), 'the other tools are still there');
});
