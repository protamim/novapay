import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// ─── SHA-256 helper (mirrors the one in idempotency.ts) ───────────────────────
async function sha256(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Shared mutable mock state ────────────────────────────────────────────────
const st = {
  insertIdx: 0,
  insertSeq: [] as any[][],
  selectResult: [] as any[],
  deleteCount: 0,
  updateCalls: [] as any[],
};

function reset() {
  st.insertIdx = 0;
  st.insertSeq = [];
  st.selectResult = [];
  st.deleteCount = 0;
  st.updateCalls = [];
}

// ─── Module mocks (must precede dynamic imports of code under test) ───────────
mock.module('../db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(st.insertSeq[st.insertIdx++] ?? []),
        }),
        returning: () => Promise.resolve(st.insertSeq[st.insertIdx++] ?? []),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(st.selectResult),
      }),
    }),
    delete: () => ({
      where: () => {
        st.deleteCount++;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => {
          st.updateCalls.push(vals);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module('../db/schema', () => ({ transactions: {} }));

mock.module('../metrics', () => ({
  transactionsTotal: { inc: mock(() => {}) },
}));

mock.module('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => ({ setAttributes: () => {} }) },
}));

// ─── Dynamic imports AFTER mocks ──────────────────────────────────────────────
const { idempotency } = await import('../middleware/idempotency');
const { executeTransfer } = await import('../services/transfer.service');

// ─── Test helpers ─────────────────────────────────────────────────────────────
const BODY_OBJ = { senderId: 'user-1', recipientId: 'user-2', amount: '100', currency: 'USD' };
const BODY_STR = JSON.stringify(BODY_OBJ);
const STORED_RESULT = { transactionId: 'txn-stored', status: 'COMPLETED', amount: '100', currency: 'USD' };

async function makeRecord(overrides: Partial<any> = {}) {
  const hash = await sha256(BODY_STR);
  return {
    id: 'txn-1',
    idempotencyKey: 'key-abc',
    payloadHash: hash,
    status: 'COMPLETED',
    type: 'TRANSFER',
    senderId: 'user-1',
    recipientId: 'user-2',
    amount: '100',
    currency: 'USD',
    result: JSON.stringify(STORED_RESULT),
    processingStep: 'CREDIT_COMPLETE',
    keyExpiresAt: new Date(Date.now() + 86_400_000),
    fxQuoteId: null,
    lockedFxRate: null,
    failureReason: null,
    completedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildApp() {
  let handled = false;
  const app = new Hono();
  app.post('/transfer', idempotency('TRANSFER'), (c) => {
    handled = true;
    const expired = c.get('expiredKeyReused' as never);
    return c.json({ ok: true, expired: expired ?? false });
  });
  return { app, wasHandled: () => handled };
}

function req(app: Hono, key: string, body = BODY_STR) {
  return app.request('/transfer', {
    method: 'POST',
    headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
    body,
  });
}

// ─── Scenario A ───────────────────────────────────────────────────────────────
describe('Scenario A — duplicate key, COMPLETED record', () => {
  beforeEach(reset);

  test('returns stored result; handler never called (no second debit)', async () => {
    const record = await makeRecord();
    st.insertSeq = [[]];         // INSERT conflicts — nothing inserted
    st.selectResult = [record];  // SELECT returns the completed record

    const { app, wasHandled } = buildApp();
    const res = await req(app, 'key-abc');

    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof STORED_RESULT;
    expect(body.transactionId).toBe('txn-stored');
    expect(body.status).toBe('COMPLETED');
    // Handler was NOT called → no debit attempted
    expect(wasHandled()).toBe(false);
  });
});

// ─── Scenario B ───────────────────────────────────────────────────────────────
describe('Scenario B — three concurrent requests within 100ms', () => {
  beforeEach(reset);

  test('second and third return stored result; only one DB row written', async () => {
    const record = await makeRecord({ id: 'txn-new' });

    // insert sequence: first request wins, second+third get conflict
    st.insertSeq = [
      [{ ...record }], // request 1: insert succeeds
      [],              // request 2: conflict
      [],              // request 3: conflict
    ];
    // requests 2+3 read the completed record via SELECT
    st.selectResult = [record];

    const { app } = buildApp();

    const [res1, res2, res3] = await Promise.all([
      req(app, 'key-abc'),
      req(app, 'key-abc'),
      req(app, 'key-abc'),
    ]);

    // Request 1 hit the handler (ok:true from the test handler)
    expect(res1.status).toBe(200);

    // Requests 2 and 3 returned the stored completed result
    const b2 = (await res2.json()) as any;
    const b3 = (await res3.json()) as any;
    expect(b2.transactionId).toBe('txn-stored');
    expect(b3.transactionId).toBe('txn-stored');
    expect(b2.status).toBe('COMPLETED');
    expect(b3.status).toBe('COMPLETED');

    // Only 3 insert attempts total — no extra DB writes from requests 2 or 3
    expect(st.insertIdx).toBe(3);
  });
});

// ─── Scenario C ───────────────────────────────────────────────────────────────
describe('Scenario C — crash recovery: DEBIT_COMPLETE, credit fails', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    reset();
    globalThis.fetch = originalFetch;
  });

  test('recovery triggers debit reversal; status set to REVERSED', async () => {
    const crashRecord = await makeRecord({
      id: 'txn-crash',
      status: 'PROCESSING',
      processingStep: 'DEBIT_COMPLETE',
      result: null,
      completedAt: null,
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });

    // executeTransfer needs the initial insert to "succeed" (middleware was bypassed for recovery)
    st.insertSeq = [[crashRecord]];

    // Mock fetch: debit OK, credit fails, reversal credit OK
    let creditCallCount = 0;
    globalThis.fetch = mock(async (url: string) => {
      if ((url as string).includes('/debit')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      creditCallCount++;
      // Regular credit call fails; reversal credit (isReversal in body) also fails —
      // reverseDebit() still updates the DB regardless
      return new Response(JSON.stringify({ error: 'Service unavailable' }), { status: 503 });
    }) as any;

    try {
      await executeTransfer(crashRecord as any, {
        senderId: 'user-1',
        recipientId: 'user-2',
        amount: '100',
        currency: 'USD',
      });
    } catch {
      // executeTransfer is expected to throw after credit fails
    }

    // DB must have been updated to PROCESSING then REVERSED
    const reversalUpdate = st.updateCalls.find((u) => u.status === 'REVERSED');
    expect(reversalUpdate).toBeDefined();
    expect(reversalUpdate!.status).toBe('REVERSED');
    expect(reversalUpdate!.failureReason).toContain('Reversal');
    // Credit was attempted at least once
    expect(creditCallCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Scenario D ───────────────────────────────────────────────────────────────
describe('Scenario D — expired idempotency key (30 hours later)', () => {
  beforeEach(reset);

  test('old record deleted, new transaction created, response notes expiry', async () => {
    const expiredRecord = await makeRecord({
      keyExpiresAt: new Date(Date.now() - 30 * 3_600_000), // 30 h ago
    });
    const freshRecord = { ...expiredRecord, id: 'txn-fresh', keyExpiresAt: new Date(Date.now() + 86_400_000) };

    st.insertSeq = [
      [],             // initial INSERT: conflict (key exists but expired)
      [freshRecord],  // re-INSERT after delete: succeeds
    ];
    st.selectResult = [expiredRecord];

    const { app } = buildApp();
    const res = await req(app, 'key-abc');

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.expired).toBe(true);   // handler received expiredKeyReused=true
    expect(st.deleteCount).toBe(1);    // old record was deleted
    expect(st.insertIdx).toBe(2);      // two inserts: conflict + re-insert
  });
});

// ─── Scenario E ───────────────────────────────────────────────────────────────
describe('Scenario E — same key, different payload (amount mismatch)', () => {
  beforeEach(reset);

  test('returns 409 IDEMPOTENCY_CONFLICT; message names both amounts', async () => {
    // Existing record was created for amount=200
    const differentHash = await sha256(
      JSON.stringify({ senderId: 'user-1', recipientId: 'user-2', amount: '200', currency: 'USD' }),
    );
    const existingRecord = await makeRecord({ payloadHash: differentHash, amount: '200' });

    st.insertSeq = [[]];                    // INSERT conflicts
    st.selectResult = [existingRecord];     // SELECT returns record with different hash

    const { app } = buildApp();
    // New request with amount=100 — conflicts with stored amount=200
    const res = await req(app, 'key-abc', BODY_STR);

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe('IDEMPOTENCY_CONFLICT');
    expect(body.message).toContain('100'); // new amount
    expect(body.message).toContain('200'); // original amount
  });
});
