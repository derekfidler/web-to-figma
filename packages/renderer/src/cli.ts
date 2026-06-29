/**
 * CLI: capture a URL and write JSON to disk. Used for fast iteration without
 * running the HTTP server.
 *
 *   npm run capture -- https://flatpay.com [viewport]
 *
 * viewport defaults to "desktop". Output written to ./captures/{slug}-{ts}.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture } from './capture.js';
import { getBrowser, closeBrowser } from './browser.js';
import { VIEWPORT_PRESETS } from '@web-to-figma/shared';

async function main() {
  const url = process.argv[2];
  const viewport = (process.argv[3] || 'desktop') as keyof typeof VIEWPORT_PRESETS;
  if (!url) {
    console.error('usage: npm run capture -- <url> [desktop|tablet|mobile]');
    process.exit(1);
  }

  console.log(`[cli] capturing ${url} at ${viewport}...`);
  const browser = await getBrowser();
  try {
    const result = await capture(browser, { url, viewport });
    await mkdir(resolve(process.cwd(), 'captures'), { recursive: true });
    const slug = new URL(url).hostname.replace(/[^a-z0-9]/gi, '-');
    const ts = result.meta.capturedAt.replace(/[:.]/g, '-');
    const outPath = resolve(process.cwd(), 'captures', `${slug}-${viewport}-${ts}.json`);
    await writeFile(outPath, JSON.stringify(result, null, 2));
    console.log(`[cli] ✓ ${result.meta.nodeCount} nodes in ${result.meta.renderMs}ms → ${outPath}`);
    summarise(result.root);
  } finally {
    await closeBrowser();
  }
}

function summarise(node: import('@web-to-figma/shared').SceneNode, depth = 0): void {
  if (depth > 3) return;
  const indent = '  '.repeat(depth);
  console.log(`${indent}${node.type} "${node.name}" ${Math.round(node.width)}x${Math.round(node.height)}`);
  if (node.type === 'FRAME') {
    for (const child of node.children.slice(0, 5)) summarise(child, depth + 1);
    if (node.children.length > 5) console.log(`${indent}  ...${node.children.length - 5} more`);
  }
}

main().catch((err) => {
  console.error('[cli] failed:', err);
  process.exit(1);
});
