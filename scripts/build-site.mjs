/**
 * Assembles the static landing page into _site/.
 *
 * Shared by the Vercel deploy and the GitHub Pages workflow so both serve
 * byte-identical output from a single source of truth.
 */

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, '_site');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await cp(resolve(root, 'site'), out, { recursive: true });
await cp(resolve(root, 'brand'), resolve(out, 'brand'), { recursive: true });

// Stops GitHub Pages running the output through Jekyll, which would drop
// files and directories beginning with an underscore.
await writeFile(resolve(out, '.nojekyll'), '');

await writeFile(
  resolve(out, 'version.json'),
  JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2) + '\n'
);

console.log('Built site v' + pkg.version + ' into _site/');
