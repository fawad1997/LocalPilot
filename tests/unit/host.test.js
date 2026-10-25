import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHandlers, toCsv, resolveInRoot } from '../../host/localpilot-host.mjs';
import { extensionIdFromKey } from '../../host/install.mjs';

const HOST = fileURLToPath(new URL('../../host/localpilot-host.mjs', import.meta.url));
let dir;
let cfg;
let h;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-host-'));
  fs.mkdirSync(path.join(dir, 'jobs', 'China'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'nope');
  fs.writeFileSync(path.join(dir, 'jobs', 'echo.mjs'), 'console.log(JSON.stringify(process.argv.slice(2))); console.error("warn"); process.exit(process.argv[2] === "fail" ? 3 : 0);');
  cfg = {
    roots: [{ name: 'jobs', path: path.join(dir, 'jobs'), writable: true }, { name: 'ro', path: path.join(dir, 'outside'), writable: false }],
    scripts: [{ name: 'echo', root: 'jobs', file: 'echo.mjs', description: 'test' }],
    maxReadBytes: 1024,
    scriptTimeoutMs: 10000,
  };
  h = createHandlers(cfg);
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('sandbox rejects escapes', () => {
  assert.throws(() => resolveInRoot(cfg, 'jobs', '../outside/secret.txt'), /escapes root/);
  assert.throws(() => resolveInRoot(cfg, 'jobs', 'C:\\Windows\\win.ini'), /relative/);
  assert.throws(() => resolveInRoot(cfg, 'jobs', 'a.txt:stream'), /relative/);
  assert.throws(() => resolveInRoot(cfg, 'nope', 'x'), /Unknown root/);
  assert.ok(resolveInRoot(cfg, 'jobs', 'China/new/dir/file.csv').abs.endsWith(path.join('China', 'new', 'dir', 'file.csv')));
});

test('sandbox rejects junction/symlink escapes', (t) => {
  const link = path.join(dir, 'jobs', 'link');
  try {
    fs.symlinkSync(path.join(dir, 'outside'), link, 'junction');
  } catch {
    t.skip('cannot create junction here');
    return;
  }
  assert.throws(() => h.read_file({ root: 'jobs', path: 'link/secret.txt' }), /outside root/);
});

test('write rules: allowed types, no overwrite, read-only roots', () => {
  const res = h.write_file({ root: 'jobs', path: 'China/a.json', content: '{}' });
  assert.equal(res.bytes, 2);
  assert.throws(() => h.write_file({ root: 'jobs', path: 'China/a.json', content: '{}' }), /already exists/);
  assert.ok(h.write_file({ root: 'jobs', path: 'China/a.json', content: '[]', overwrite: true }));
  assert.throws(() => h.write_file({ root: 'jobs', path: 'evil.mjs', content: 'x' }), /not allowed/);
  assert.throws(() => h.write_file({ root: 'jobs', path: 'run.bat', content: 'x' }), /not allowed/);
  assert.throws(() => h.write_file({ root: 'ro', path: 'x.txt', content: 'x' }), /read-only/);
});

test('csv: BOM, quoting, Chinese text, arrays', () => {
  h.write_csv({ root: 'jobs', path: 'China/jobs.csv', rows: [{ title: '全栈工程师', note: 'a, "b"\nc', tags: ['x', 'y'] }] });
  const raw = fs.readFileSync(path.join(dir, 'jobs', 'China', 'jobs.csv'), 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff);
  assert.equal(raw.slice(1), 'title,note,tags\r\n全栈工程师,"a, ""b""\nc",x; y\r\n');
  assert.equal(toCsv(['a'], [{ a: null }]), 'a\r\n\r\n');
});

test('read_file caps size and list_dir hides dotfiles', () => {
  fs.writeFileSync(path.join(dir, 'jobs', 'big.txt'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'jobs', '.env'), 'SECRET=1');
  const r = h.read_file({ root: 'jobs', path: 'big.txt' });
  assert.equal(r.content.length, 1024);
  assert.equal(r.truncated, true);
  const names = h.list_dir({ root: 'jobs' }).entries.map((e) => e.name);
  assert.ok(names.includes('big.txt'));
  assert.ok(!names.includes('.env'));
});

test('run_script: allowlist, args, exit code, no shell', async () => {
  const ok = await h.run_script({ name: 'echo', args: ['build', 'China/x.json', '& calc'] });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), '["build","China/x.json","& calc"]');
  assert.equal(ok.stderr.trim(), 'warn');
  const bad = await h.run_script({ name: 'echo', args: ['fail'] });
  assert.equal(bad.exitCode, 3);
  assert.throws(() => h.run_script({ name: 'rm', args: [] }), /not allowlisted/);
});

test('resolve_path and import_download stay sandboxed', () => {
  const dl = path.join(dir, 'dl');
  fs.mkdirSync(dl, { recursive: true });
  fs.writeFileSync(path.join(dl, 'report.pdf'), 'pdf');
  fs.writeFileSync(path.join(dl, 'evil.exe'), 'x');
  fs.writeFileSync(path.join(dir, 'jobs', 'cv.pdf'), 'cv');
  const hh = createHandlers({ ...cfg, downloadsDir: dl });
  assert.equal(hh.resolve_path({ root: 'jobs', path: 'cv.pdf' }).size, 2);
  assert.throws(() => hh.resolve_path({ root: 'jobs', path: 'nope.pdf' }), /not a file/);
  assert.throws(() => hh.resolve_path({ root: 'jobs', path: '../outside/secret.txt' }), /escapes root/);
  const res = hh.import_download({ src: path.join(dl, 'report.pdf'), root: 'jobs', path: 'downloads/report.pdf' });
  assert.equal(fs.readFileSync(res.path, 'utf8'), 'pdf');
  assert.throws(() => hh.import_download({ src: path.join(dl, 'evil.exe'), root: 'jobs' }), /not allowed/);
  assert.throws(() => hh.import_download({ src: path.join(dir, 'outside', 'secret.txt'), root: 'jobs', path: 's.txt' }), /Only files from/);
  assert.throws(() => hh.import_download({ src: path.join(dl, 'report.pdf'), root: 'jobs', path: 'downloads/report.pdf' }), /already exists/);
});

test('extension id derivation matches Chrome scheme', () => {
  // ID uses letters a-p only and is 32 chars.
  assert.match(extensionIdFromKey(Buffer.from('test-key').toString('base64')), /^[a-p]{32}$/);
});

test('stdio framing end to end', async () => {
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const child = spawn(process.execPath, [HOST, 'chrome-extension://abc/'], { env: { ...process.env, LOCALPILOT_HOST_CONFIG: cfgFile, LOCALPILOT_NO_RELAY: "1" } });
  const frame = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    return Buffer.concat([head, body]);
  };
  const replies = [];
  let buf = Buffer.alloc(0);
  const done = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        replies.push(JSON.parse(buf.subarray(4, 4 + len).toString()));
        buf = buf.subarray(4 + len);
        if (replies.length === 3) resolve();
      }
    });
  });
  // Two messages in one write exercise the buffering path.
  child.stdin.write(Buffer.concat([frame({ id: 1, method: 'hello' }), frame({ id: 2, method: 'list_dir', params: { root: 'jobs' } })]));
  child.stdin.write(frame({ id: 3, method: 'read_file', params: { root: 'jobs', path: '../outside/secret.txt' } }));
  await done;
  child.stdin.end();
  assert.equal(replies[0].result.roots[0].name, 'jobs');
  assert.equal(replies[1].ok, true);
  assert.equal(replies[2].ok, false);
  assert.match(replies[2].error, /escapes root/);
});

test('search finds files by name pattern and by text, inside the root only', () => {
  fs.mkdirSync(path.join(dir, 'jobs', 'Europe', 'Acme'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', 'Europe', 'Acme', 'CV_Fawad.pdf'), 'pdf');
  fs.writeFileSync(path.join(dir, 'jobs', 'Europe', 'log.md'), 'one\nApplied to Acme\nthree');
  fs.mkdirSync(path.join(dir, 'jobs', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jobs', 'node_modules', 'cv.md'), 'Applied to Acme');
  const byName = h.search({ root: 'jobs', name: 'cv_*.pdf' });
  assert.deepEqual(byName.results.map((r) => r.path), [path.join('Europe', 'Acme', 'CV_Fawad.pdf')]);
  const byText = h.search({ root: 'jobs', text: 'applied to acme' });
  assert.deepEqual(byText.results.map((r) => [r.path, r.line, r.snippet]), [[path.join('Europe', 'log.md'), 2, 'Applied to Acme']]);
  const dirs = h.search({ root: 'jobs', name: 'acme' });
  assert.deepEqual(dirs.results.map((r) => [r.path, r.type]), [[path.join('Europe', 'Acme'), 'dir']]);
  assert.throws(() => h.search({ root: 'jobs' }), /Give name/);
  assert.throws(() => h.search({ root: 'jobs', path: '../outside', name: 'secret' }), /escapes root/);
  assert.equal(h.search({ root: 'jobs', name: 'e', limit: 2 }).results.length, 2);
});
