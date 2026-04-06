import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── SHA-256 helper (mirrors ledger.service.ts) ───────────────────────────────
async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeEntryHash(
  previousHash: string,
  transactionId: string,
  accountId: string,
  amount: string,
  currency: string,
  createdAt: Date,
): Promise<string> {
  const raw = previousHash + transactionId + accountId + amount + currency + createdAt.toISOString();
  return sha256Hex(raw);
}

// ─── Shared mutable mock state ────────────────────────────────────────────────
const st = {
  lastEntryForChain: [] as any[], // what the chain-head SELECT returns
  capturedInserts: [] as any[],
  selectResult: [] as any[],
};

function reset() {
  st.lastEntryForChain = [];
  st.capturedInserts = [];
  st.selectResult = [];
}

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module('../db', () => ({
  db: {
    transaction: async (fn: any) => {
      const tx = {
        select: () => ({
          from: () => ({
            // chain-head query: .from(ledgerEntries).orderBy(...).limit(1)
            orderBy: () => ({
              limit: () => Promise.resolve(st.lastEntryForChain),
            }),
            where: () => Promise.resolve([]),
          }),
        }),
        insert: (_table: any) => ({
          values: (vals: any) => {
            // Capture ledger entries (identified by entryType field)
            if (vals.entryType !== undefined) {
              const id = `entry-${st.capturedInserts.length + 1}`;
              const row = { id, ...vals };
              st.capturedInserts.push(row);
            }
            return {
              returning: () => {
                const id = `entry-${st.capturedInserts.length}`;
                return Promise.resolve([{ id, ...vals }]);
              },
              onConflictDoUpdate: () => Promise.resolve(),
            };
          },
        }),
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        }),
      };
      return fn(tx);
    },
    select: () => ({
      from: () => ({
        where: (_cond: any) => ({
          orderBy: () => Promise.resolve(st.selectResult),
        }),
      }),
    }),
  },
}));

mock.module('../db/schema', () => ({
  ledgerEntries: { transactionId: 'transaction_id', createdAt: 'created_at' },
  balanceSnapshots: { accountId: 'account_id', balance: 'balance' },
}));

mock.module('../metrics', () => ({
  ledgerInvariantViolations: { inc: mock(() => {}) },
}));

mock.module('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => ({ setAttributes: () => {} }) },
}));

// ─── Dynamic imports AFTER mocks ──────────────────────────────────────────────
const { writeEntries, verifyChain } = await import('../services/ledger.service');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Ledger invariant — balanced pair', () => {
  beforeEach(reset);

  test('DEBIT $100 + CREDIT $100 → accepted, two entries written', async () => {
    const entries = [
      { transactionId: 'txn-bal', accountId: 'alice', entryType: 'DEBIT' as const, amount: '100', currency: 'USD', description: 'Debit alice' },
      { transactionId: 'txn-bal', accountId: 'bob',   entryType: 'CREDIT' as const, amount: '100', currency: 'USD', description: 'Credit bob' },
    ];

    await expect(writeEntries(entries)).resolves.toBeUndefined();
    expect(st.capturedInserts.filter((r) => r.entryType !== undefined).length).toBe(2);
  });
});

describe('Ledger invariant — unbalanced pair', () => {
  beforeEach(reset);

  test('DEBIT $100 + CREDIT $99 → throws 422-mapped error LEDGER_INVARIANT_VIOLATED', async () => {
    const entries = [
      { transactionId: 'txn-unbal', accountId: 'alice', entryType: 'DEBIT' as const, amount: '100', currency: 'USD', description: 'Debit alice' },
      { transactionId: 'txn-unbal', accountId: 'bob',   entryType: 'CREDIT' as const, amount: '99',  currency: 'USD', description: 'Credit bob' },
    ];

    await expect(writeEntries(entries)).rejects.toThrow(/Ledger invariant violated/);
  });
});

describe('Audit hash chain', () => {
  beforeEach(reset);

  test("second entry's previousHash equals first entry's entryHash", async () => {
    const entries = [
      { transactionId: 'txn-chain', accountId: 'alice', entryType: 'DEBIT' as const, amount: '50', currency: 'USD', description: 'D' },
      { transactionId: 'txn-chain', accountId: 'bob',   entryType: 'CREDIT' as const, amount: '50', currency: 'USD', description: 'C' },
    ];

    await writeEntries(entries);

    // Two ledger entries should have been inserted
    const ledgerInserts = st.capturedInserts.filter((r) => r.entryType !== undefined);
    expect(ledgerInserts.length).toBe(2);

    const first  = ledgerInserts[0];
    const second = ledgerInserts[1];

    // Core invariant: second.previousHash === first.entryHash
    expect(second.previousHash).toBe(first.entryHash);

    // Also verify the first entry was chained from GENESIS (no prior entries)
    expect(first.previousHash).toBe('NOVAPAY_GENESIS_0000');
  });

  test('hash values are valid 64-char hex strings', async () => {
    const entries = [
      { transactionId: 'txn-hex', accountId: 'alice', entryType: 'DEBIT' as const, amount: '75', currency: 'EUR', description: 'D' },
      { transactionId: 'txn-hex', accountId: 'bob',   entryType: 'CREDIT' as const, amount: '75', currency: 'EUR', description: 'C' },
    ];

    await writeEntries(entries);

    for (const row of st.capturedInserts.filter((r) => r.entryType !== undefined)) {
      expect(row.entryHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('verifyChain — tamper detection', () => {
  beforeEach(reset);

  test('detects corrupted amount: returns { valid: false, tamperedAt: entryId }', async () => {
    const createdAt = new Date('2024-06-01T00:00:00.000Z');
    const GENESIS = 'NOVAPAY_GENESIS_0000';

    // Compute the valid hash for the entry as it should be stored
    const validHash = await computeEntryHash(GENESIS, 'txn-tamper', 'alice', '100', 'USD', createdAt);

    // Simulate DB returning the entry with a CORRUPTED amount (was '100', now '999')
    const tamperedEntry = {
      id: 'entry-tampered',
      transactionId: 'txn-tamper',
      accountId: 'alice',
      entryType: 'DEBIT',
      amount: '999',          // ← tampered; original was '100'
      currency: 'USD',
      previousHash: GENESIS,
      entryHash: validHash,   // hash was computed for amount='100', stored unchanged
      createdAt,
    };

    st.selectResult = [tamperedEntry];

    const result = await verifyChain('txn-tamper');

    expect(result.valid).toBe(false);
    expect(result.tamperedAt).toBe('entry-tampered');
  });

  test('valid unmodified chain returns { valid: true }', async () => {
    const createdAt = new Date('2024-06-01T00:00:00.000Z');
    const GENESIS = 'NOVAPAY_GENESIS_0000';

    const validHash = await computeEntryHash(GENESIS, 'txn-ok', 'alice', '100', 'USD', createdAt);

    const goodEntry = {
      id: 'entry-good',
      transactionId: 'txn-ok',
      accountId: 'alice',
      entryType: 'DEBIT',
      amount: '100',
      currency: 'USD',
      previousHash: GENESIS,
      entryHash: validHash,
      createdAt,
    };

    st.selectResult = [goodEntry];

    const result = await verifyChain('txn-ok');
    expect(result.valid).toBe(true);
    expect(result.tamperedAt).toBeUndefined();
  });
});
