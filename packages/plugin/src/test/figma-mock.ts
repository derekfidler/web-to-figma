/**
 * Minimal Figma plugin API mock for offline testing of the converter.
 *
 * Records calls in `figmaStub.log` for later assertions. Returns plausible-shape
 * objects with no-op setters that just store values, so the converter's writes
 * don't blow up and we can inspect what it tried to build.
 */

type LogEntry = { call: string; node?: number; args?: unknown[] };

const log: LogEntry[] = [];
let nextNodeId = 1;
let nextImageHash = 1;

interface MockNode {
  __id: number;
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: MockNode[];
  fills?: unknown;
  strokes?: unknown;
  effects?: unknown;
  opacity?: number;
  cornerRadius?: number;
  appendChild?: (n: MockNode) => void;
  resizeWithoutConstraints?: (w: number, h: number) => void;
  clipsContent?: boolean;
}

function makeNode(type: string): MockNode {
  const id = nextNodeId++;
  const node: MockNode = {
    __id: id,
    type,
    name: '',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    children: [],
    appendChild(child: MockNode) {
      this.children.push(child);
    },
    resizeWithoutConstraints(w: number, h: number) {
      this.width = w;
      this.height = h;
    },
  };
  log.push({ call: type, node: id });
  return node;
}

const figma = {
  createFrame: () => makeNode('FRAME'),
  createRectangle: () => makeNode('RECTANGLE'),
  createText: () => {
    const n = makeNode('TEXT') as MockNode & {
      characters: string;
      fontSize: number;
      fontName: { family: string; style: string };
      textAlignHorizontal: string;
      textAutoResize: string;
    };
    n.characters = '';
    n.fontSize = 16;
    n.fontName = { family: 'Inter', style: 'Regular' };
    n.textAlignHorizontal = 'LEFT';
    n.textAutoResize = 'NONE';
    return n;
  },
  createNodeFromSvg: (_svg: string) => makeNode('VECTOR'),
  createImage: (_bytes: Uint8Array) => ({ hash: 'mock-image-' + nextImageHash++ }),
  loadFontAsync: async (font: { family: string; style: string }) => {
    log.push({ call: 'loadFontAsync', args: [font] });
    // Allow Inter to load; reject everything else to exercise the fallback path.
    if (font.family.toLowerCase() === 'inter') return;
    throw new Error('font not available: ' + JSON.stringify(font));
  },
  viewport: { scrollAndZoomIntoView: (_nodes: unknown[]) => undefined },
  notify: (_msg: string, _opts?: unknown) => undefined,
  clientStorage: {
    getAsync: async (_k: string) => undefined,
    setAsync: async (_k: string, _v: unknown) => undefined,
  },
  showUI: (_html: string, _opts?: unknown) => undefined,
  ui: {
    postMessage: (_msg: unknown) => undefined,
    onmessage: undefined as ((msg: unknown) => void) | undefined,
  },
};

(globalThis as Record<string, unknown>).figma = figma;
(globalThis as Record<string, unknown>).__html__ = '<html></html>';

export const figmaStub = { log, reset: () => { log.length = 0; nextNodeId = 1; nextImageHash = 1; } };
