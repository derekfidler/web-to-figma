/**
 * After buildScene finishes, walk the imported subtree and try to swap raw
 * style values for design-system tokens already known to this Figma file.
 *
 * Two passes:
 *   1. Colour variables — for every SOLID fill / stroke whose colour matches
 *      a local or library colour variable within a small RGB delta, bind the
 *      variable to that paint. The captured raw RGB stays as the fallback.
 *   2. Text styles — for every TEXT node whose (family, weight, size) matches
 *      a known local text style, apply that style ID. As a side effect, any
 *      OpenType features (TNUM, etc.) baked into the style ride along —
 *      sidestepping the Figma plugin API's missing OpenType setter.
 *
 * Returns a report the UI can show so the user knows what got tokenised.
 */


export type TokenApplyReport = {
  colors: {
    tried: number;
    matched: number;
    samples: string[];
    pool: {
      localVariables: number;
      localPaintStyles: number;
      libraryCollections: number;
      libraryVariables: number;
      errors: string[];
    };
  };
  textStyles: { tried: number; matched: number; samples: string[] };
};

export async function applyLibraryTokens(root: SceneNode): Promise<TokenApplyReport> {
  // Try both colour systems in one combined pool so the closest match wins
  // regardless of whether the library publishes variables or paint styles.
  const colourReport = await applyColourTokens(root);
  const textReport = await applyTextStyles(root);
  return { colors: colourReport, textStyles: textReport };
}

// ---- colour token matching --------------------------------------------------

type ColourToken =
  | {
      kind: 'variable';
      variable: Variable;
      name: string;
      /** "{collectionName}/{variableName}" — gives the matcher access to the
       *  hierarchical context, since variables often have terse leaf names
       *  whose meaning is defined by their collection. */
      fullPath: string;
      rgb: { r: number; g: number; b: number };
    }
  | {
      kind: 'paintStyle';
      style: PaintStyle;
      name: string;
      fullPath: string;
      rgb: { r: number; g: number; b: number };
    };

async function applyColourTokens(root: SceneNode): Promise<TokenApplyReport['colors']> {
  const { pool, diagnostics } = await collectAllColourTokens();
  if (pool.length === 0) return { tried: 0, matched: 0, samples: [], pool: diagnostics };

  let tried = 0;
  let matched = 0;
  const samples: string[] = [];
  const sampleSet = new Set<string>();

  const promises: Promise<void>[] = [];

  walkAll(root, (node) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    // Fill context depends on the node — text-node fills are text colours,
    // everything else is a background/surface fill.
    const fillContext: ColourContext = node.type === 'TEXT' ? 'text' : 'background';
    // Fills (single-fill SOLID is the common case; we handle that path well.
    // For multi-fill nodes, fall back to per-paint variable binding.)
    if (Array.isArray(n.fills)) {
      const fills = n.fills as Paint[];
      const onlySolid = fills.length === 1 && fills[0].type === 'SOLID';

      if (onlySolid) {
        const paint = fills[0] as SolidPaint;
        tried++;
        const match = findClosestColour(paint.color, pool, fillContext);
        if (match) {
          matched++;
          if (!sampleSet.has(match.fullPath) && sampleSet.size < 6) {
            samples.push(match.fullPath);
            sampleSet.add(match.fullPath);
          }
          if (match.kind === 'paintStyle') {
            // Apply paint style — single async call replaces fills with the
            // style's fills. Style binding survives because we don't override
            // node.fills afterwards.
            promises.push(
              (async () => {
                try {
                  if ('setFillStyleIdAsync' in n && typeof n.setFillStyleIdAsync === 'function') {
                    await n.setFillStyleIdAsync(match.style.id);
                  } else {
                    n.fillStyleId = match.style.id;
                  }
                } catch {/* skip */}
              })(),
            );
          } else {
            n.fills = [figma.variables.setBoundVariableForPaint(paint, 'color', match.variable)];
          }
        }
      } else {
        // Multi-fill: bind variables paint-by-paint (paint styles are
        // node-level so we can't mix per-paint).
        let changed = false;
        const next = fills.map((paint) => {
          if (paint.type !== 'SOLID') return paint;
          tried++;
          const match = findClosestColour(paint.color, pool, fillContext);
          if (!match || match.kind !== 'variable') return paint;
          matched++;
          if (!sampleSet.has(match.fullPath) && sampleSet.size < 6) {
            samples.push(match.fullPath);
            sampleSet.add(match.fullPath);
          }
          changed = true;
          return figma.variables.setBoundVariableForPaint(paint, 'color', match.variable);
        });
        if (changed) n.fills = next;
      }
    }

    if (Array.isArray(n.strokes)) {
      const strokes = n.strokes as Paint[];
      let changed = false;
      const next = strokes.map((paint) => {
        if (paint.type !== 'SOLID') return paint;
        tried++;
        const match = findClosestColour(paint.color, pool, 'border');
        if (!match || match.kind !== 'variable') return paint;
        matched++;
        if (!sampleSet.has(match.name) && sampleSet.size < 6) {
          samples.push(match.name);
          sampleSet.add(match.name);
        }
        changed = true;
        return figma.variables.setBoundVariableForPaint(paint, 'color', match.variable);
      });
      if (changed) n.strokes = next;
    }
  });

  await Promise.all(promises);
  return { tried, matched, samples, pool: diagnostics };
}

async function collectAllColourTokens(): Promise<{
  pool: ColourToken[];
  diagnostics: TokenApplyReport['colors']['pool'];
}> {
  const out: ColourToken[] = [];
  const diagnostics: TokenApplyReport['colors']['pool'] = {
    localVariables: 0,
    localPaintStyles: 0,
    libraryCollections: 0,
    libraryVariables: 0,
    errors: [],
  };

  // Cache collection name lookups so we resolve each one only once.
  const collectionCache = new Map<string, string>();
  async function collectionName(id: string): Promise<string> {
    if (collectionCache.has(id)) return collectionCache.get(id)!;
    try {
      const c = await figma.variables.getVariableCollectionByIdAsync(id);
      const name = c?.name ?? '';
      collectionCache.set(id, name);
      return name;
    } catch {
      collectionCache.set(id, '');
      return '';
    }
  }

  // Local colour variables
  try {
    const local = await figma.variables.getLocalVariablesAsync('COLOR');
    diagnostics.localVariables = local.length;
    for (const v of local) {
      const rgb = await resolveDefaultColour(v);
      if (!rgb) continue;
      const collName = await collectionName(v.variableCollectionId);
      const fullPath = (collName ? `${collName}/${v.name}` : v.name).toLowerCase();
      out.push({ kind: 'variable', variable: v, name: v.name, fullPath, rgb });
    }
  } catch (err) {
    diagnostics.errors.push(`getLocalVariablesAsync: ${(err as Error).message}`);
  }

  // Local paint (colour) styles
  try {
    const styles = await figma.getLocalPaintStylesAsync();
    diagnostics.localPaintStyles = styles.length;
    for (const s of styles) {
      const solid = s.paints.find((p) => p.type === 'SOLID') as SolidPaint | undefined;
      if (!solid) continue;
      out.push({ kind: 'paintStyle', style: s, name: s.name, fullPath: s.name.toLowerCase(), rgb: solid.color });
    }
  } catch (err) {
    diagnostics.errors.push(`getLocalPaintStylesAsync: ${(err as Error).message}`);
  }

  // Library colour variables (enabled team library collections only).
  // Excluded libraries (Web UI Kit shadow/spacing variables) are skipped.
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    diagnostics.libraryCollections = collections.length;
    for (const collection of collections) {
      const lib = (collection.libraryName ?? '').toLowerCase();
      if (EXCLUDED_COLOUR_LIBRARIES.some((ex) => lib.includes(ex))) continue;
      let libVars: { key: string; name: string; resolvedType?: string }[] = [];
      try {
        libVars = (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key)) as unknown as typeof libVars;
      } catch (err) {
        diagnostics.errors.push(`getVariablesInLibraryCollectionAsync(${collection.name}): ${(err as Error).message}`);
        continue;
      }
      for (const libVar of libVars) {
        if (libVar.resolvedType && libVar.resolvedType !== 'COLOR') continue;
        try {
          const imported = await figma.variables.importVariableByKeyAsync(libVar.key);
          if (imported.resolvedType !== 'COLOR') continue;
          diagnostics.libraryVariables++;
          const rgb = await resolveDefaultColour(imported);
          if (!rgb) continue;
          const fullPath = `${collection.name}/${imported.name}`.toLowerCase();
          out.push({ kind: 'variable', variable: imported, name: imported.name, fullPath, rgb });
        } catch (err) {
          if (diagnostics.errors.length < 3) {
            diagnostics.errors.push(`importVariableByKeyAsync(${libVar.name}): ${(err as Error).message}`);
          }
        }
      }
    }
  } catch (err) {
    diagnostics.errors.push(`getAvailableLibraryVariableCollectionsAsync: ${(err as Error).message}`);
  }

  return { pool: out, diagnostics };
}

async function resolveDefaultColour(
  v: Variable,
  depth = 0,
): Promise<{ r: number; g: number; b: number } | null> {
  // Resolve in the collection's default mode (typically "Light"). Without
  // this, multi-mode variables (Light/Dark, theme variants) return whichever
  // mode happens to be first in valuesByMode, which often gives the wrong
  // RGB and ends up matching text-secondary to text-primary (or worse).
  if (depth > 6) return null;
  const collection = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId).catch(() => null);
  const defaultMode = collection?.defaultModeId;
  // Try default mode first, then fall back to whatever's available.
  const modeIds = defaultMode
    ? [defaultMode, ...Object.keys(v.valuesByMode).filter((m) => m !== defaultMode)]
    : Object.keys(v.valuesByMode);

  for (const modeId of modeIds) {
    const value = v.valuesByMode[modeId];
    if (!value || typeof value !== 'object') continue;
    if ('r' in value && 'g' in value && 'b' in value) {
      const c = value as { r: number; g: number; b: number };
      return { r: c.r, g: c.g, b: c.b };
    }
    if ((value as { type?: string }).type === 'VARIABLE_ALIAS') {
      const aliasId = (value as { id: string }).id;
      try {
        const aliased = await figma.variables.getVariableByIdAsync(aliasId);
        if (aliased) {
          const resolved = await resolveDefaultColour(aliased, depth + 1);
          if (resolved) return resolved;
        }
      } catch {
        /* alias points to a variable we can't access; skip */
      }
    }
  }
  return null;
}

type ColourContext = 'text' | 'background' | 'border';

/** Find the closest colour token, balancing colour distance against name
 *  context. CSS-rendered colours often differ slightly from the design
 *  system's canonical value (e.g. body text `color: black` (#000) vs
 *  color/text/primary (#1A1A1A)). A strict colour threshold misses these,
 *  so we keep two windows: a tight one that always qualifies and a wider
 *  one reserved for strongly context-matching names. */
function findClosestColour(
  target: { r: number; g: number; b: number },
  pool: ColourToken[],
  context: ColourContext,
): ColourToken | null {
  const TIGHT_DIST = 8; // any name qualifies within this radius
  const WIDE_DIST = 90; // for context-strong matches (semantic library or text/etc.)
  const STRONG_CONTEXT = 4; // a single positive keyword (+4) earns the wider window

  const candidates: { token: ColourToken; dist: number; ctx: number }[] = [];
  for (const t of pool) {
    const dr = (t.rgb.r - target.r) * 255;
    const dg = (t.rgb.g - target.g) * 255;
    const db = (t.rgb.b - target.b) * 255;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    const ctx = contextScore(t, context);
    const eligible = dist <= TIGHT_DIST || (dist <= WIDE_DIST && ctx >= STRONG_CONTEXT);
    if (eligible) candidates.push({ token: t, dist, ctx });
  }
  if (candidates.length === 0) return null;

  // Score: context dominates, distance modulates. Negative context can
  // out-weigh closeness so shadow/effect tokens lose to text/foreground tokens
  // even when the shadow is RGB-perfect.
  candidates.sort((a, b) => {
    const sa = a.ctx * 3 - a.dist * 0.15;
    const sb = b.ctx * 3 - b.dist * 0.15;
    return sb - sa;
  });
  return candidates[0].token;
}

/** Collections whose variables always win when in conflict. These are the
 *  Flatpay design-system surfaces — Colours & Themes / Color Semantic etc.
 *  Same idea as the brand-font overrides: cheaper than perfect heuristics. */
const PREFERRED_COLLECTIONS = [
  'colours & themes',
  'color semantic',
  'color components',
  'color primitives',
];

/** Library names whose colour variables we never want to match against.
 *  Web UI Kit publishes shadow/spacing tokens that share RGB with text and
 *  background tokens but aren't the right semantic answer for fills.
 *  Style imports from the manifest are unaffected — this only filters the
 *  colour-variable pool. */
const EXCLUDED_COLOUR_LIBRARIES = ['web ui kit'];

function contextScore(token: ColourToken, context: ColourContext): number {
  // fullPath includes the collection name so we get hierarchical context
  // (e.g. "color semantic/color/text/primary" vs "web ui kit/xs/color").
  const path = token.fullPath;
  let score = 0;

  // Heavy preference for Flatpay's semantic colour libraries — this single
  // signal dominates everything else.
  for (const pref of PREFERRED_COLLECTIONS) {
    if (path.startsWith(pref + '/') || path.includes('/' + pref + '/')) {
      score += 20;
      break;
    }
  }

  const positives: Record<ColourContext, string[]> = {
    text: ['text', 'foreground', 'label', 'heading', 'body', 'content'],
    background: ['background', 'surface', 'bg/', '/bg', 'canvas', 'fill', 'button'],
    border: ['border', 'stroke', 'outline', 'divider', 'separator'],
  };
  const negatives: Record<ColourContext, string[]> = {
    text: ['background', 'surface', 'shadow', 'border', 'stroke', 'icon', 'elevation'],
    background: ['text', 'foreground', 'shadow', 'icon', 'border', 'elevation'],
    border: ['text', 'foreground', 'background', 'surface', 'shadow', 'icon'],
  };
  for (const p of positives[context]) if (path.includes(p)) score += 4;
  for (const n of negatives[context]) if (path.includes(n)) score -= 4;

  // Always demote shadow / effect / overlay tokens.
  if (/(shadow|overlay|effect|elevation)/.test(path)) score -= 8;
  // Canonical naming bonus.
  if (/(^|\/)color(\/|-)/.test(path) || path.startsWith('color-')) score += 1;
  // Slight bias toward shorter, more general tokens.
  score -= path.length / 200;
  return score;
}

// ---- text style matching ----------------------------------------------------

async function applyTextStyles(root: SceneNode): Promise<TokenApplyReport['textStyles']> {
  const styles = await figma.getLocalTextStylesAsync();
  if (styles.length === 0) return { tried: 0, matched: 0, samples: [] };

  let tried = 0;
  let matched = 0;
  const samples: string[] = [];

  // Pre-load all style fonts so setRangeTextStyleIdAsync doesn't fail
  await Promise.all(
    styles.map(async (s) => {
      try {
        await figma.loadFontAsync(s.fontName);
      } catch {
        /* style may target a font that isn't installed; that's fine */
      }
    }),
  );

  const promises: Promise<void>[] = [];
  walkAll(root, (node) => {
    if (node.type !== 'TEXT') return;
    tried++;
    const text = node as TextNode;
    if (text.fontName === figma.mixed) return;
    const fn = text.fontName as FontName;
    const size = typeof text.fontSize === 'number' ? text.fontSize : 14;
    const style = findClosestStyle(styles, fn, size);
    if (!style) return;
    matched++;
    if (samples.length < 6) samples.push(`${style.name} ← ${fn.family}/${fn.style} ${size}px`);
    promises.push(
      (async () => {
        try {
          await text.setRangeTextStyleIdAsync(0, text.characters.length, style.id);
        } catch {
          /* font for style may not be loaded yet; skip silently */
        }
      })(),
    );
  });
  await Promise.all(promises);
  return { tried, matched, samples };
}

function findClosestStyle(styles: TextStyle[], fn: FontName, size: number): TextStyle | null {
  const familyLower = fn.family.toLowerCase();
  let best: TextStyle | null = null;
  let bestScore = Infinity;
  for (const s of styles) {
    if (s.fontName.family.toLowerCase() !== familyLower) continue;
    // Style match weight: same style name wins, otherwise closest by size only
    const styleMatch = s.fontName.style === fn.style ? 0 : 1;
    const sizeDelta = Math.abs(s.fontSize - size);
    if (sizeDelta > 2) continue; // refuse to coerce across size jumps
    const score = styleMatch * 10 + sizeDelta;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

// ---- helper ----------------------------------------------------------------

function walkAll(node: SceneNode, visit: (n: SceneNode) => void): void {
  visit(node);
  if ('children' in node) {
    for (const child of node.children) walkAll(child as SceneNode, visit);
  }
}
