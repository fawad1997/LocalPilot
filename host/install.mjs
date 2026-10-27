// Registers the LocalPilot native messaging host for Chrome, Edge and Brave (current user).
//   node host/install.mjs              install / update
//   node host/install.mjs --uninstall  remove registry entries
//
// Also gives the unpacked extension a stable ID by adding a public "key" to
// manifest.json (once). Native messaging only accepts listed extension IDs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.localpilot.host';
const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HOST_DIR, '..');
const MANIFEST = path.join(ROOT, 'manifest.json');
const REG_PATHS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts', // Playwright's Chromium (tests)
];

const DEFAULT_CONFIG = {
  roots: [{ name: 'jobs', path: path.join(os.homedir(), 'LocalPilot', 'Jobs'), writable: true }],
  scripts: [
    {
      name: 'import-manual-jobs',
      root: 'jobs',
      file: 'import-manual-jobs.mjs',
      description: 'Normalise a draft JSON of hand-collected jobs into scraper shape. Args: ["build", "China/<draft>.json"]',
    },
  ],
  maxReadBytes: 1048576,
  scriptTimeoutMs: 120000,
};

export function extensionIdFromKey(base64Der) {
  const hash = crypto.createHash('sha256').update(Buffer.from(base64Der, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

function ensureExtensionKey() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!manifest.key) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    manifest.key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    // Private key is only needed to pack a .crx later; keep it out of version control.
    fs.writeFileSync(path.join(HOST_DIR, 'extension-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('Added a stable "key" to manifest.json. Reload the extension in chrome://extensions.');
  }
  return extensionIdFromKey(manifest.key);
}

function reg(args) {
  return execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function install() {
  const id = ensureExtensionKey();
  const configPath = path.join(HOST_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    console.log(`Wrote ${configPath} (edit roots/scripts there).`);
  }
  const launcher = path.join(HOST_DIR, 'localpilot-host.bat');
  fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0localpilot-host.mjs" %*\r\n`);
  const hostManifestPath = path.join(HOST_DIR, `${HOST_NAME}.json`);
  fs.writeFileSync(hostManifestPath, `${JSON.stringify({
    name: HOST_NAME,
    description: 'LocalPilot PC bridge',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2)}\n`);
  for (const key of REG_PATHS) {
    reg(['add', `${key}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', hostManifestPath, '/f']);
  }
  console.log(`Native host registered for Chrome, Edge and Brave.\n  extension id: ${id}\n  manifest:     ${hostManifestPath}`);
}

function uninstall() {
  for (const key of REG_PATHS) {
    try {
      reg(['delete', `${key}\\${HOST_NAME}`, '/f']);
    } catch {
      // not present
    }
  }
  console.log('Native host registry entries removed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') {
    console.error('This installer targets Windows. On macOS/Linux, place host/com.localpilot.host.json in the browser NativeMessagingHosts folder.');
    process.exit(1);
  }
  if (process.argv.includes('--uninstall')) uninstall();
  else install();
}
