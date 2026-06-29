/**
 * Pre-load every text + paint style key listed in library-manifest.ts into
 * the current Figma file. After this resolves, getLocalTextStylesAsync /
 * getLocalPaintStylesAsync include the library styles, so the token-applier
 * pass can match against them.
 *
 * No-op for keys that are already imported. Quietly skips keys the user can't
 * access (rare — typically only happens when a library has been deleted).
 */

import { LIBRARY_TEXT_STYLES, LIBRARY_PAINT_STYLES, LIBRARY_COLOUR_VARIABLES } from './library-manifest';

export type LibraryImportReport = {
  attempted: number;
  imported: number;
  failed: number;
};

export async function ensureLibraryStylesImported(): Promise<LibraryImportReport> {
  const styleEntries = [...LIBRARY_TEXT_STYLES, ...LIBRARY_PAINT_STYLES];
  const variableEntries = [...LIBRARY_COLOUR_VARIABLES];
  if (styleEntries.length === 0 && variableEntries.length === 0) {
    return { attempted: 0, imported: 0, failed: 0 };
  }

  let imported = 0;
  let failed = 0;
  const CONCURRENCY = 8;

  // Styles
  {
    let i = 0;
    async function worker(): Promise<void> {
      while (i < styleEntries.length) {
        const entry = styleEntries[i++];
        try {
          await figma.importStyleByKeyAsync(entry.key);
          imported++;
        } catch {
          failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  // Variables (when library publishes them via REST — Enterprise plan)
  {
    let i = 0;
    async function worker(): Promise<void> {
      while (i < variableEntries.length) {
        const entry = variableEntries[i++];
        try {
          await figma.variables.importVariableByKeyAsync(entry.key);
          imported++;
        } catch {
          failed++;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  return { attempted: styleEntries.length + variableEntries.length, imported, failed };
}
