# web-to-figma

Convert any webpage into editable Figma layers. Headless renderer + native Figma plugin, no usage limits.

## What it does

- Renders the target URL in a headless Chromium (Playwright)
- Walks the DOM, extracts computed styles, downloads images, screenshots SVGs and icon-font glyphs
- Returns a JSON tree your Figma plugin reconstructs as real frames, text, image fills, and effects

## Architecture

```
┌─────────────────┐  HTTP   ┌──────────────────────┐
│   Figma plugin  │ ──────▶ │   Renderer service   │
│  (this repo)    │ ◀────── │  (Node + Playwright) │
└─────────────────┘  JSON   └──────────────────────┘
```

- **`packages/renderer/`** — Node + Playwright + Express. Headless browser, DOM walker, asset inliner.
- **`packages/plugin/`** — Figma plugin. UI + JSON → Figma node converter.
- **`packages/shared/`** — TypeScript types shared between the two.

## Local dev

Prereqs: Node 20+, Figma desktop app.

```bash
# 1. Install everything
npm install
cd packages/renderer && npx playwright install chromium && cd ../..

# 2. Run the renderer (terminal A)
npm --workspace @web-to-figma/renderer run dev
# → http://localhost:4321

# 3. Build the plugin (terminal B)
npm --workspace @web-to-figma/plugin run build
```

### Loading the Figma plugin

1. Open Figma desktop → any file
2. **Plugins → Development → Import plugin from manifest…**
3. Pick `packages/plugin/dist/manifest.json`
4. Run **Plugins → Development → Web to Figma**

### Capturing a page

Paste a URL into the plugin UI, pick a viewport, hit **Capture page**. First capture takes ~15s while Playwright cold-starts; subsequent captures are faster.

### Fast iteration without Figma

The renderer ships a CLI that writes capture JSON to disk for inspection:

```bash
npm --workspace @web-to-figma/renderer run capture -- https://flatpay.com desktop
# → captures/flatpay-com-desktop-{ts}.json
```

## Library token matching

Imports get tokenised against your Flatpay design system in two ways:

- **Text + paint styles** — every key listed in `packages/plugin/src/library-manifest.ts` is pre-imported into the user's file before token matching runs. The manifest is generated from the Web UI Kit and Colours/Themes library files.
- **Colour variables** — auto-discovered at runtime from any team libraries the user has *enabled* in their file's library panel. (Figma's plugin API can't enable libraries programmatically.)

### Regenerating the style manifest

Whenever the libraries change (new styles added, renamed, etc.), rerun:

```bash
FIGMA_TOKEN=figd_xxx npm run fetch-library-keys
```

Generate a Figma personal access token at https://www.figma.com/developers/api#access-tokens. The script hits `/v1/files/:key/styles` for both library files and writes a fresh `library-manifest.ts`. Commit the updated file.

### One-time per-user setup for variables

Each Flatpay teammate needs to **enable the Colours/Themes library** in their Figma file's Library panel once (the toggle next to the library name). Without this, colour variables can't be discovered by the plugin runtime.

## Auth (when hosted)

Set `W2F_TOKEN=<secret>` on the renderer. Plugin sends `Authorization: Bearer <token>` for every request. Without the env var, the renderer is open (fine for localhost).

## Status

| Milestone | State |
|---|---|
| M1 Renderer service | ✅ |
| M2 DOM extractor | ✅ |
| M3 Figma plugin | ✅ |
| M4 Real-page testing | In progress |
| M5 Deploy to Vercel + team auth | Not started |

## License

MIT.
