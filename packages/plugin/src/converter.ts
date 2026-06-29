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

/**
 * Brand-font overrides. Maps captured CSS-alias families to the exact font
 * family name installed on the design team's machines.
 *
 * These take priority over auto-detected @font-face aliases and fuzzy matching.
 * Add or adjust entries here when a new brand font joins the design system or
 * Figma reports a different family name than expected.
 *
 * Resolution still falls back to fuzzy matching if the override family isn't
 * installed exactly — so "Founders Grotesk X-Condensed" still works if it's
 * shipped as "Founders Grotesk X-Cond" on a teammate's machine.
 */
const FONT_OVERRIDES: Record<string, string> = {
  // Flatpay design system
  founders: 'Founders Grotesk X-Condensed',
  interTight: 'Inter Tight',
  martianMono: 'Martian Mono',
};

type FontKey = string; // family|style

type FontResolution = {
  font: FontName;
  /** True when we couldn't load the originally-requested family. */
  fellBack: boolean;
};

export type BuildResult = {
  root: FrameNode;
  fontResolutions: FontResolutionReport[];
};

export type FontResolutionReport = {
  requested: { family: string; weight: number };
  resolved: FontName;
  fellBack: boolean;
};

export async function buildScene(
  capture: CaptureResponse,
  options: { onProgress?: (msg: string) => void } = {},
): Promise<BuildResult> {
  const progress = options.onProgress ?? (() => {});

  // 1. Pre-load every font we'll need. Falls back per-font on load failure.
  progress('Loading fonts...');
  const fontMap = await preloadFonts(capture.root, capture.meta.fontAliases ?? {});

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

  // Build report of font resolutions for diagnostic surfacing in the UI.
  const meta = FONT_META_CACHE.get(fontMap);
  const fontResolutions: FontResolutionReport[] = [];
  for (const [key, res] of fontMap.entries()) {
    const info = meta?.get(key);
    fontResolutions.push({
      requested: info ?? { family: key, weight: 400 },
      resolved: res.font,
      fellBack: res.fellBack,
    });
  }
  return { root: wrapper, fontResolutions };
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

const FONT_META_CACHE = new WeakMap<Map<FontKey, FontResolution>, Map<FontKey, { family: string; weight: number }>>();

async function preloadFonts(
  root: W2FNode,
  fontAliases: Record<string, string>,
): Promise<Map<FontKey, FontResolution>> {
  const keys = new Set<FontKey>();
  const meta = new Map<FontKey, { family: string; weight: number }>();
  collectFontsNeeded(root, keys, meta);

  // Snapshot what's actually available — locally installed fonts vary per machine.
  const available = await figma.listAvailableFontsAsync();
  const stylesByFamily = new Map<string, string[]>();
  for (const f of available) {
    const family = f.fontName.family;
    if (!stylesByFamily.has(family)) stylesByFamily.set(family, []);
    stylesByFamily.get(family)!.push(f.fontName.style);
  }

  const result = new Map<FontKey, FontResolution>();
  try {
    await figma.loadFontAsync(FALLBACK_FONT);
  } catch {
    // Should never happen — Inter Regular is built in.
  }

  await Promise.all(
    [...keys].map(async (k) => {
      const info = meta.get(k)!;
      // Resolution priority:
      //   1. Hardcoded brand-font override (FONT_OVERRIDES)
      //   2. Renderer-extracted @font-face alias from the page CSS
      //   3. Original captured family name (fuzzy match handles variations)
      const override = FONT_OVERRIDES[info.family];
      const aliased = fontAliases[info.family];
      const family = override ?? aliased ?? info.family;
      const resolved = await resolveFont(family, info.weight, stylesByFamily);
      // If we used an override or alias, treat a partial-name match as "found".
      const hint = (override ?? aliased ?? '').toLowerCase().split(' ')[0];
      if (hint && resolved.font.family.toLowerCase().includes(hint)) {
        resolved.fellBack = false;
      }
      result.set(k, resolved);
    }),
  );

  FONT_META_CACHE.set(result, meta);
  return result;
}

/**
 * Find the best font for a (family, weight) pair on the current machine.
 *
 * Strategy:
 *   1. If the family is installed, pick the style whose weight is closest to
 *      requested. (Handles "Founders Grotesk X-Condensed" only having Bold.)
 *   2. If the family is missing, try common family-name variations (e.g.
 *      "Founders Grotesk" matches when "Founders Grotesk Bold" was requested
 *      with weight bundled into the family name).
 *   3. Fall back to Inter at the requested weight.
 */
async function resolveFont(
  requestedFamily: string,
  requestedWeight: number,
  stylesByFamily: Map<string, string[]>,
): Promise<FontResolution> {
  const candidates = familyCandidates(requestedFamily);
  // Add the fuzzy match (if any) as a final candidate before Inter
  const fuzzy = fuzzyFindFamily(requestedFamily, stylesByFamily);
  if (fuzzy && !candidates.includes(fuzzy)) candidates.push(fuzzy);

  for (const family of candidates) {
    const styles = stylesByFamily.get(family);
    if (!styles || styles.length === 0) continue;
    const style = pickClosestStyle(styles, requestedWeight);
    try {
      await figma.loadFontAsync({ family, style });
      return { font: { family, style }, fellBack: family !== requestedFamily };
    } catch {
      // try next candidate
    }
  }
  // Inter fallback
  const interStyles = stylesByFamily.get('Inter') ?? ['Regular'];
  const interStyle = pickClosestStyle(interStyles, requestedWeight);
  try {
    await figma.loadFontAsync({ family: 'Inter', style: interStyle });
    return { font: { family: 'Inter', style: interStyle }, fellBack: true };
  } catch {
    return { font: FALLBACK_FONT, fellBack: true };
  }
}

/** Generate candidate family names. Pages often use CSS-variable aliases
 *  like "interTight" or "founders" that resolve to a real installed font via
 *  @font-face. We can't reach those mappings from the plugin sandbox, so we
 *  produce a stack of variants and rely on fuzzy substring matching against
 *  the installed-font catalogue as a last resort. */
function familyCandidates(family: string): string[] {
  const out: string[] = [family];
  // Common abbreviation expansions
  const expanded = family.replace(/X-Cond\b/i, 'X-Condensed');
  if (expanded !== family) out.push(expanded);
  // Trim trailing weight words: "Founders Grotesk Bold" → "Founders Grotesk"
  const baseTrim = family.replace(/\s+(Thin|Light|Regular|Medium|Semi\s*Bold|Bold|Extra\s*Bold|Black)$/i, '');
  if (baseTrim !== family) out.push(baseTrim);
  // Strip Next.js / module-CSS prefixes/suffixes: "__Inter_Tight_abc123" → "Inter Tight"
  const nextFontMatch = family.match(/^_+([A-Za-z]+(?:_[A-Za-z]+)*)_?[a-f0-9]*$/);
  if (nextFontMatch) out.push(nextFontMatch[1].replace(/_/g, ' '));
  // CamelCase → spaced: "interTight" → "Inter Tight"
  const camelSplit = family.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (camelSplit !== family) {
    out.push(camelSplit);
    // Title-case it too
    out.push(camelSplit.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return [...new Set(out)];
}

/** Last-resort substring match: scan installed family names for one that
 *  contains the requested alias (case-insensitive). Catches cases like
 *  "founders" → "Founders Grotesk X-Condensed". */
function fuzzyFindFamily(alias: string, stylesByFamily: Map<string, string[]>): string | null {
  const needle = alias.toLowerCase().replace(/[^a-z]/g, '');
  if (needle.length < 3) return null;
  for (const family of stylesByFamily.keys()) {
    const hay = family.toLowerCase().replace(/[^a-z]/g, '');
    if (hay.includes(needle) || needle.includes(hay)) return family;
  }
  // Try matching individual CamelCase tokens of the alias
  const tokens = alias.split(/(?=[A-Z])|[\s_-]+/).filter((t) => t.length >= 3);
  for (const family of stylesByFamily.keys()) {
    const hay = family.toLowerCase();
    if (tokens.every((t) => hay.includes(t.toLowerCase()))) return family;
  }
  return null;
}

/** Score each available style against the requested weight, pick the closest. */
function pickClosestStyle(styles: string[], requestedWeight: number): string {
  const requestedScore = weightScore(styleFromWeight(requestedWeight));
  let best = styles[0];
  let bestDist = Infinity;
  for (const s of styles) {
    // Skip italics if we didn't ask for one
    if (/italic|oblique/i.test(s)) continue;
    const dist = Math.abs(weightScore(s) - requestedScore);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

function weightScore(style: string): number {
  const s = style.toLowerCase();
  if (s.includes('thin')) return 100;
  if (s.includes('extralight') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('regular') || s === '' || s.includes('normal')) return 400;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold') || s.includes('semi bold') || s.includes('demibold')) return 600;
  if (s.includes('extrabold') || s.includes('extra bold') || s.includes('ultrabold')) return 800;
  if (s.includes('bold')) return 700;
  if (s.includes('black') || s.includes('heavy')) return 900;
  return 400;
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
  // Auto-layout disabled for v1. Source pages use justify-content magic
  // (space-between, ml-auto) that Figma's auto-layout can't fully model, and
  // a wrong auto-layout clusters children to one side and makes the result
  // look broken. Absolute positioning gives 1:1 fidelity to the captured
  // pixel positions.
  // if (node.layout && node.layout.mode !== 'NONE') applyLayout(frame, node.layout);
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
  // Always auto-resize to natural content size. Even when we load the
  // "correct" family, variable-font axis settings on the source page (Inter
  // Tight at wght=530 etc.) produce slightly different glyph widths than the
  // discrete installed file. Keeping the captured width forces wrapping on
  // short labels ("BP" → "B"/"P", "Send" → "Sen"/"d"). Letting text size
  // itself is more visually faithful.
  text.textAutoResize = 'WIDTH_AND_HEIGHT';
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

  // Tabular numbers for all Inter Tight text. Brand convention — keeps
  // amounts, counts, and timestamps optically aligned across rows.
  // The Figma plugin typings flag openTypeFeatures as readonly, but the
  // runtime exposes `setRangeOpenTypeFeatures` on TextNode in current Figma
  // versions. We call it via an `unknown` cast and swallow any error so the
  // import still succeeds on older runtimes that don't have the setter.
  if (/^inter\s*tight\b/i.test(resolution.font.family) && node.characters.length > 0) {
    type FeatureSetter = {
      setRangeOpenTypeFeatures?: (start: number, end: number, value: Record<string, boolean>) => void;
    };
    const setter = (text as unknown as FeatureSetter).setRangeOpenTypeFeatures;
    if (typeof setter === 'function') {
      try {
        setter.call(text, 0, node.characters.length, { TNUM: true });
      } catch {
        // TNUM may not be supported on the loaded font face; safe to skip.
      }
    }
  }
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
