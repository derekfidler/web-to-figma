/**
 * Pre-load every text + paint style key listed in library-manifest.ts into
 * the current Figma file. After this resolves, getLocalTextStylesAsync /
 * getLocalPaintStylesAsync include the library styles, so the token-applier
 * pass can match against them.
 *
 * No-op for keys that are already imported. Quietly skips keys the user can't
 * access (rare — typically only happens when a library has been deleted).
 */

import { LIBRARY_TEXT_STYLES, LIBRARY_PAINT_STYLES } from './library-manifest';

export type LibraryImportReport = {
  attempted: number;
  imported: number;
  failed: number;
};

export async function ensureLibraryStylesImported(): Promise<LibraryImportReport> {
  const allEntries = [...LIBRARY_TEXT_STYLES, ...LIBRARY_PAINT_STYLES];
  if (allEntries.length === 0) return { attempted: 0, imported: 0, failed: 0 };

  let imported = 0;
  let failed = 0;

  // Run in parallel but cap concurrency so the Figma plugin sandbox stays
  // responsive. importStyleByKeyAsync is cheap when the style is already
  // present locally.
  const CONCURRENCY = 8;
  let index = 0;
  async function worker(): Promise<void> {
    while (index < allEntries.length) {
      const entry = allEntries[index++];
      try {
        await figma.importStyleByKeyAsync(entry.key);
        imported++;
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return { attempted: allEntries.length, imported, failed };
}
