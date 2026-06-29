/**
 * HTTP entry point. Wraps capture() in an Express server.
 *
 * POST /capture
 *   body: { url, viewport?, waitForSelector?, settleMs? }
 *   200:  CaptureResponse
 *   400:  { error: string }
 */
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { capture } from './capture.js';
import { getBrowser, closeBrowser } from './browser.js';

const PORT = parseInt(process.env.PORT ?? '4321', 10);
const TOKEN = process.env.W2F_TOKEN ?? '';

const ViewportSchema = z.union([
  z.enum(['desktop', 'tablet', 'mobile']),
  z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive().optional(),
    isMobile: z.boolean().optional(),
  }),
]);

const RequestSchema = z.object({
  url: z.string().url(),
  viewport: ViewportSchema.optional().default('desktop'),
  waitForSelector: z.string().optional(),
  settleMs: z.number().int().nonnegative().optional(),
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

app.post('/capture', async (req, res) => {
  if (TOKEN) {
    const got = (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    if (got !== TOKEN) {
      return res.status(401).json({ error: 'unauthorised' });
    }
  }

  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.format() });
  }

  try {
    const browser = await getBrowser();
    const result = await capture(browser, parsed.data);
    return res.json(result);
  } catch (err) {
    console.error('[/capture] failed:', err);
    return res.status(500).json({ error: 'capture_failed', message: (err as Error).message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[renderer] listening on http://localhost:${PORT}`);
  console.log(`[renderer] auth: ${TOKEN ? 'token required' : 'open (set W2F_TOKEN to require auth)'}`);
});

async function shutdown() {
  console.log('\n[renderer] shutting down...');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
