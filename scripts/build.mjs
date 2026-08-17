/**
 * Build.
 *
 * Two passes, because the two contexts have incompatible module requirements:
 *
 *   1. content.ts  -> IIFE. Content scripts injected via chrome.scripting are
 *                     classic scripts and cannot use ESM imports.
 *   2. everything   -> ESM with code splitting, so the WebLLM bundle becomes a
 *      else            lazily loaded chunk instead of bloating every page.
 *
 * The manifest version is taken from package.json so a release only has to bump
 * one file.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
const minify = !process.argv.includes('--no-minify');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

const shared = {
  bundle: true,
  target: 'chrome116',
  sourcemap: true,
  minify,
  logLevel: 'info',
  define: { __TROWSER_VERSION__: JSON.stringify(pkg.version) }
};

/** Copies static assets and syncs the manifest version with package.json. */
async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp(resolve(root, 'public'), outdir, { recursive: true });

  for (const file of ['sidepanel.html', 'sidepanel.css', 'options.html', 'options.css']) {
    await cp(resolve(root, 'src', file), resolve(outdir, file));
  }

  const manifestPath = resolve(outdir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const pageOptions = {
  ...shared,
  entryPoints: {
    background: resolve(root, 'src/background.ts'),
    sidepanel: resolve(root, 'src/sidepanel.ts'),
    options: resolve(root, 'src/options.ts')
  },
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  outdir
};

const contentOptions = {
  ...shared,
  entryPoints: { content: resolve(root, 'src/content.ts') },
  // Content scripts are classic scripts; ESM output would fail to inject.
  format: 'iife',
  splitting: false,
  outdir
};

if (watch) {
  await rm(outdir, { recursive: true, force: true });
  await copyStatic();

  const contexts = await Promise.all([context(pageOptions), context(contentOptions)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Trowser is watching for changes. Reload the extension in chrome://extensions after each build.');
} else {
  await rm(outdir, { recursive: true, force: true });
  await copyStatic();
  await Promise.all([build(pageOptions), build(contentOptions)]);
  console.log('Built Trowser v' + pkg.version + ' into dist/');
}
