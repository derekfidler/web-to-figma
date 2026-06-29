/**
 * Figma plugin main thread.
 *
 * Spawns the UI, listens for capture requests, calls the renderer, builds the
 * Figma node tree on the canvas.
 */
import type { CaptureResponse } from '@web-to-figma/shared';
import { buildScene } from './converter';

type UIMessage =
  | {
      kind: 'capture';
      payload: {
        url: string;
        viewports: string[];
        endpoint: string;
        token?: string;
      };
    }
  | { kind: 'request-settings' };

type FontReport = {
  requested: { family: string; weight: number };
  resolved: { family: string; style: string };
  fellBack: boolean;
};

type PluginMessage =
  | { kind: 'progress'; message: string }
  | { kind: 'success'; nodeCount: number; renderMs: number; buildMs: number; fontReport: FontReport[] }
  | { kind: 'error'; message: string }
  | { kind: 'settings'; endpoint: string; token?: string };

const SETTINGS_KEY = 'web-to-figma:settings';

figma.showUI(__html__, { width: 440, height: 480, themeColors: true });

figma.ui.onmessage = async (msg: UIMessage) => {
  if (msg.kind === 'request-settings') {
    const saved = await figma.clientStorage.getAsync(SETTINGS_KEY);
    post({
      kind: 'settings',
      endpoint: saved?.endpoint ?? 'http://localhost:4321',
      token: saved?.token ?? '',
    });
    return;
  }

  if (msg.kind === 'capture') {
    const { endpoint, token, url, viewports } = msg.payload;
    await figma.clientStorage.setAsync(SETTINGS_KEY, { endpoint, token });

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const importedRoots: FrameNode[] = [];
      let totalNodes = 0;
      let totalRenderMs = 0;
      let totalBuildMs = 0;
      const combinedFontReport: FontReport[] = [];

      for (let i = 0; i < viewports.length; i++) {
        const viewport = viewports[i];
        post({
          kind: 'progress',
          message: `[${i + 1}/${viewports.length}] Capturing ${viewport}...`,
        });
        const resp = await fetch(`${endpoint.replace(/\/$/, '')}/capture`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ url, viewport }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`renderer returned ${resp.status}: ${body.slice(0, 200)}`);
        }
        const capture = (await resp.json()) as CaptureResponse;
        post({
          kind: 'progress',
          message: `[${i + 1}/${viewports.length}] Building ${capture.meta.nodeCount} ${viewport} layers...`,
        });

        const buildStart = Date.now();
        const { root, fontResolutions } = await buildScene(capture, {
          onProgress: (m) => post({ kind: 'progress', message: `[${i + 1}/${viewports.length}] ${m}` }),
        });
        const buildMs = Date.now() - buildStart;

        // Tag the wrapper with the viewport name so it's distinguishable in Figma
        root.name = `${root.name} — ${viewport}`;

        // Place each wrapper alongside whatever's already on the page (existing
        // artwork from before, plus the ones we placed earlier in this loop).
        positionAlongsideExisting(root);
        importedRoots.push(root);
        totalNodes += capture.meta.nodeCount;
        totalRenderMs += capture.meta.renderMs;
        totalBuildMs += buildMs;
        for (const r of fontResolutions) combinedFontReport.push(r);
      }

      figma.viewport.scrollAndZoomIntoView(importedRoots);
      const hostMatch = url.match(/^https?:\/\/([^/]+)/);
      const host = hostMatch ? hostMatch[1] : url;
      figma.notify(
        `Imported ${importedRoots.length} viewport${importedRoots.length > 1 ? 's' : ''} (${totalNodes} layers) from ${host}`,
      );

      post({
        kind: 'success',
        nodeCount: totalNodes,
        renderMs: totalRenderMs,
        buildMs: totalBuildMs,
        fontReport: dedupeFontReport(combinedFontReport),
      });
    } catch (err) {
      const message = (err as Error).message;
      figma.notify(`Import failed: ${message}`, { error: true });
      post({ kind: 'error', message });
    }
  }
};

function dedupeFontReport(reports: FontReport[]): FontReport[] {
  const seen = new Map<string, FontReport>();
  for (const r of reports) {
    const key = `${r.requested.family}|${r.requested.weight}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

function post(msg: PluginMessage): void {
  figma.ui.postMessage(msg);
}

const IMPORT_GAP = 200;

/** Place `newFrame` 200px right of the rightmost existing frame on the page.
 *  If there are no other frames, leave it at the origin. */
function positionAlongsideExisting(newFrame: FrameNode): void {
  let rightmost: number | null = null;
  for (const child of figma.currentPage.children) {
    if (child.id === newFrame.id) continue;
    if (!('width' in child)) continue;
    const right = child.x + child.width;
    if (rightmost === null || right > rightmost) rightmost = right;
  }
  if (rightmost === null) {
    newFrame.x = 0;
    newFrame.y = 0;
  } else {
    newFrame.x = rightmost + IMPORT_GAP;
    newFrame.y = 0;
  }
}
