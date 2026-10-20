import { test } from 'node:test';
import assert from 'node:assert/strict';

const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => Promise.resolve({}) });
globalThis.chrome = stub;
const st = await import('../../src/sitetest.js');
const rec = await import('../../src/recorder.js');

test('testing mode: the crawler stays on the site and avoids actions and files', () => {
  const o = 'https://shop.test';
  assert.equal(st.crawlable('https://shop.test/products?page=2', o), true);
  assert.equal(st.crawlable('https://other.test/', o), false);
  for (const bad of ['/logout', '/account/sign-out', '/items/4/delete', '/cart/add?id=3', '/checkout', '/files/manual.pdf', '/img/a.JPG']) {
    assert.equal(st.crawlable(`${o}${bad}`, o), false, bad);
  }
  assert.equal(st.normalizeLink('/about#team', 'https://shop.test/x'), 'https://shop.test/about');
  assert.equal(st.normalizeLink('mailto:a@b.c', 'https://shop.test/'), null);
  assert.equal(st.pageKey('https://shop.test/index.html'), st.pageKey('https://shop.test/'));
  assert.equal(st.pageKey('https://shop.test/a/index.htm?x=1'), 'https://shop.test/a/?x=1');
});

test('testing mode: capped examples still add up to the real count per type', () => {
  const ex = [{ type: 'missing-alt' }, { type: 'missing-alt' }, { type: 'bug-text' }];
  const out = st.exampleCounts(ex, { 'missing-alt': 12, 'bug-text': 1 });
  assert.deepEqual(out.map((i) => i.count), [11, 1, 1]);
  const issues = [{ severity: 'warning', count: 11 }, { severity: 'warning', count: 1 }, { severity: 'error' }];
  assert.deepEqual(st.countBy(issues), { error: 1, warning: 12, info: 0 });
  assert.deepEqual(st.sortIssues([{ severity: 'info', type: 'a' }, { severity: 'error', type: 'z' }]).map((i) => i.severity), ['error', 'info']);
});

test('testing mode: the report escapes page content and explains each problem type', () => {
  const html = st.reportHtml({
    origin: 'https://shop.test', startedAt: Date.UTC(2026, 9, 20), durationMs: 5000, version: '0.7.0',
    pages: [{ url: 'https://shop.test/', title: '<script>alert(1)</script>', status: 200, loadMs: 1200, shot: 'AAAA' }],
    issues: [{ severity: 'error', type: 'bug-text', page: 'https://shop.test/', detail: 'Visible "undefined" in: "<b>Price: undefined</b>"', count: 1 }],
    linkCheck: [{ url: 'https://shop.test/missing', status: 404, text: 'Old page', from: 'https://shop.test/' }],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'page titles are escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;undefined&quot; \/ &quot;NaN&quot; \/ template text on screen/);
  assert.match(html, /<b>1<\/b>errors/);
  assert.match(html, /Broken or unreachable links[\s\S]*shop\.test\/missing/);
  const data = JSON.parse(html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.pages[0].shot, undefined, 'screenshots are not duplicated in the JSON');
  assert.ok(!/<\/script>alert/.test(html));
});

test('recorder: captions, which actions are recorded, frame cap, file names', () => {
  assert.equal(rec.describeAction('computer', { action: 'left_click', ref: 'ref_7' }), 'Click ref_7');
  assert.equal(rec.describeAction('computer', { action: 'left_click', ref: 'ref_7' }, 'Add to cart'), 'Click "Add to cart"');
  assert.equal(rec.describeAction('computer', { action: 'type', text: 'hello world' }), 'Type "hello world"');
  assert.equal(rec.describeAction('navigate', { url: 'https://example.com/a' }), 'Open https://example.com/a');
  assert.equal(rec.describeAction('form_input', { ref: 'ref_2', value: 'Ada' }), 'Fill ref_2 with "Ada"');
  assert.equal(rec.recordsAfter('computer', { action: 'screenshot' }), false);
  assert.equal(rec.recordsAfter('computer', { action: 'scroll' }), true);
  assert.equal(rec.recordsAfter('read_page', {}), false);
  assert.equal(rec.recordsAfter('extract_list', { pages: 3 }), true);
  const r = { frames: [] };
  for (let i = 0; i < rec.MAX_FRAMES + 5; i += 1) rec.addFrame(r, { action: `a${i}` });
  assert.equal(r.frames.length, rec.MAX_FRAMES);
  assert.equal(r.frames[0].action, 'a0', 'the first frame is kept');
  assert.equal(r.frames.at(-1).action, `a${rec.MAX_FRAMES + 4}`);
  assert.equal(rec.safeFileName('https://shop.test/a b?c=1'), 'shop.test-a-b-c-1');
  assert.equal(rec.toBase64('hé'), Buffer.from('hé').toString('base64'));
  assert.match(rec.stamp(new Date(2026, 9, 20, 9, 5, 7)), /^2026-10-20_090507$/);
});
