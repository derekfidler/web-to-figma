/**
 * Figma plugin main thread.
 *
 * Spawns the UI, listens for capture requests, calls the renderer, builds the
 * Figma node tree on the canvas.
 */
import type { CaptureRequest, CaptureResponse } from '@web-to-figma/shared';
import { buildScene } from './converter';

type UIMessage =
  | { kind: 'capture'; payload: CaptureRequest & { endpoint: string; token?: string } }
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

figma.showUI(__html__, { width: 420, height: 360, themeColors: true });

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
    const { endpoint, token, ...request } = msg.payload;
    await figma.clientStorage.setAsync(SETTINGS_KEY, { endpoint, token });

    try {
      post({ kind: 'progress', message: 'Capturing page...' });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const resp = await fetch(`${endpoint.replace(/\/$/, '')}/capture`, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`renderer returned ${resp.status}: ${body.slice(0, 200)}`);
      }
      const capture = (await resp.json()) as CaptureResponse;
      post({ kind: 'progress', message: `Received ${capture.meta.nodeCount} nodes — building...` });

      const buildStart = Date.now();
      const { root, fontResolutions } = await buildScene(capture, {
        onProgress: (m) => post({ kind: 'progress', message: m }),
      });
      const buildMs = Date.now() - buildStart;

      // Place the new import 200px to the right of the rightmost existing
      // top-level frame on this page, so successive captures lay out
      // side-by-side instead of stacking on top of each other.
      positionAlongsideExisting(root);

      figma.viewport.scrollAndZoomIntoView([root]);
      // Figma's plugin sandbox doesn't expose the URL constructor — parse manually.
      const hostMatch = capture.meta.url.match(/^https?:\/\/([^/]+)/);
      const host = hostMatch ? hostMatch[1] : capture.meta.url;
      figma.notify(`Imported ${capture.meta.nodeCount} layers from ${host}`);

      post({
        kind: 'success',
        nodeCount: capture.meta.nodeCount,
        renderMs: capture.meta.renderMs,
        buildMs,
        fontReport: fontResolutions,
      });
    } catch (err) {
      const message = (err as Error).message;
      figma.notify(`Import failed: ${message}`, { error: true });
      post({ kind: 'error', message });
    }
  }
};

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
