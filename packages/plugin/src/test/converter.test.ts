/**
 * Integration test for the converter, run against the real CLI capture output.
 *
 * Skips gracefully if no captures exist on disk (CI / fresh clones). When the
 * renderer has been run locally, this validates that the entire pipeline
 * produces a Figma node tree without throwing.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { figmaStub } from './figma-mock';
import { buildScene } from '../converter';
import type { CaptureResponse } from '@web-to-figma/shared';

const CAPTURES_DIR = resolve(__dirname, '../../../renderer/captures');

function findLatestCapture(): string | null {
  if (!existsSync(CAPTURES_DIR)) return null;
  const files = readdirSync(CAPTURES_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  files.sort();
  return resolve(CAPTURES_DIR, files[files.length - 1]);
}

describe('converter', () => {
  it('builds a tree from a real capture without throwing', async () => {
    const path = findLatestCapture();
    if (!path) {
      console.warn('no capture found, skipping');
      return;
    }
    figmaStub.reset();
    const capture = JSON.parse(readFileSync(path, 'utf8')) as CaptureResponse;
    const messages: string[] = [];
    const root = await buildScene(capture, { onProgress: (m) => messages.push(m) });
    expect(root).toBeTruthy();
    expect(root.type).toBe('FRAME');
    // The wrapper frame contains exactly one child (the page root frame)
    expect(root.children.length).toBe(1);
    // Spot-check that a reasonable number of figma.* calls happened
    const calls = figmaStub.log.length;
    expect(calls).toBeGreaterThan(capture.meta.nodeCount / 2);
    console.log(`✓ ${capture.meta.nodeCount} captured nodes → ${calls} figma calls`);
  });
});
