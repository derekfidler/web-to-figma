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
import sharp from 'sharp';
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

/** A generic "image placeholder" glyph — appears when a screenshot or remote
 *  image fetch failed. Designers can replace it after import. */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;

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

    // Scroll-warmup. Many modern apps lazy-load images and SVG icons below
    // the viewport (Next.js <Image>, react-intersection-observer, etc.). If
    // we extract at scroll=0, those elements exist as empty placeholders and
    // their bounds get captured but their contents don't. Walk down the page
    // in chunks to trigger every IntersectionObserver, then back to the top.
    await page.evaluate(async () => {
      const stepHeight = window.innerHeight * 0.8;
      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = 0; y < totalHeight; y += stepHeight) {
        window.scrollTo(0, y);
        // One animation frame per step is enough to fire IntersectionObserver
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 50));
    });
    // Now wait for any newly-started image loads to settle.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

    // Hide dev-mode overlays so they don't (a) appear in extracted layers or
    // (b) bleed into element screenshots. nextjs-portal renders the Next.js
    // dev indicator as a fixed-position web component that overlapped icon
    // screenshots; cookie banners and chat widgets cause similar problems.
    await page.addStyleTag({
      content: `
        nextjs-portal,
        [data-nextjs-toast],
        [data-nextjs-dialog-overlay],
        #__next-build-watcher,
        [data-next-mark],
        [data-next-mark-loading],
        [data-nextjs-dev-tools-button],
        [data-nextjs-router-announcer],
        #__next-route-announcer__,
        .__next-route-announcer__,
        .grecaptcha-badge,
        #cookie-banner,
        [aria-label="Open Intercom Messenger"],
        .intercom-launcher,
        .crisp-client {
          display: none !important;
          visibility: hidden !important;
        }
      `,
    });
    // Tiny settle for the style to apply
    await page.waitForTimeout(50);

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

    // Post-process: take ONE full-page screenshot, crop each clip from it,
    // and fetch remote <img> assets in parallel.
    const screenshotCache = new Map<string, { base64: string; mimeType: string }>();
    const imageCache = new Map<string, { base64: string; mimeType: string }>();

    await collectScreenshots(extractResult.tree, page, screenshotCache, viewport.deviceScaleFactor ?? 1);
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
  root: IntermediateNode | null,
  page: import('playwright').Page,
  cache: Map<string, { base64: string; mimeType: string }>,
  deviceScaleFactor: number,
): Promise<void> {
  if (!root) return;

  // Walk the tree first to find every clip we need
  const clips: { selector: string; clip: { x: number; y: number; width: number; height: number } }[] = [];
  collectClips(root, clips);
  if (clips.length === 0) return;

  // Take ONE full-page screenshot. Cropping every clip from this buffer with
  // Sharp is dramatically faster than per-element screenshots, and full-page
  // captures clips that are below the visible viewport (Telia DK at y=940
  // when viewport is 900 tall — those used to come back empty).
  let pagePng: Buffer;
  try {
    pagePng = await page.screenshot({
      fullPage: true,
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      timeout: 30_000,
    });
  } catch (err) {
    console.warn(`[capture] full-page screenshot failed:`, (err as Error).message);
    return;
  }

  // The screenshot is at deviceScaleFactor density. Clips are in CSS pixels.
  const dsf = deviceScaleFactor;
  await Promise.all(
    clips.map(async ({ selector, clip }) => {
      if (cache.has(selector)) return;
      const left = Math.max(0, Math.round(clip.x * dsf));
      const top = Math.max(0, Math.round(clip.y * dsf));
      const width = Math.max(1, Math.round(clip.width * dsf));
      const height = Math.max(1, Math.round(clip.height * dsf));
      try {
        const cropped = await sharp(pagePng).extract({ left, top, width, height }).png().toBuffer();
        cache.set(selector, { base64: cropped.toString('base64'), mimeType: 'image/png' });
      } catch (err) {
        console.warn(`[capture] crop failed for clip ${selector}:`, (err as Error).message);
      }
    }),
  );
}

function collectClips(
  node: IntermediateNode | null,
  out: { selector: string; clip: { x: number; y: number; width: number; height: number } }[],
): void {
  if (!node) return;
  if (node.__needsScreenshot && node.__selector) {
    try {
      const clip = JSON.parse(node.__selector) as { x: number; y: number; width: number; height: number };
      if (clip.width > 0 && clip.height > 0) out.push({ selector: node.__selector, clip });
    } catch {
      /* malformed selector */
    }
  }
  if (node.children) for (const c of node.children) collectClips(c, out);
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
    // Fallback when screenshot/fetch failed: emit a VECTOR with a generic
    // image-placeholder glyph instead of a featureless gray box. Designers
    // can swap in real assets after the fact, and it's clear which slots
    // didn't capture cleanly.
    return {
      ...common,
      type: 'VECTOR',
      svg: PLACEHOLDER_SVG,
    } as SceneNode;
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
