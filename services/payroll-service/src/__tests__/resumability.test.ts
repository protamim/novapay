import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Shared mock state ────────────────────────────────────────────────────────
const st = {
  jobRecord: null as any,
  updateCalls: [] as any[],
  insertedDisbursements: [] as any[],
  fetchedIdempotencyKeys: [] as string[],
};

function reset() {
  st.jobRecord = null;
  st.updateCalls = [];
  st.insertedDisbursements = [];
  st.fetchedIdempotencyKeys = [];
}

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(st.jobRecord ? [st.jobRecord] : []),
      }),
    }),
    update: () => ({
      set: (vals: any) => ({
        where: () => {
          st.updateCalls.push({ ...vals });
          // Reflect status change on the job record if present
          if (st.jobRecord && vals.status !== undefined) {
            st.jobRecord = { ...st.jobRecord, ...vals };
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (vals: any) => ({
        onConflictDoNothing: () => {
          st.insertedDisbursements.push(vals);
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

mock.module('../db/schema', () => ({
  payrollJobs: {},
  disbursementRecords: {},
}));

mock.module('../metrics', () => ({
  activePayrollJobs: { inc: mock(() => {}), dec: mock(() => {}) },
}));

mock.module('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => ({ setAttributes: () => {} }) },
}));

// ─── Dynamic import AFTER mocks ───────────────────────────────────────────────
const { processPayrollJob } = await import('../services/payroll.service');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Payroll resumability — crash recovery from checkpointIndex=2', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    reset();
    globalThis.fetch = originalFetch;
  });

  test('resumes from index 2; skips indices 0 and 1; final processedCount=5, checkpointIndex=5', async () => {
    const disbursements = [
      { employeeId: 'emp-0', amount: '5000', currency: 'USD' },
      { employeeId: 'emp-1', amount: '5000', currency: 'USD' },
      { employeeId: 'emp-2', amount: '5000', currency: 'USD' },
      { employeeId: 'emp-3', amount: '5000', currency: 'USD' },
      { employeeId: 'emp-4', amount: '5000', currency: 'USD' },
    ];

    st.jobRecord = {
      id: 'job-resume',
      employerId: 'corp-1',
      status: 'QUEUED',
      totalAmount: '25000',
      disbursements: JSON.stringify(disbursements),
      totalCount: 5,
      processedCount: 2,    // indices 0 and 1 already done before crash
      failedCount: 0,
      checkpointIndex: 2,   // resume from here
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Mock transaction service: always succeed, capture idempotency keys
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const key = headers?.['Idempotency-Key'] ?? '';
      st.fetchedIdempotencyKeys.push(key);
      return new Response(
        JSON.stringify({ transactionId: `txn-${key}`, status: 'COMPLETED' }),
        { status: 200 },
      );
    }) as any;

    await processPayrollJob('job-resume');

    // ── Assert: started from index 2, not 0 ──────────────────────────────────
    const expectedKeys = ['job-resume-emp-2-2', 'job-resume-emp-3-3', 'job-resume-emp-4-4'];
    expect(st.fetchedIdempotencyKeys).toEqual(expectedKeys);

    // ── Assert: indices 0 and 1 NOT re-submitted ──────────────────────────────
    expect(st.fetchedIdempotencyKeys).not.toContain('job-resume-emp-0-0');
    expect(st.fetchedIdempotencyKeys).not.toContain('job-resume-emp-1-1');

    // ── Assert: final checkpoint and processed count ──────────────────────────
    // The final checkpoint update (before COMPLETED status) should be index 5
    const checkpointUpdates = st.updateCalls.filter(
      (u) => u.checkpointIndex !== undefined,
    );
    const lastCheckpoint = checkpointUpdates[checkpointUpdates.length - 1];
    expect(lastCheckpoint.checkpointIndex).toBe(5);
    expect(lastCheckpoint.processedCount).toBe(5);

    // ── Assert: job marked COMPLETED ─────────────────────────────────────────
    const completedUpdate = st.updateCalls.find((u) => u.status === 'COMPLETED');
    expect(completedUpdate).toBeDefined();
  });

  test('only 3 fetch calls made (indices 2, 3, 4) — not 5', async () => {
    const disbursements = Array.from({ length: 5 }, (_, i) => ({
      employeeId: `emp-${i}`,
      amount: '1000',
      currency: 'USD',
    }));

    st.jobRecord = {
      id: 'job-count',
      employerId: 'corp-1',
      status: 'QUEUED',
      totalAmount: '5000',
      disbursements: JSON.stringify(disbursements),
      totalCount: 5,
      processedCount: 2,
      failedCount: 0,
      checkpointIndex: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      st.fetchedIdempotencyKeys.push(headers?.['Idempotency-Key'] ?? '');
      return new Response(JSON.stringify({ transactionId: 'txn-x' }), { status: 200 });
    }) as any;

    await processPayrollJob('job-count');

    // Exactly 3 disbursements dispatched (indices 2, 3, 4)
    expect(st.fetchedIdempotencyKeys.length).toBe(3);
  });
});
