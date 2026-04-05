import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { trace } from '@opentelemetry/api';
import { db } from '../db';
import { fxQuotes } from '../db/schema';
import { getRate, ProviderUnavailableError } from '../services/mockFxProvider';
import { fxQuoteExpired } from '../metrics';

const fx = new Hono();

// POST /fx/quote — request a new FX rate quote (60-second TTL)
fx.post('/quote', async (c) => {
  const body = await c.req.json<{ fromCurrency: string; toCurrency: string }>();
  const { fromCurrency, toCurrency } = body;

  if (!fromCurrency || !toCurrency) {
    return c.json({ error: 'fromCurrency and toCurrency are required' }, 400);
  }

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '' });

  let rate: string;
  try {
    rate = await getRate(fromCurrency, toCurrency);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      // NEVER fall back to a cached/stale rate — hard fail
      return c.json({ error: 'FX provider unavailable' }, 503);
    }
    return c.json({ error: (err as Error).message }, 400);
  }

  const expiresAt = new Date(Date.now() + 60_000);
  const [quote] = await db.insert(fxQuotes).values({ fromCurrency, toCurrency, rate, expiresAt }).returning();

  span?.setAttributes({ transactionId: quote.id });

  return c.json(
    {
      quoteId: quote.id,
      rate: quote.rate,
      expiresAt: quote.expiresAt,
      secondsRemaining: 60,
    },
    201,
  );
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /fx/quote/:id — fetch a quote with computed expiry / used state
fx.get('/quote/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_REGEX.test(id)) return c.json({ error: 'Invalid quote ID format' }, 400);
  const [quote] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, id));

  if (!quote) return c.json({ error: 'Quote not found' }, 404);

  const now = new Date();
  const isExpired = quote.expiresAt < now;
  const isUsed = quote.usedAt !== null;
  const secondsRemaining = Math.max(
    0,
    Math.floor((quote.expiresAt.getTime() - now.getTime()) / 1000),
  );

  return c.json({ ...quote, isExpired, isUsed, secondsRemaining });
});

// POST /fx/quote/:id/consume — internal-only; marks quote as used atomically
fx.post('/quote/:id/consume', async (c) => {
  const id = c.req.param('id');
  if (!UUID_REGEX.test(id)) return c.json({ error: 'Invalid quote ID format' }, 400);
  const [quote] = await db.select().from(fxQuotes).where(eq(fxQuotes.id, id));

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', transactionId: id });

  if (!quote) return c.json({ error: 'Quote not found' }, 404);
  if (quote.usedAt) return c.json({ error: 'QUOTE_ALREADY_USED' }, 422);
  if (quote.expiresAt < new Date()) {
    fxQuoteExpired.inc();
    return c.json({ error: 'QUOTE_EXPIRED' }, 422);
  }

  // Atomic update — only succeeds if usedAt is still null (race-condition protection)
  const result = await db
    .update(fxQuotes)
    .set({ usedAt: new Date() })
    .where(and(eq(fxQuotes.id, id), isNull(fxQuotes.usedAt)))
    .returning();

  if (result.length === 0) return c.json({ error: 'QUOTE_ALREADY_USED' }, 422);

  return c.json({ quoteId: id, rate: result[0].rate, usedAt: result[0].usedAt });
});

export default fx;
