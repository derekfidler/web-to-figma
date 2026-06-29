# web-to-figma

A Figma plugin that converts any webpage into editable Figma layers.

Headless Playwright renders the page server-side, a DOM walker extracts computed styles, images are inlined as base64, and a Figma plugin reconstructs the result as native nodes.

## Status

Active development. Renderer works end-to-end against `flatpay.com` (690 nodes, all images inlined). Plugin not yet built.

## Layout

```
packages/
├── renderer/   Node + Playwright + Express. Captures pages, returns JSON.
├── plugin/     Figma plugin. Consumes renderer JSON, builds Figma nodes.
└── shared/     TypeScript types shared between renderer and plugin.
```

## Local dev

```bash
npm install
npx playwright install chromium
npm --workspace @web-to-figma/renderer run dev       # http://localhost:4321
npm --workspace @web-to-figma/renderer run capture -- https://flatpay.com desktop
```

Captures are written to `packages/renderer/captures/` as JSON.
