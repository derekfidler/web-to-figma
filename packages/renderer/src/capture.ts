/**
 * Core capture pipeline.
 *
 * Given a URL + viewport, returns a CaptureResponse:
 *   1. Spin up a Playwright browser context
 *   2. Navigate, wait for network idle
 *   3. Run the in-page extractor → IntermediateNode tree
 *   4. For each tagged element, take a screenshot → base64
 *   5. For each <img>, fetch bytes in page context → base64
 *   6. Strip internal __ fields → CaptureResponse
 */

import type { Browser } from 'playwright';
import type {
  CaptureMeta,
  CaptureResponse,
  Fill,
  ImageNode,
  SceneNode,
  Viewport,
} from '@web-to-figma/shared';
import { VIEWPORT_PRESETS } from '@web-to-figma/shared';
import { buildExtractorCall, type IntermediateNode } from './extractor/extractor.js';

const SCREENSHOT_ATTR = 'data-w2f-id';

export type CaptureOptions = {
  url: string;
  viewport: Viewport | keyof typeof VIEWPORT_PRESETS;
  waitForSelector?: string;
  settleMs?: number;
};

export async function capture(browser: Browser, opts: CaptureOptions): Promise<CaptureResponse> {
  const started = Date.now();
  const viewport: Viewport =
    typeof opts.viewport === 'string' ? VIEWPORT_PRESETS[opts.viewport] : opts.viewport;

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    isMobile: viewport.isMobile ?? false,
    // Reasonable defaults; can be overridden per request later.
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 web-to-figma/0.1',
  });

  const page = await context.newPage();
  // Freeze CSS animations so element screenshots are stable. Without this,
  // sites with continuous animations (Stripe, hero parallax, marquees) cause
  // locator.screenshot() to retry until timeout — minutes instead of seconds.
  await page.emulateMedia({ reducedMotion: 'reduce' });

  try {
    // `domcontentloaded` is more reliable than `networkidle` — sites with
    // long-polling analytics (Stripe, etc.) never reach networkidle. We then
    // wait a fixed settle period for late-loading images/fonts.
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Best-effort networkidle wait, but don't fail if it times out.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 10_000 });
    }
    await page.waitForTimeout(opts.settleMs ?? 1_500);

    // Run the extractor in the page
    const extractorCall = buildExtractorCall({ rootSelector: 'body', screenshotAttr: SCREENSHOT_ATTR });
    let extractResult: {
      title: string;
      url: string;
      viewport: { width: number; height: number };
      tree: IntermediateNode | null;
      error?: string;
    };
    try {
      extractResult = await page.evaluate(extractorCall);
    } catch (err) {
      throw new Error(`extractor threw: ${(err as Error).message}`);
    }

    if (!extractResult) {
      throw new Error('extractor returned undefined');
    }
    if (extractResult.error || !extractResult.tree) {
      throw new Error(`extractor failed: ${extractResult.error || 'no tree'}`);
    }
    const fontAliases = (extractResult as { fontAliases?: Record<string, string> }).fontAliases ?? {};

    // Post-process: screenshots + image fetches
    const screenshotCache = new Map<string, { base64: string; mimeType: string }>();
    const imageCache = new Map<string, { base64: string; mimeType: string }>();

    await collectScreenshots(extractResult.tree, page, screenshotCache);
    await collectImages(extractResult.tree, page, imageCache);

    const root = finalise(extractResult.tree, { screenshotCache, imageCache });

    const meta: CaptureMeta = {
      url: extractResult.url,
      title: extractResult.title,
      capturedAt: new Date().toISOString(),
      viewport,
      renderMs: Date.now() - started,
      nodeCount: countNodes(root),
      fontAliases,
    };

    return { meta, root };
  } finally {
    await context.close();
  }
}

// ---- post-processing ---------------------------------------------------------

async function collectScreenshots(
  node: IntermediateNode | null,
  page: import('playwright').Page,
  cache: Map<string, { base64: string; mimeType: string }>,
): Promise<void> {
  if (!node) return;
  if (node.__needsScreenshot && node.__selector) {
    if (!cache.has(node.__selector)) {
      try {
        const clip = JSON.parse(node.__selector) as { x: number; y: number; width: number; height: number };
        if (clip.width > 0 && clip.height > 0) {
          const buffer = await page.screenshot({
            omitBackground: true,
            type: 'png',
            animations: 'disabled',
            caret: 'hide',
            clip,
            timeout: 3_000,
          });
          cache.set(node.__selector, { base64: buffer.toString('base64'), mimeType: 'image/png' });
        }
      } catch (err) {
        console.warn(`[capture] screenshot failed for clip ${node.__selector}:`, (err as Error).message);
      }
    }
  }
  if (node.children) {
    for (const child of node.children) {
      await collectScreenshots(child, page, cache);
    }
  }
}

async function collectImages(
  node: IntermediateNode | null,
  page: import('playwright').Page,
  cache: Map<string, { base64: string; mimeType: string }>,
): Promise<void> {
  // First pass: collect all unique URLs (own src + image background-fills)
  const urls = new Set<string>();
  collectImageUrls(node, urls);

  // Fetch each one via Playwright's request context, which inherits cookies
  // from the page context but bypasses CORS (Node-side HTTP, not browser fetch).
  const request = page.context().request;
  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const resp = await request.get(url, { timeout: 10_000 });
        if (!resp.ok()) {
          console.warn(`[capture] image ${url}: ${resp.status()}`);
          return;
        }
        const buffer = await resp.body();
        const mimeType = resp.headers()['content-type']?.split(';')[0] ?? guessMime(url);
        cache.set(url, { base64: buffer.toString('base64'), mimeType });
      } catch (err) {
        console.warn(`[capture] image fetch failed ${url}: ${(err as Error).message}`);
      }
    }),
  );
}

function collectImageUrls(node: IntermediateNode | null, urls: Set<string>): void {
  if (!node) return;
  if (node.__kind === 'image' && node.src && !node.__needsScreenshot && isFetchableUrl(node.src)) {
    urls.add(node.src);
  }
  if (node.fills) {
    for (const f of node.fills) if (f.type === 'IMAGE' && f.src && isFetchableUrl(f.src)) urls.add(f.src);
  }
  if (node.children) for (const c of node.children) collectImageUrls(c, urls);
}

function isFetchableUrl(url: string): boolean {
  // Skip data URIs (already inline), fragment-only refs, blob URLs, anything not http(s).
  return /^https?:\/\//i.test(url);
}

function guessMime(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  };
  return map[ext] ?? 'image/png';
}

type FinaliseCtx = {
  screenshotCache: Map<string, { base64: string; mimeType: string }>;
  imageCache: Map<string, { base64: string; mimeType: string }>;
};

function finalise(node: IntermediateNode, ctx: FinaliseCtx): SceneNode {
  const common = {
    id: node.__id,
    name: node.name,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    opacity: node.opacity,
    layout: node.layout,
  };

  if (node.__kind === 'image') {
    let inlined: { base64: string; mimeType: string } | undefined;
    if (node.__needsScreenshot && node.__selector) {
      inlined = ctx.screenshotCache.get(node.__selector);
    } else if (node.src) {
      inlined = ctx.imageCache.get(node.src);
    }
    if (inlined) {
      const img: ImageNode = {
        ...common,
        type: 'IMAGE',
        imageBase64: inlined.base64,
        mimeType: inlined.mimeType,
        src: node.src ?? '',
        scaleMode: 'FILL',
        cornerRadius: node.cornerRadius,
      };
      return img;
    }
    // Fallback to a placeholder rect so layout still makes sense
    return {
      ...common,
      type: 'RECT',
      fills: [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }],
      cornerRadius: node.cornerRadius,
    };
  }

  if (node.__kind === 'text') {
    return {
      ...common,
      type: 'TEXT',
      characters: node.characters ?? '',
      fontFamily: node.fontFamily ?? 'Inter',
      fontWeight: node.fontWeight ?? 400,
      fontSize: node.fontSize ?? 16,
      lineHeightPx: node.lineHeightPx,
      letterSpacingPx: node.letterSpacingPx,
      textAlign: node.textAlign ?? 'LEFT',
      textTransform: node.textTransform,
      textDecoration: node.textDecoration,
      fills: (node.fills as unknown as { type: 'SOLID'; color: { r: number; g: number; b: number; a: number } }[]) ?? [
        { type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    };
  }

  // frame or rect-with-children
  const children = (node.children ?? []).map((c) => finalise(c, ctx));

  // Resolve image fills (background-image URLs) into base64 form
  const resolvedFills: Fill[] | undefined = node.fills?.map((f) => {
    if (f.type === 'IMAGE' && f.src) {
      const inlined = ctx.imageCache.get(f.src);
      if (inlined) {
        return {
          type: 'IMAGE',
          imageBase64: inlined.base64,
          mimeType: inlined.mimeType,
          scaleMode: f.scaleMode,
        } as Fill;
      }
      // Drop the image fill if we couldn't fetch — keeps Figma side simple
      return null;
    }
    return f as Fill;
  }).filter(Boolean) as Fill[] | undefined;

  return {
    ...common,
    type: 'FRAME',
    fills: resolvedFills ?? [],
    strokes: node.strokes,
    cornerRadius: node.cornerRadius,
    effects: node.effects as SceneNode extends { effects?: infer E } ? E : undefined,
    clipsContent: node.clipsContent,
    children,
  } as SceneNode;
}

function countNodes(node: SceneNode): number {
  if (node.type === 'FRAME') return 1 + node.children.reduce((s, c) => s + countNodes(c), 0);
  return 1;
}
