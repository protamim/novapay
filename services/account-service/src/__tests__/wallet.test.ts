import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ─── Shared mock state ────────────────────────────────────────────────────────
const st = {
  walletRow: null as any,
  insertReturn: null as any,
  updateReturn: null as any,
  txSelectReturn: null as any,
  txUpdateReturn: null as any,
};

function reset() {
  st.walletRow = null;
  st.insertReturn = null;
  st.updateReturn = null;
  st.txSelectReturn = null;
  st.txUpdateReturn = null;
}

// ─── Module mocks ─────────────────────────────────────────────────────────────
mock.module('../db', () => ({
  db: {
    insert: () => ({
      values: (vals: any) => ({
        returning: () => Promise.resolve(st.insertReturn ?? [{ id: 'wallet-1', ...vals, version: 0, createdAt: new Date(), updatedAt: new Date() }]),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(st.walletRow ? [st.walletRow] : []),
      }),
    }),
    transaction: async (fn: any) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => Promise.resolve(st.txSelectReturn ? [st.txSelectReturn] : []),
            }),
          }),
        }),
        update: () => ({
          set: (vals: any) => ({
            where: () => ({
              returning: () => Promise.resolve(st.txUpdateReturn ? [{ ...st.txSelectReturn, ...vals }] : []),
            }),
          }),
        }),
      };
      return fn(tx);
    },
  },
}));

mock.module('../db/schema', () => ({
  wallets: { userId: 'user_id', version: 'version' },
}));

mock.module('../metrics', () => ({
  httpDuration: { observe: mock(() => {}) },
  transactionsTotal: { inc: mock(() => {}) },
}));

mock.module('@opentelemetry/api', () => ({
  trace: { getActiveSpan: () => ({ setAttributes: () => {} }) },
}));

// ─── Dynamic imports AFTER mocks ──────────────────────────────────────────────
const {
  createWallet,
  getWallet,
  debitWallet,
  creditWallet,
  WalletNotFoundError,
  InsufficientFundsError,
} = await import('../services/account.service');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createWallet', () => {
  beforeEach(reset);

  test('returns new wallet with zero balance', async () => {
    const wallet = await createWallet('user-1', 'USD');
    expect(wallet.userId).toBe('user-1');
    expect(wallet.currency).toBe('USD');
  });
});

describe('getWallet', () => {
  beforeEach(reset);

  test('returns wallet when found', async () => {
    st.walletRow = {
      id: 'wallet-1',
      userId: 'user-1',
      currency: 'USD',
      balance: '100.00000000',
      encryptedAccountRef: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await getWallet('user-1');
    expect(result.userId).toBe('user-1');
    expect(result.balance).toBe('100.00000000');
  });

  test('throws WalletNotFoundError when wallet missing', async () => {
    st.walletRow = null;
    await expect(getWallet('nonexistent')).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('debitWallet', () => {
  beforeEach(reset);

  test('subtracts amount and returns new balance using decimal arithmetic', async () => {
    st.txSelectReturn = { id: 'w1', userId: 'user-1', balance: '200.00000000', version: 0 };
    st.txUpdateReturn = true;

    const newBalance = await debitWallet('user-1', '50');
    // decimal.js: 200 - 50 = 150.00000000
    expect(newBalance).toBe('150.00000000');
  });

  test('throws InsufficientFundsError when balance too low', async () => {
    st.txSelectReturn = { id: 'w1', userId: 'user-1', balance: '30.00000000', version: 0 };

    await expect(debitWallet('user-1', '100')).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  test('throws WalletNotFoundError when wallet missing', async () => {
    st.txSelectReturn = null;
    await expect(debitWallet('nonexistent', '10')).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('creditWallet', () => {
  beforeEach(reset);

  test('adds amount and returns new balance using decimal arithmetic', async () => {
    st.txSelectReturn = { id: 'w1', userId: 'user-1', balance: '100.00000000', version: 2 };
    st.txUpdateReturn = true;

    const newBalance = await creditWallet('user-1', '75.5');
    // decimal.js: 100 + 75.5 = 175.50000000
    expect(newBalance).toBe('175.50000000');
  });

  test('throws WalletNotFoundError when wallet missing', async () => {
    st.txSelectReturn = null;
    await expect(creditWallet('nonexistent', '10')).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
