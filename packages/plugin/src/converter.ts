/**
 * Converts a CaptureResponse SceneNode tree into native Figma nodes.
 *
 * Pure-ish logic — needs the `figma` global. Pre-loads fonts, decodes base64
 * images, builds frames/text/rect nodes with all the styling we captured.
 */

import type {
  CaptureResponse,
  Effect,
  Fill,
  FrameNode as W2FFrame,
  ImageNode as W2FImage,
  LayoutHint,
  RectNode as W2FRect,
  SceneNode as W2FNode,
  Stroke,
  TextNode as W2FText,
} from '@web-to-figma/shared';

// Fallback font used whenever the original isn't available in Figma.
const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

type FontKey = string; // family|style

type FontResolution = {
  font: FontName;
  /** True when we couldn't load the originally-requested family. */
  fellBack: boolean;
};

export async function buildScene(
  capture: CaptureResponse,
  options: { onProgress?: (msg: string) => void } = {},
): Promise<FrameNode> {
  const progress = options.onProgress ?? (() => {});

  // 1. Pre-load every font we'll need. Falls back per-font on load failure.
  progress('Loading fonts...');
  const fontMap = await preloadFonts(capture.root);

  // 2. Decode all base64 images up-front so we can do sync work later.
  progress('Decoding images...');
  const imageMap = decodeImages(capture.root);

  // 3. Walk the tree, build Figma nodes.
  progress('Building layers...');
  const ctx: BuildCtx = { fontMap, imageMap };
  const rootFigmaNode = (await buildNode(capture.root, ctx)) as FrameNode;

  // Wrap in a labelled outer frame for the import session.
  const wrapper = figma.createFrame();
  wrapper.name = `${capture.meta.title} — ${capture.meta.url}`;
  wrapper.resizeWithoutConstraints(capture.root.width, capture.root.height);
  wrapper.fills = [];
  wrapper.clipsContent = false;
  rootFigmaNode.x = 0;
  rootFigmaNode.y = 0;
  wrapper.appendChild(rootFigmaNode);
  return wrapper;
}

// --- font preloading ---------------------------------------------------------

type BuildCtx = {
  fontMap: Map<FontKey, FontResolution>;
  imageMap: Map<string, string>; // node id → image hash
};

function fontKey(family: string, weight: number): FontKey {
  return `${family.toLowerCase()}|${weight}`;
}

function styleFromWeight(weight: number): string {
  // Figma's style names depend on the font. These are the common Inter ones,
  // which work for most sans-serif fonts.
  if (weight <= 200) return 'Thin';
  if (weight <= 300) return 'Light';
  if (weight <= 450) return 'Regular';
  if (weight <= 550) return 'Medium';
  if (weight <= 650) return 'Semi Bold';
  if (weight <= 750) return 'Bold';
  if (weight <= 850) return 'Extra Bold';
  return 'Black';
}

function collectFontsNeeded(node: W2FNode, into: Set<FontKey>, map: Map<FontKey, { family: string; weight: number }>): void {
  if (node.type === 'TEXT') {
    const key = fontKey(node.fontFamily, node.fontWeight);
    if (!into.has(key)) {
      into.add(key);
      map.set(key, { family: node.fontFamily, weight: node.fontWeight });
    }
  }
  if (node.type === 'FRAME') for (const c of node.children) collectFontsNeeded(c, into, map);
}

async function preloadFonts(root: W2FNode): Promise<Map<FontKey, FontResolution>> {
  const keys = new Set<FontKey>();
  const meta = new Map<FontKey, { family: string; weight: number }>();
  collectFontsNeeded(root, keys, meta);

  const result = new Map<FontKey, FontResolution>();
  // Always have a fallback ready.
  try {
    await figma.loadFontAsync(FALLBACK_FONT);
  } catch {
    // Should never happen — Inter Regular is built in.
  }

  await Promise.all(
    [...keys].map(async (k) => {
      const info = meta.get(k)!;
      const requested: FontName = { family: info.family, style: styleFromWeight(info.weight) };
      try {
        await figma.loadFontAsync(requested);
        result.set(k, { font: requested, fellBack: false });
        return;
      } catch {
        // continue to fallback
      }
      const interFallback: FontName = { family: 'Inter', style: styleFromWeight(info.weight) };
      try {
        await figma.loadFontAsync(interFallback);
        result.set(k, { font: interFallback, fellBack: true });
      } catch {
        result.set(k, { font: FALLBACK_FONT, fellBack: true });
      }
    }),
  );

  return result;
}

// --- image decoding ----------------------------------------------------------

function decodeImages(root: W2FNode): Map<string, string> {
  const map = new Map<string, string>();
  walkImages(root, (n) => {
    if (n.type === 'IMAGE' && n.imageBase64) {
      try {
        const bytes = base64ToBytes(n.imageBase64);
        const img = figma.createImage(bytes);
        map.set(n.id, img.hash);
      } catch (err) {
        console.warn('[w2f] image decode failed for', n.name, err);
      }
    }
    // Frame fills with images
    if ((n.type === 'FRAME' || n.type === 'RECT') && n.fills) {
      for (let i = 0; i < n.fills.length; i++) {
        const f = n.fills[i];
        if (f.type === 'IMAGE' && f.imageBase64) {
          try {
            const bytes = base64ToBytes(f.imageBase64);
            const img = figma.createImage(bytes);
            map.set(`${n.id}#fill${i}`, img.hash);
          } catch (err) {
            console.warn('[w2f] fill image decode failed for', n.name, err);
          }
        }
      }
    }
  });
  return map;
}

function walkImages(node: W2FNode, fn: (n: W2FNode) => void): void {
  fn(node);
  if (node.type === 'FRAME') for (const c of node.children) walkImages(c, fn);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- node building -----------------------------------------------------------

async function buildNode(node: W2FNode, ctx: BuildCtx): Promise<SceneNode | null> {
  switch (node.type) {
    case 'FRAME':
      return buildFrame(node, ctx);
    case 'TEXT':
      return buildText(node, ctx);
    case 'IMAGE':
      return buildImage(node, ctx);
    case 'RECT':
      return buildRect(node);
    case 'VECTOR':
      return buildVector(node);
    default:
      return null;
  }
}

function buildFrame(node: W2FFrame, ctx: BuildCtx): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = node.name;
  frame.x = node.x;
  frame.y = node.y;
  frame.resizeWithoutConstraints(Math.max(1, node.width), Math.max(1, node.height));
  if (node.opacity != null) frame.opacity = node.opacity;
  frame.fills = mapFills(node.fills, node.id, ctx);
  if (node.strokes) applyStrokes(frame, node.strokes);
  if (node.cornerRadius != null) applyCornerRadius(frame, node.cornerRadius);
  if (node.effects) frame.effects = mapEffects(node.effects);
  // Deliberately not propagating clipsContent — the imported file is for
  // editing, and clipping inside small frames (buttons, sidebars) hides any
  // overflowing fallback-font text. Designers can re-enable per frame.
  frame.clipsContent = false;
  if (node.layout && node.layout.mode !== 'NONE') applyLayout(frame, node.layout);
  return (async () => {
    for (const child of node.children) {
      const built = await buildNode(child, ctx);
      if (built) frame.appendChild(built);
    }
    return frame;
  })();
}

async function buildText(node: W2FText, ctx: BuildCtx): Promise<TextNode> {
  const text = figma.createText();
  const resolution = ctx.fontMap.get(fontKey(node.fontFamily, node.fontWeight)) ?? {
    font: FALLBACK_FONT,
    fellBack: true,
  };
  text.fontName = resolution.font;
  text.fontSize = Math.max(1, node.fontSize);
  text.characters = node.characters;
  text.name = node.name;
  text.x = node.x;
  text.y = node.y;
  // When we used a fallback font the captured width is no longer accurate —
  // let the text node grow to its natural size so it doesn't clip ("Sen" /
  // "Rec"). For original fonts the captured size is correct and we keep it.
  if (resolution.fellBack) {
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
  } else {
    text.textAutoResize = 'NONE';
    text.resizeWithoutConstraints(Math.max(1, node.width), Math.max(1, node.height));
  }
  if (node.opacity != null) text.opacity = node.opacity;
  if (node.lineHeightPx) text.lineHeight = { unit: 'PIXELS', value: node.lineHeightPx };
  if (node.letterSpacingPx) text.letterSpacing = { unit: 'PIXELS', value: node.letterSpacingPx };
  text.textAlignHorizontal = node.textAlign === 'JUSTIFIED' ? 'JUSTIFIED' : (node.textAlign as 'LEFT' | 'CENTER' | 'RIGHT');
  if (node.textTransform && node.textTransform !== 'NONE') {
    text.textCase = node.textTransform === 'UPPER' ? 'UPPER' : node.textTransform === 'LOWER' ? 'LOWER' : node.textTransform === 'CAPITALIZE' ? 'TITLE' : 'ORIGINAL';
  }
  if (node.textDecoration && node.textDecoration !== 'NONE') {
    text.textDecoration = node.textDecoration === 'UNDERLINE' ? 'UNDERLINE' : 'STRIKETHROUGH';
  }
  text.fills = mapFills(node.fills, node.id, ctx);
  return text;
}

function buildImage(node: W2FImage, ctx: BuildCtx): RectangleNode {
  const rect = figma.createRectangle();
  rect.name = node.name;
  rect.x = node.x;
  rect.y = node.y;
  rect.resizeWithoutConstraints(Math.max(1, node.width), Math.max(1, node.height));
  if (node.opacity != null) rect.opacity = node.opacity;
  const hash = ctx.imageMap.get(node.id);
  if (hash) {
    rect.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: toFigmaScaleMode(node.scaleMode) }];
  } else {
    rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
  }
  if (node.cornerRadius != null) applyCornerRadius(rect, node.cornerRadius);
  return rect;
}

function buildRect(node: W2FRect): RectangleNode {
  const rect = figma.createRectangle();
  rect.name = node.name;
  rect.x = node.x;
  rect.y = node.y;
  rect.resizeWithoutConstraints(Math.max(1, node.width), Math.max(1, node.height));
  if (node.opacity != null) rect.opacity = node.opacity;
  rect.fills = mapFills(node.fills, node.id, { fontMap: new Map(), imageMap: new Map() });
  if (node.strokes) applyStrokes(rect, node.strokes);
  if (node.cornerRadius != null) applyCornerRadius(rect, node.cornerRadius);
  if (node.effects) rect.effects = mapEffects(node.effects);
  return rect;
}

async function buildVector(node: W2FNode & { type: 'VECTOR'; svg: string }): Promise<SceneNode | null> {
  try {
    const vec = figma.createNodeFromSvg(node.svg);
    vec.name = node.name;
    vec.x = node.x;
    vec.y = node.y;
    vec.resizeWithoutConstraints(Math.max(1, node.width), Math.max(1, node.height));
    if (node.opacity != null) vec.opacity = node.opacity;
    return vec;
  } catch (err) {
    console.warn('[w2f] vector creation failed:', err);
    return null;
  }
}

// --- style helpers -----------------------------------------------------------

function mapFills(fills: Fill[] | undefined, ownerId: string, ctx: BuildCtx): Paint[] {
  if (!fills || fills.length === 0) return [];
  const out: Paint[] = [];
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    if (f.type === 'SOLID') {
      out.push({
        type: 'SOLID',
        color: { r: f.color.r, g: f.color.g, b: f.color.b },
        opacity: f.color.a,
      });
    } else if (f.type === 'IMAGE') {
      const hash = ctx.imageMap.get(`${ownerId}#fill${i}`);
      if (hash) {
        out.push({ type: 'IMAGE', imageHash: hash, scaleMode: toFigmaScaleMode(f.scaleMode) });
      }
    } else if (f.type === 'GRADIENT_LINEAR') {
      const angleRad = (f.angle * Math.PI) / 180;
      out.push({
        type: 'GRADIENT_LINEAR',
        gradientTransform: [
          [Math.cos(angleRad), Math.sin(angleRad), 0],
          [-Math.sin(angleRad), Math.cos(angleRad), 0],
        ],
        gradientStops: f.stops.map((s) => ({
          position: s.position,
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
        })),
      });
    }
  }
  return out;
}

function applyStrokes(node: FrameNode | RectangleNode, strokes: Stroke[]): void {
  if (strokes.length === 0) return;
  const s = strokes[0];
  node.strokes = [
    {
      type: 'SOLID',
      color: { r: s.color.r, g: s.color.g, b: s.color.b },
      opacity: s.color.a,
    },
  ];
  node.strokeWeight = s.weight;
  node.strokeAlign = s.align;
  if (s.dashPattern) node.dashPattern = s.dashPattern.slice();
}

function toFigmaScaleMode(mode: 'FILL' | 'FIT' | 'TILE' | 'STRETCH'): 'FILL' | 'FIT' | 'TILE' | 'CROP' {
  // Figma's image scale modes don't include 'STRETCH'. FILL is the closest match
  // (preserves the centred fill behaviour).
  return mode === 'STRETCH' ? 'FILL' : mode;
}

function applyCornerRadius(
  node: FrameNode | RectangleNode,
  r: number | { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number },
): void {
  if (typeof r === 'number') {
    node.cornerRadius = r;
  } else {
    node.topLeftRadius = r.topLeft;
    node.topRightRadius = r.topRight;
    node.bottomLeftRadius = r.bottomLeft;
    node.bottomRightRadius = r.bottomRight;
  }
}

function mapEffects(effects: Effect[]): ReadonlyArray<DropShadowEffect | InnerShadowEffect> {
  return effects.map((e) => ({
    type: e.type,
    color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
    offset: e.offset,
    radius: e.radius,
    spread: e.spread ?? 0,
    blendMode: 'NORMAL' as BlendMode,
    visible: true,
  }));
}

function applyLayout(frame: FrameNode, layout: LayoutHint): void {
  frame.layoutMode = layout.mode === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  if (layout.itemSpacing != null) frame.itemSpacing = layout.itemSpacing;
  if (layout.paddingLeft != null) frame.paddingLeft = layout.paddingLeft;
  if (layout.paddingRight != null) frame.paddingRight = layout.paddingRight;
  if (layout.paddingTop != null) frame.paddingTop = layout.paddingTop;
  if (layout.paddingBottom != null) frame.paddingBottom = layout.paddingBottom;
  const primaryMap: Record<string, FrameNode['primaryAxisAlignItems']> = {
    MIN: 'MIN',
    CENTER: 'CENTER',
    MAX: 'MAX',
    SPACE_BETWEEN: 'SPACE_BETWEEN',
  };
  const counterMap: Record<string, FrameNode['counterAxisAlignItems']> = {
    MIN: 'MIN',
    CENTER: 'CENTER',
    MAX: 'MAX',
  };
  if (layout.primaryAlign) frame.primaryAxisAlignItems = primaryMap[layout.primaryAlign] ?? 'MIN';
  if (layout.counterAlign) frame.counterAxisAlignItems = counterMap[layout.counterAlign] ?? 'MIN';
  frame.primaryAxisSizingMode = 'FIXED';
  frame.counterAxisSizingMode = 'FIXED';
}
