/**
 * Test runner.
 *
 * Tests are written in TypeScript against the real source modules. esbuild
 * bundles each spec into a self-contained ESM file under .tmp/test, then the
 * built-in node:test runner executes them. This keeps the toolchain to a
 * single dev dependency and works identically on Node 20, 22 and 24.
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readdir, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testDir = resolve(root, 'test');
const outDir = resolve(root, '.tmp/test');

const entries = (await readdir(testDir, { recursive: true }))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join(testDir, name));

if (entries.length === 0) {
  console.error('No test files found in test/.');
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' },
  // node:test and node:assert must stay external so the runner can see them.
  // jsdom is a real node dependency and must not be inlined into the bundle.
  external: ['node:*', 'jsdom'],
  logLevel: 'warning'
});

// Node 20/21 only accept explicit file paths after --test, not a directory.
const built = (await readdir(outDir, { recursive: true }))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => join(outDir, name));

console.log(`Running ${built.length} test file(s) with node:test\n`);

const args = ['--test'];
if (process.argv.includes('--coverage')) args.push('--experimental-test-coverage');
args.push(...built);

const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: root });
child.on('exit', (code) => process.exit(code ?? 1));
