import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ─── Shared mock state ────────────────────────────────────────────────────────
let insertCount = 0;
const qst = {
  selectReturn: null as any,   // set per-test; null → quote not found
  updateReturn: null as any,   // set per-test; null → 0 rows updated
};

function reset() {
  qst.selectReturn = null;
  qst.updateReturn = null;
  insertCount = 0;
  delete process.env.FX_PROVIDER_DOWN;
}

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module('../db', () => ({
  db: {
    insert: () => ({
      values: (vals: any) => ({
        returning: () => {
          insertCount++;
          const quote = { id: `quote-test-${insertCount}`, ...vals, createdAt: new Date() };
          // Auto-populate selectReturn so subsequent GET/consume calls find the quote
          qst.selectReturn = [quote];
          return Promise.resolve([quote]);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(qst.selectReturn ?? []),
      }),
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => ({
          returning: () => Promise.resolve(qst.updateReturn ?? []),
        }),
      }),
    }),
  },
}));

mock.module('../db/schema', () => ({
  fxQuotes: { id: 'id', expiresAt: 'expires_at', usedAt: 'used_at' },
}));

mock.module('../metrics', () => ({
  fxQuoteExpired: { inc: mock(() => {}) },
  httpDuration: { observe: mock(() => {}) },
  register: { metrics: mock(() => Promise.resolve('')), contentType: 'text/plain' },
}));

mock.module('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => ({ setAttributes: () => {} }) },
}));

// NOTE: ../services/mockFxProvider is NOT mocked — we use the real implementation.
// FX_PROVIDER_DOWN env var controls its behaviour.

// ─── Dynamic import AFTER mocks ───────────────────────────────────────────────
const { default: fxRouter } = await import('../routes/fx');

const app = new Hono();
app.route('/fx', fxRouter);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FX Quote — successful issuance', () => {
  beforeEach(reset);

  test('POST /fx/quote returns 201 with rate and 60s TTL', async () => {
    const res = await app.request('/fx/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromCurrency: 'USD', toCurrency: 'BDT' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.quoteId).toBeDefined();
    expect(body.rate).toBe('110.5');
    expect(body.secondsRemaining).toBe(60);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(insertCount).toBe(1);
  });
});

describe('FX Quote — expiry enforcement', () => {
  beforeEach(reset);

  test('consume returns 422 QUOTE_EXPIRED when expiresAt is 61s in the past', async () => {
    // Pre-load a quote that expired 61 seconds ago
    const expiredQuote = {
      id: 'quote-expired',
      fromCurrency: 'USD',
      toCurrency: 'BDT',
      rate: '110.5',
      expiresAt: new Date(Date.now() - 61_000),
      usedAt: null,
      createdAt: new Date(Date.now() - 121_000),
    };
    qst.selectReturn = [expiredQuote];

    const res = await app.request('/fx/quote/quote-expired/consume', {
      method: 'POST',
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error).toBe('QUOTE_EXPIRED');
  });
});

describe('FX Quote — single-use enforcement', () => {
  beforeEach(reset);

  test('second consume of same quote returns 422 QUOTE_ALREADY_USED', async () => {
    const freshQuote = {
      id: 'quote-once',
      fromCurrency: 'USD',
      toCurrency: 'BDT',
      rate: '110.5',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };

    // ── First consume ──
    qst.selectReturn = [freshQuote];
    qst.updateReturn = [{ ...freshQuote, usedAt: new Date() }]; // atomic update succeeds

    const res1 = await app.request('/fx/quote/quote-once/consume', { method: 'POST' });
    expect(res1.status).toBe(200);
    const b1 = (await res1.json()) as any;
    expect(b1.quoteId).toBe('quote-once');

    // ── Second consume: select now shows usedAt is set ──
    qst.selectReturn = [{ ...freshQuote, usedAt: new Date() }];
    qst.updateReturn = []; // atomic UPDATE WHERE usedAt IS NULL → 0 rows (race protection)

    const res2 = await app.request('/fx/quote/quote-once/consume', { method: 'POST' });
    expect(res2.status).toBe(422);
    const b2 = (await res2.json()) as any;
    expect(b2.error).toBe('QUOTE_ALREADY_USED');
  });
});

describe('FX Quote — provider unavailable', () => {
  beforeEach(reset);

  test('FX_PROVIDER_DOWN=true → POST /fx/quote returns 503; no cached rate served', async () => {
    process.env.FX_PROVIDER_DOWN = 'true';

    const res = await app.request('/fx/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromCurrency: 'USD', toCurrency: 'BDT' }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe('FX provider unavailable');
    // No insert was attempted — no fallback to cached/stale rate
    expect(insertCount).toBe(0);
  });
});
