/**
 * Build script: bundles code.ts → dist/code.js, ui.ts → dist/ui.html (inline).
 *
 * Usage: node build.mjs [--watch]
 */
import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const outDir = resolve(__dirname, 'dist');
await mkdir(outDir, { recursive: true });

/** Build the plugin main thread (sandboxed Figma runtime). */
const codeConfig = {
  entryPoints: [resolve(__dirname, 'src/code.ts')],
  bundle: true,
  outfile: resolve(outDir, 'code.js'),
  target: 'es2017',
  platform: 'browser',
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
};

/** Build the UI bundle, then inline into dist/ui.html. */
async function buildUi() {
  await build({
    entryPoints: [resolve(__dirname, 'src/ui.ts')],
    bundle: true,
    outfile: resolve(outDir, 'ui.bundle.js'),
    target: 'es2017',
    platform: 'browser',
    format: 'iife',
    legalComments: 'none',
    logLevel: 'silent',
  });
  const html = await readFile(resolve(__dirname, 'src/ui.html'), 'utf8');
  const js = await readFile(resolve(outDir, 'ui.bundle.js'), 'utf8');
  const inlined = html.replace('/* PLUGIN_UI_BUNDLE */', js);
  await writeFile(resolve(outDir, 'ui.html'), inlined);
  await writeFile(resolve(outDir, 'manifest.json'), await readFile(resolve(__dirname, 'manifest.json'), 'utf8'));
}

if (watch) {
  const ctx = await context(codeConfig);
  await ctx.watch();
  await buildUi();
  console.log('[plugin] watching for changes...');
  // Re-build UI on every code build trigger (simple polling alternative)
  setInterval(buildUi, 1000).unref?.();
} else {
  await build(codeConfig);
  await buildUi();
  console.log('[plugin] build complete');
}
