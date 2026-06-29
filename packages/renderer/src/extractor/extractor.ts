/**
 * Browser-side DOM extractor.
 *
 * Runs inside `page.evaluate()` — has access to `window`, `document`, `getComputedStyle`.
 * Has NO access to anything outside this file scope (no Node APIs, no imports).
 *
 * Returns a JSON-safe tree of pre-Figma scene nodes. Elements that we can't
 * cleanly reconstruct from styles + text (inline SVGs, icon-font glyphs, canvases,
 * videos, elements with complex background-images) are tagged with `__needsScreenshot`
 * and given a stable `[data-w2f-id]` attribute. The server then takes element
 * screenshots and turns them into IMAGE nodes before responding.
 */

import type { LayoutHint, RGBA, Stroke } from '@web-to-figma/shared';

/** Public entry — called by the renderer via page.evaluate(extractorBody, options) */
export type ExtractorOptions = {
  rootSelector?: string;
  /** Tag elements with this attribute so the server can screenshot them. */
  screenshotAttr?: string;
};

/** The browser returns this — it's a pre-final tree. Server post-processes screenshots. */
export type IntermediateNode = {
  __kind: 'frame' | 'text' | 'image' | 'vector' | 'rect';
  __id: string;
  /** When set, server must screenshot this element and replace this node with an IMAGE node. */
  __needsScreenshot?: { reason: string };
  /** Selector attribute value the server uses to find this element. */
  __selector?: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  layout?: LayoutHint;

  // Frame/Rect/Image fields
  fills?: Fill[];
  strokes?: Stroke[];
  cornerRadius?: number | { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
  effects?: Effect[];
  clipsContent?: boolean;

  // Text fields
  characters?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacingPx?: number;
  textAlign?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textTransform?: 'NONE' | 'UPPER' | 'LOWER' | 'CAPITALIZE';
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';

  // Image fields
  src?: string;

  // Vector fields
  svg?: string;

  children?: IntermediateNode[];
};

type Fill =
  | { type: 'SOLID'; color: RGBA }
  | { type: 'GRADIENT_LINEAR'; stops: { position: number; color: RGBA }[]; angle: number }
  | { type: 'IMAGE'; src: string; scaleMode: 'FILL' | 'FIT' | 'TILE' | 'STRETCH' };

type Effect =
  | { type: 'DROP_SHADOW'; color: RGBA; offset: { x: number; y: number }; radius: number; spread?: number }
  | { type: 'INNER_SHADOW'; color: RGBA; offset: { x: number; y: number }; radius: number; spread?: number };

/**
 * Stringified body of the extractor function. The renderer ships this to Playwright
 * via `page.evaluate(new Function('return ' + extractorSource)())`.
 */
export const extractorSource = /* js */ `
(function() {
  'use strict';

  // ---- helpers ----------------------------------------------------------------

  function uuid() {
    // crypto.randomUUID exists in all modern browsers
    return (crypto && crypto.randomUUID && crypto.randomUUID()) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function parseColor(input) {
    if (!input || input === 'transparent') return null;
    // rgba(r, g, b, a) or rgb(r, g, b)
    const m = input.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b, a] = parts;
    if (a === 0) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a: a == null ? 1 : a };
  }

  function parseLinearGradient(input) {
    // linear-gradient(135deg, #abc 0%, #def 100%)
    const m = input.match(/linear-gradient\\(([^)]+)\\)/);
    if (!m) return null;
    const body = m[1];
    // Split on commas not inside parens
    const parts = [];
    let depth = 0, last = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
      else if (body[i] === ',' && depth === 0) { parts.push(body.slice(last, i)); last = i + 1; }
    }
    parts.push(body.slice(last));

    let angle = 180; // default "to bottom"
    let stopParts = parts;
    const first = parts[0].trim();
    if (first.endsWith('deg')) {
      angle = parseFloat(first);
      stopParts = parts.slice(1);
    } else if (first.startsWith('to ')) {
      const map = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
                    'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 };
      angle = map[first] || 180;
      stopParts = parts.slice(1);
    }

    const stops = stopParts.map((s, i) => {
      const t = s.trim();
      const pctMatch = t.match(/(\\d+(?:\\.\\d+)?)%\\s*$/);
      const colorPart = pctMatch ? t.slice(0, pctMatch.index).trim() : t;
      const color = parseColorAny(colorPart);
      const position = pctMatch ? parseFloat(pctMatch[1]) / 100 : i / Math.max(1, stopParts.length - 1);
      return color ? { position, color } : null;
    }).filter(Boolean);

    if (stops.length < 2) return null;
    return { type: 'GRADIENT_LINEAR', angle, stops };
  }

  function parseColorAny(input) {
    if (!input) return null;
    if (input.startsWith('#')) {
      const hex = input.slice(1);
      const len = hex.length;
      if (len === 3 || len === 4) {
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        const a = len === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
        return { r: r / 255, g: g / 255, b: b / 255, a };
      }
      if (len === 6 || len === 8) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = len === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        return { r: r / 255, g: g / 255, b: b / 255, a };
      }
    }
    return parseColor(input);
  }

  function parseBoxShadow(input) {
    // "0 4px 6px rgba(0,0,0,0.1)" or "inset 0 0 10px #000, 0 1px 2px #abc"
    if (!input || input === 'none') return [];
    // Split top-level commas
    const parts = [];
    let depth = 0, last = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i] === '(') depth++;
      else if (input[i] === ')') depth--;
      else if (input[i] === ',' && depth === 0) { parts.push(input.slice(last, i)); last = i + 1; }
    }
    parts.push(input.slice(last));

    return parts.map(p => {
      const t = p.trim();
      const inset = /^inset\\b/.test(t);
      const cleaned = inset ? t.replace(/^inset\\s+/, '') : t;
      // Extract color
      let color = null;
      const colorMatch = cleaned.match(/rgba?\\([^)]+\\)|#[0-9a-fA-F]+/);
      let numericPart = cleaned;
      if (colorMatch) {
        color = parseColorAny(colorMatch[0]);
        numericPart = (cleaned.slice(0, colorMatch.index) + cleaned.slice(colorMatch.index + colorMatch[0].length)).trim();
      }
      const nums = numericPart.split(/\\s+/).map(parseFloat).filter(n => !isNaN(n));
      if (nums.length < 2 || !color) return null;
      const [offsetX, offsetY, blur = 0, spread = 0] = nums;
      return {
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color,
        offset: { x: offsetX, y: offsetY },
        radius: blur,
        spread,
      };
    }).filter(Boolean);
  }

  function parseCornerRadius(cs) {
    // border-radius can have 1-4 values
    const tl = parseFloat(cs.borderTopLeftRadius) || 0;
    const tr = parseFloat(cs.borderTopRightRadius) || 0;
    const br = parseFloat(cs.borderBottomRightRadius) || 0;
    const bl = parseFloat(cs.borderBottomLeftRadius) || 0;
    if (tl === tr && tr === br && br === bl) return tl > 0 ? tl : 0;
    return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
  }

  function parseStroke(cs) {
    // Use shorthand if all sides match, else first side
    const widths = ['Top', 'Right', 'Bottom', 'Left'].map(s => parseFloat(cs['border' + s + 'Width']) || 0);
    const allEqual = widths.every(w => w === widths[0]);
    if (!allEqual || widths[0] === 0) return null;
    const color = parseColorAny(cs.borderTopColor);
    if (!color) return null;
    const styleMap = { solid: undefined, dashed: [6, 4], dotted: [2, 2] };
    return {
      color,
      weight: widths[0],
      align: 'INSIDE',
      dashPattern: styleMap[cs.borderTopStyle],
    };
  }

  function parseFills(cs) {
    const fills = [];
    const bgImage = cs.backgroundImage;
    if (bgImage && bgImage !== 'none') {
      // url(...) or linear-gradient(...)
      const urlMatch = bgImage.match(/url\\(["']?([^)"']+)["']?\\)/);
      if (urlMatch) {
        const src = urlMatch[1];
        const scaleModeMap = { cover: 'FILL', contain: 'FIT', auto: 'TILE' };
        const scaleMode = scaleModeMap[cs.backgroundSize] || 'FILL';
        fills.push({ type: 'IMAGE', src, scaleMode });
      }
      const grad = parseLinearGradient(bgImage);
      if (grad) fills.push(grad);
    }
    const bg = parseColor(cs.backgroundColor);
    if (bg) {
      // Solid bg goes UNDER image fills in Figma rendering, so prepend
      fills.unshift({ type: 'SOLID', color: bg });
    }
    return fills;
  }

  function parseLayout(cs) {
    if (cs.display === 'flex' || cs.display === 'inline-flex') {
      const isRow = cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse' || cs.flexDirection === '';
      const map = { 'flex-start': 'MIN', 'center': 'CENTER', 'flex-end': 'MAX', 'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN' };
      const cMap = { 'flex-start': 'MIN', 'center': 'CENTER', 'flex-end': 'MAX', 'stretch': 'MIN', 'baseline': 'MIN' };
      const gap = parseFloat(cs.gap) || parseFloat(cs.columnGap) || 0;
      return {
        mode: isRow ? 'HORIZONTAL' : 'VERTICAL',
        primaryAlign: map[cs.justifyContent] || 'MIN',
        counterAlign: cMap[cs.alignItems] || 'MIN',
        itemSpacing: gap,
        paddingLeft: parseFloat(cs.paddingLeft) || 0,
        paddingRight: parseFloat(cs.paddingRight) || 0,
        paddingTop: parseFloat(cs.paddingTop) || 0,
        paddingBottom: parseFloat(cs.paddingBottom) || 0,
      };
    }
    return undefined;
  }

  // ---- predicates -------------------------------------------------------------

  function isHidden(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return true;
    return false;
  }

  const ICON_FONT_REGEX = /material\\s*icons|material\\s*symbols|font\\s*awesome|fa-|iconfont|ionicons|fontello|glyphicons/i;
  function isIconFontElement(el, cs) {
    if (!cs.fontFamily) return false;
    if (!ICON_FONT_REGEX.test(cs.fontFamily)) return false;
    // Must have visible text content (the glyph)
    const text = (el.textContent || '').trim();
    return text.length > 0 && text.length < 20; // icon fonts use 1-2 char glyphs or ligatures like 'home'
  }

  function isInlineSvg(el) {
    return el.tagName === 'svg' || el.tagName === 'SVG';
  }

  function isMediaElement(el) {
    return el.tagName === 'CANVAS' || el.tagName === 'VIDEO';
  }

  function isLeafImageElement(el) {
    return el.tagName === 'IMG';
  }

  function isPureTextLeaf(el) {
    // Only text content, no element children
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) return false;
    }
    return (el.textContent || '').trim().length > 0;
  }

  function isInteresting(el, cs) {
    // Decide whether an element contributes a visible Figma node, vs being a pass-through.
    // Anything with bg, border, shadow, image, text, or specific shape characteristics is interesting.
    if (parseColor(cs.backgroundColor)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    if (parseStroke(cs)) return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    if (parseCornerRadius(cs) !== 0) return true;
    if (isPureTextLeaf(el)) return true;
    if (isLeafImageElement(el) || isInlineSvg(el) || isMediaElement(el)) return true;
    return false;
  }

  function nameForElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
      : '';
    const text = isPureTextLeaf(el) ? ' — "' + (el.textContent || '').trim().slice(0, 24) + '"' : '';
    return (tag + id + cls + text).slice(0, 64);
  }

  // ---- main walker ------------------------------------------------------------

  const SCREENSHOT_ATTR = (typeof __OPTIONS__ !== 'undefined' && __OPTIONS__.screenshotAttr) || 'data-w2f-id';
  const ROOT_SELECTOR = (typeof __OPTIONS__ !== 'undefined' && __OPTIONS__.rootSelector) || 'body';

  function walk(el, parentRect) {
    if (!(el instanceof Element)) return null;
    const cs = getComputedStyle(el);
    if (isHidden(el, cs)) return null;

    const rect = el.getBoundingClientRect();
    const x = parentRect ? rect.left - parentRect.left : rect.left;
    const y = parentRect ? rect.top - parentRect.top : rect.top;

    const baseProps = {
      __id: uuid(),
      name: nameForElement(el),
      x, y,
      width: rect.width,
      height: rect.height,
      opacity: parseFloat(cs.opacity) !== 1 ? parseFloat(cs.opacity) : undefined,
    };

    // === Cases where we screenshot the element and return an IMAGE node ===

    if (isIconFontElement(el, cs) || isInlineSvg(el) || isMediaElement(el)) {
      const id = uuid();
      el.setAttribute(SCREENSHOT_ATTR, id);
      return {
        ...baseProps,
        __kind: 'image',
        __needsScreenshot: { reason: isInlineSvg(el) ? 'svg' : isMediaElement(el) ? 'media' : 'icon-font' },
        __selector: id,
      };
    }

    // === <img> — capture src directly, server fetches and inlines ===
    if (isLeafImageElement(el)) {
      return {
        ...baseProps,
        __kind: 'image',
        src: el.currentSrc || el.src,
      };
    }

    // === Pure text leaf ===
    if (isPureTextLeaf(el)) {
      const characters = (el.textContent || '').trim();
      const textAlignMap = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED', start: 'LEFT', end: 'RIGHT' };
      const transformMap = { uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'CAPITALIZE' };
      const decorationMap = { underline: 'UNDERLINE', 'line-through': 'STRIKETHROUGH' };
      const lineHeightVal = parseFloat(cs.lineHeight);
      return {
        ...baseProps,
        __kind: 'text',
        characters,
        fontFamily: (cs.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim(),
        fontWeight: parseInt(cs.fontWeight) || 400,
        fontSize: parseFloat(cs.fontSize) || 16,
        lineHeightPx: !isNaN(lineHeightVal) ? lineHeightVal : undefined,
        letterSpacingPx: parseFloat(cs.letterSpacing) || undefined,
        textAlign: textAlignMap[cs.textAlign] || 'LEFT',
        textTransform: transformMap[cs.textTransform] || 'NONE',
        textDecoration: decorationMap[cs.textDecorationLine] || 'NONE',
        fills: [{ type: 'SOLID', color: parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 } }],
      };
    }

    // === Container: walk children ===
    const childNodes = [];
    for (const child of el.children) {
      const childNode = walk(child, rect);
      if (childNode) childNodes.push(childNode);
    }
    // Anonymous text nodes (text directly inside a container with other elements)
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent || '').trim();
        if (t.length > 0) {
          const range = document.createRange();
          range.selectNode(node);
          const tRect = range.getBoundingClientRect();
          range.detach();
          if (tRect.width > 0 && tRect.height > 0) {
            childNodes.push({
              __id: uuid(),
              __kind: 'text',
              name: '"' + t.slice(0, 24) + '"',
              x: tRect.left - rect.left,
              y: tRect.top - rect.top,
              width: tRect.width,
              height: tRect.height,
              characters: t,
              fontFamily: (cs.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim(),
              fontWeight: parseInt(cs.fontWeight) || 400,
              fontSize: parseFloat(cs.fontSize) || 16,
              textAlign: 'LEFT',
              fills: [{ type: 'SOLID', color: parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 } }],
            });
          }
        }
      }
    }

    const fills = parseFills(cs);
    const strokes = parseStroke(cs);
    const cornerRadius = parseCornerRadius(cs);
    const effects = parseBoxShadow(cs.boxShadow);
    const layout = parseLayout(cs);
    const clipsContent = cs.overflow === 'hidden' || cs.overflow === 'scroll' || cs.overflow === 'auto';

    // If the element has no children AND nothing interesting, return null (pass-through)
    if (childNodes.length === 0 && !isInteresting(el, cs)) {
      return null;
    }

    return {
      ...baseProps,
      __kind: 'frame',
      fills,
      strokes: strokes ? [strokes] : undefined,
      cornerRadius: cornerRadius || undefined,
      effects: effects.length ? effects : undefined,
      layout,
      clipsContent: clipsContent || undefined,
      children: childNodes,
    };
  }

  const root = document.querySelector(ROOT_SELECTOR);
  if (!root) return { error: 'root_selector_not_found', selector: ROOT_SELECTOR };

  // Scroll to top to get consistent bbox
  window.scrollTo(0, 0);

  const tree = walk(root, null);
  return {
    title: document.title,
    url: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    tree,
  };
})()
`;

export function buildExtractorCall(options: ExtractorOptions = {}): string {
  // Inline options into the script so we don't have to pass args.
  // Parens around extractorSource are LOAD-BEARING: without them, the `return`
  // on the previous line + ASI on extractorSource's leading newline produces
  // `return;` and silently swallows the IIFE.
  const optionsJson = JSON.stringify({
    rootSelector: options.rootSelector ?? 'body',
    screenshotAttr: options.screenshotAttr ?? 'data-w2f-id',
  });
  return `(function() { var __OPTIONS__ = ${optionsJson}; return (${extractorSource}); })()`;
}
