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

type LibraryVariableDescriptor = { key: string; name: string; collectionKey: string };

type ColorVar = {
  variable: Variable;
  /** Resolved RGB (0..1). Some variables are aliases — we resolve once. */
  rgb: { r: number; g: number; b: number };
};

export type TokenApplyReport = {
  colors: { tried: number; matched: number; samples: string[] };
  textStyles: { tried: number; matched: number; samples: string[] };
};

export async function applyLibraryTokens(root: SceneNode): Promise<TokenApplyReport> {
  const colourReport = await applyColourVariables(root);
  const textReport = await applyTextStyles(root);
  return { colors: colourReport, textStyles: textReport };
}

// ---- colour variable matching -----------------------------------------------

async function applyColourVariables(root: SceneNode): Promise<TokenApplyReport['colors']> {
  const colourVars = await collectAllColourVariables();
  if (colourVars.length === 0) return { tried: 0, matched: 0, samples: [] };

  let tried = 0;
  let matched = 0;
  const samples: string[] = [];

  walkAll(root, (node) => {
    const targets: { paints: Paint[]; field: VariableBindablePaintField; setter: (paints: Paint[]) => void }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = node as any;
    if (Array.isArray(n.fills)) {
      targets.push({
        paints: n.fills as Paint[],
        field: 'color',
        setter: (paints) => { n.fills = paints; },
      });
    }
    if (Array.isArray(n.strokes)) {
      targets.push({
        paints: n.strokes as Paint[],
        field: 'color',
        setter: (paints) => { n.strokes = paints; },
      });
    }
    for (const { paints, field, setter } of targets) {
      let changed = false;
      const next = paints.map((paint) => {
        if (paint.type !== 'SOLID') return paint;
        const match = findClosestColour(paint.color, colourVars);
        tried++;
        if (!match) return paint;
        matched++;
        if (samples.length < 6) samples.push(match.variable.name);
        changed = true;
        return figma.variables.setBoundVariableForPaint(paint, field, match.variable);
      });
      if (changed) setter(next);
    }
  });

  return { tried, matched, samples };
}

async function collectAllColourVariables(): Promise<ColorVar[]> {
  const local = await figma.variables.getLocalVariablesAsync('COLOR');
  const out: ColorVar[] = [];
  for (const v of local) {
    const rgb = resolveDefaultColour(v);
    if (rgb) out.push({ variable: v, rgb });
  }
  // Library collections — must be enabled by the user in the file's library
  // panel for these to surface. Quietly skip if the API fails.
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const collection of collections) {
      let libVars: LibraryVariableDescriptor[] = [];
      try {
        libVars = (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key)) as unknown as LibraryVariableDescriptor[];
      } catch {
        continue;
      }
      for (const libVar of libVars) {
        // We don't know the type from the descriptor; importing tells us.
        try {
          const imported = await figma.variables.importVariableByKeyAsync(libVar.key);
          if (imported.resolvedType !== 'COLOR') continue;
          const rgb = resolveDefaultColour(imported);
          if (rgb) out.push({ variable: imported, rgb });
        } catch {
          // skip — likely a non-colour or inaccessible variable
        }
      }
    }
  } catch {
    // teamLibrary may be unavailable in some plugin contexts
  }
  return out;
}

function resolveDefaultColour(v: Variable): { r: number; g: number; b: number } | null {
  // A variable has one value per mode. We don't know which mode the user is
  // viewing — just take the first non-alias value as a representative.
  for (const modeId of Object.keys(v.valuesByMode)) {
    const value = v.valuesByMode[modeId];
    if (value && typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
      const c = value as { r: number; g: number; b: number };
      return { r: c.r, g: c.g, b: c.b };
    }
  }
  return null;
}

/** Find the closest colour variable within a small perceptual distance.
 *  Returns null if nothing is close enough. */
function findClosestColour(
  target: { r: number; g: number; b: number },
  vars: ColorVar[],
): ColorVar | null {
  let best: ColorVar | null = null;
  let bestDist = Infinity;
  for (const v of vars) {
    const dr = (v.rgb.r - target.r) * 255;
    const dg = (v.rgb.g - target.g) * 255;
    const db = (v.rgb.b - target.b) * 255;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  // Threshold ~6 in RGB Euclidean. Tight enough to avoid mis-matches, loose
  // enough to absorb 1-2 bit rounding from CSS computed values.
  if (bestDist > 6) return null;
  return best;
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
