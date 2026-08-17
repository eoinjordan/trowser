/**
 * Packages dist/ into a store-ready ZIP plus a SHA-256 checksum file.
 * Release automation consumes both.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { createZip } from './zip.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const outDir = resolve(root, 'artifacts');

if (!existsSync(dist)) {
  console.error('dist/ does not exist. Run: npm run build');
  process.exit(1);
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const includeMaps = process.argv.includes('--include-sourcemaps');

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const entries = [];

for await (const file of walk(dist)) {
  // Source maps roughly triple the package size and are not useful in the
  // store build, so they are excluded unless explicitly requested.
  if (!includeMaps && file.endsWith('.map')) continue;
  entries.push({ name: relative(dist, file), data: await readFile(file) });
}

entries.sort((a, b) => a.name.localeCompare(b.name));

// A fixed timestamp keeps the archive byte-identical across rebuilds of the
// same commit, so the published checksum is reproducible.
const archive = createZip(entries, new Date('1980-01-01T00:00:00Z'));

await mkdir(outDir, { recursive: true });

const zipName = `trowser-${pkg.version}.zip`;
const zipPath = resolve(outDir, zipName);
const digest = createHash('sha256').update(archive).digest('hex');

await writeFile(zipPath, archive);
await writeFile(resolve(outDir, zipName + '.sha256'), `${digest}  ${zipName}\n`);

console.log(`Packaged ${entries.length} files into artifacts/${zipName}`);
console.log(`${(archive.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`sha256: ${digest}`);
