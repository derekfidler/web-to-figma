/**
 * Shared types between the renderer service and the Figma plugin.
 * This file is imported by both packages — keep it dependency-free.
 */

export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
};

export const VIEWPORT_PRESETS: Record<'desktop' | 'tablet' | 'mobile', Viewport> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2 },
  mobile: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
};

export type CaptureRequest = {
  url: string;
  viewport?: Viewport | keyof typeof VIEWPORT_PRESETS;
  waitForSelector?: string;
  /** Additional ms to wait after networkidle. Default 500. */
  settleMs?: number;
};

export type CaptureResponse = {
  meta: CaptureMeta;
  root: SceneNode;
};

export type CaptureMeta = {
  url: string;
  title: string;
  capturedAt: string; // ISO
  viewport: Viewport;
  /** Wall-clock ms it took to render. */
  renderMs: number;
  /** Number of nodes in the resulting tree. */
  nodeCount: number;
};

/** The discriminated union of all node types we emit. Mirrors Figma's mental model. */
export type SceneNode =
  | FrameNode
  | TextNode
  | ImageNode
  | VectorNode
  | RectNode;

/** Common to all nodes. */
type NodeBase = {
  id: string;
  name: string;
  /** Bounds relative to the parent frame, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  /** Hint about how the original element was laid out. */
  layout?: LayoutHint;
};

export type LayoutHint = {
  mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  primaryAlign?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAlign?: 'MIN' | 'CENTER' | 'MAX';
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
};

export type FrameNode = NodeBase & {
  type: 'FRAME';
  fills: Fill[];
  strokes?: Stroke[];
  cornerRadius?: number | CornerRadii;
  effects?: Effect[];
  /** Overflow on the original element. Maps to clipsContent. */
  clipsContent?: boolean;
  children: SceneNode[];
};

export type TextNode = NodeBase & {
  type: 'TEXT';
  characters: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeightPx?: number;
  letterSpacingPx?: number;
  textAlign: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  fills: Fill[];
  textTransform?: 'NONE' | 'UPPER' | 'LOWER' | 'CAPITALIZE';
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
};

export type ImageNode = NodeBase & {
  type: 'IMAGE';
  /** Base64-encoded image bytes. */
  imageBase64: string;
  /** Original src. Useful for debugging and dedup. */
  src: string;
  mimeType: string;
  scaleMode: 'FILL' | 'FIT' | 'TILE' | 'STRETCH';
  cornerRadius?: number | CornerRadii;
};

export type VectorNode = NodeBase & {
  type: 'VECTOR';
  /** Full SVG outerHTML, ready for figma.createNodeFromSvgAsync. */
  svg: string;
};

/** Plain rectangle — backgrounds, dividers, anything that's not a frame container. */
export type RectNode = NodeBase & {
  type: 'RECT';
  fills: Fill[];
  strokes?: Stroke[];
  cornerRadius?: number | CornerRadii;
  effects?: Effect[];
};

export type CornerRadii = {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
};

export type Fill =
  | { type: 'SOLID'; color: RGBA }
  | { type: 'GRADIENT_LINEAR'; stops: GradientStop[]; angle: number }
  | { type: 'GRADIENT_RADIAL'; stops: GradientStop[] }
  | { type: 'IMAGE'; imageBase64: string; mimeType: string; scaleMode: 'FILL' | 'FIT' | 'TILE' | 'STRETCH' };

export type Stroke = {
  color: RGBA;
  weight: number;
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  dashPattern?: number[];
};

export type GradientStop = {
  position: number; // 0..1
  color: RGBA;
};

export type Effect =
  | { type: 'DROP_SHADOW'; color: RGBA; offset: { x: number; y: number }; radius: number; spread?: number }
  | { type: 'INNER_SHADOW'; color: RGBA; offset: { x: number; y: number }; radius: number; spread?: number };

export type RGBA = { r: number; g: number; b: number; a: number }; // each 0..1

export const PROTOCOL_VERSION = 1 as const;
