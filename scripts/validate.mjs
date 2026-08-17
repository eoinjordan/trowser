/**
 * Release gate for dist/.
 *
 * A Chrome extension fails at load time, in the user's browser, for mistakes a
 * bundler is happy to emit: a content script built as ESM, a manifest pointing
 * at a file that was never copied, a CSP missing the origin a backend needs, or
 * a secret accidentally inlined. This checks all of that before anything ships.
 *
 * Exits non-zero with a list of failures, so CI can depend on it.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

if (!existsSync(dist)) {
  console.error('dist/ does not exist. Run: npm run build');
  process.exit(1);
}

/* ------------------------------------------------------------- manifest -- */

const manifestPath = resolve(dist, 'manifest.json');
let manifest;

try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error('manifest.json is not valid JSON: ' + error.message);
  process.exit(1);
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest_version must be 3, got ' + manifest.manifest_version);
if (manifest.version !== pkg.version) fail(`manifest version (${manifest.version}) does not match package.json (${pkg.version})`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version ?? '')) fail('manifest version must be 1-4 dot-separated integers, got ' + manifest.version);
if (!manifest.name) fail('manifest is missing name');
if (!manifest.description) fail('manifest is missing description');
if ((manifest.description ?? '').length > 132) fail('manifest description exceeds the 132 character store limit');

/* ------------------------------------------- referenced files must exist -- */

const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {})
].filter(Boolean);

for (const file of referenced) {
  if (!existsSync(resolve(dist, file))) fail('manifest references a missing file: ' + file);
}

// content.js is injected programmatically, so the manifest does not list it.
if (!existsSync(resolve(dist, 'content.js'))) fail('content.js is missing from dist');

/* -------------------------------------------- content script must be IIFE -- */

const contentSource = await readFile(resolve(dist, 'content.js'), 'utf8');

if (/^\s*(import|export)\s/m.test(contentSource)) {
  fail('content.js contains top-level import/export. Content scripts must be bundled as IIFE.');
}
if (/\bimport\s*\(/.test(contentSource)) {
  fail('content.js uses dynamic import, which is unavailable in an injected classic script.');
}

/* ------------------------------------------------------------------ CSP -- */

const csp = manifest.content_security_policy?.extension_pages ?? '';

if (!csp) {
  fail('extension_pages CSP is missing');
} else {
  if (!/script-src[^;]*'self'/.test(csp)) fail("CSP script-src must include 'self'");
  if (/'unsafe-eval'/.test(csp)) fail("CSP must not allow 'unsafe-eval'");
  if (/script-src[^;]*\*/.test(csp)) fail('CSP script-src must not use a wildcard');

  // Every backend and integration needs its origin reachable from the page.
  const requiredConnect = [
    ['http://localhost:*', 'Ollama and local OpenAI-compatible servers'],
    ['http://127.0.0.1:*', 'Ollama and local OpenAI-compatible servers'],
    ['https://huggingface.co', 'WebLLM weights and model search'],
    ['https://api.github.com', 'GitHub sign-in'],
    ['https://openidconnect.googleapis.com', 'Google sign-in']
  ];

  for (const [origin, why] of requiredConnect) {
    if (!csp.includes(origin)) fail(`CSP connect-src is missing ${origin} (needed for ${why})`);
  }

  if (!/'wasm-unsafe-eval'/.test(csp)) {
    fail("CSP must allow 'wasm-unsafe-eval' or WebLLM cannot compile its WebGPU kernels");
  }
}

/* ---------------------------------------------------------- permissions -- */

const permissions = manifest.permissions ?? [];
const overreaching = ['<all_urls>', 'http://*/*', 'https://*/*', 'webRequest', 'debugger', 'nativeMessaging'];

for (const permission of [...permissions, ...(manifest.host_permissions ?? [])]) {
  if (overreaching.includes(permission)) {
    fail('manifest requests an overreaching permission: ' + permission + '. Use optional_host_permissions instead.');
  }
}

if (!permissions.includes('activeTab')) fail('activeTab permission is required for the page bridge');
if ((manifest.host_permissions ?? []).length > 0) {
  note('host_permissions is non-empty; prefer optional_host_permissions so nothing is granted up front');
}

/* -------------------------------------------------------------- secrets -- */

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{24,}/, 'an OpenAI-style API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bhf_[A-Za-z0-9]{30,}/, 'a Hugging Face token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id']
];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let totalBytes = 0;

for await (const file of walk(dist)) {
  totalBytes += (await stat(file)).size;

  // Source maps legitimately embed test fixtures; scan shipped code only.
  if (file.endsWith('.map')) continue;
  if (!/\.(js|html|css|json)$/.test(file)) continue;

  const source = await readFile(file, 'utf8');
  for (const [pattern, description] of SECRET_PATTERNS) {
    if (pattern.test(source)) fail(`${relative(dist, file)} appears to contain ${description}`);
  }
}

/* ----------------------------------------------------------------- size -- */

const megabytes = totalBytes / (1024 * 1024);
note(`dist/ is ${megabytes.toFixed(1)} MB`);

// The Chrome Web Store rejects packages above 2 GB, but a build this far past
// expectation almost always means something was bundled twice.
if (megabytes > 60) fail(`dist/ is ${megabytes.toFixed(1)} MB, which is far larger than expected`);

/* ---------------------------------------------------------------- html -- */

for (const page of ['sidepanel.html', 'options.html']) {
  const html = await readFile(resolve(dist, page), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);

  for (const src of scripts) {
    if (/^https?:/.test(src)) fail(`${page} loads a remote script (${src}), which the CSP forbids`);
    else if (!existsSync(resolve(dist, src))) fail(`${page} references a missing script: ${src}`);
  }

  if (/\son\w+\s*=/.test(html)) fail(`${page} contains an inline event handler, which the CSP forbids`);
}

/* --------------------------------------------------------------- report -- */

for (const message of notes) console.log('note: ' + message);

if (failures.length) {
  console.error('\ndist validation failed:\n');
  for (const message of failures) console.error('  x ' + message);
  console.error('');
  process.exit(1);
}

console.log('\ndist validation passed: ' + referenced.length + ' referenced files, CSP and permissions checked.');
