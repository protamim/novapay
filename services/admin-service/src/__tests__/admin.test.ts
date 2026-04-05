import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ─── Shared mock state ────────────────────────────────────────────────────────
const ft = {
  response: null as { body: any; status: number } | null,
};

function reset() {
  ft.response = null;
  delete process.env.ADMIN_API_KEY;
}

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module('../metrics', () => ({
  httpDuration: { observe: mock(() => {}) },
  register: { metrics: mock(() => Promise.resolve('')), contentType: 'text/plain' },
}));

mock.module('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => ({ setAttributes: () => {} }) },
}));

// ─── Dynamic import AFTER mocks ───────────────────────────────────────────────
const { default: adminRouter } = await import('../routes/admin.routes');
const { adminAuth } = await import('../middleware/adminAuth');

// ─── App setup ────────────────────────────────────────────────────────────────
function buildApp() {
  const app = new Hono();
  app.route('/', adminRouter);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('adminAuth middleware', () => {
  beforeEach(() => {
    reset();
    process.env.ADMIN_API_KEY = 'secret-key';
  });

  test('allows request with correct X-Admin-Key', async () => {
    const app = new Hono();
    app.use('/admin/*', adminAuth);
    app.get('/admin/test', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/test', {
      headers: { 'X-Admin-Key': 'secret-key' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects request with missing X-Admin-Key → 401', async () => {
    const app = new Hono();
    app.use('/admin/*', adminAuth);
    app.get('/admin/test', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/test');
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBe('UNAUTHORIZED');
  });

  test('rejects request with wrong X-Admin-Key → 401', async () => {
    const app = new Hono();
    app.use('/admin/*', adminAuth);
    app.get('/admin/test', (c) => c.json({ ok: true }));

    const res = await app.request('/admin/test', {
      headers: { 'X-Admin-Key': 'wrong-key' },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/ledger/invariant proxy', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    reset();
    process.env.ADMIN_API_KEY = 'secret-key';
    globalThis.fetch = origFetch;
  });

  test('proxies upstream response to caller', async () => {
    const upstream = { debitTotal: '500', creditTotal: '500', diff: '0', balanced: true };
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(upstream), { status: 200 }),
    ) as any;

    const app = buildApp();
    const res = await app.request('/admin/ledger/invariant', {
      headers: { 'X-Admin-Key': 'secret-key' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.balanced).toBe(true);
    expect(body.diff).toBe('0');
  });

  test('returns 401 when X-Admin-Key is missing', async () => {
    const app = buildApp();
    const res = await app.request('/admin/ledger/invariant');
    expect(res.status).toBe(401);
  });
});
