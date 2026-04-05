import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { wallets } from '../db/schema';

// ── Errors ───────────────────────────────────────────────────────────────────

export class InsufficientFundsError extends Error {
  constructor() {
    super('Insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class ConcurrentModificationError extends Error {
  constructor() {
    super('Concurrent modification detected — please retry');
    this.name = 'ConcurrentModificationError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(userId: string) {
    super(`Wallet not found for user ${userId}`);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletAlreadyExistsError extends Error {
  constructor(userId: string) {
    super(`Wallet already exists for user ${userId}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

// ── AES-256-GCM helpers ───────────────────────────────────────────────────────

async function importKey(): Promise<CryptoKey> {
  const raw = Buffer.from(process.env.MASTER_ENCRYPTION_KEY!, 'hex');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(plaintext: object): Promise<string> {
  const key = await importKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(plaintext)),
  );
  return `${Buffer.from(iv).toString('base64')}.${Buffer.from(ct).toString('base64')}`;
}

export async function decryptJson(encrypted: string): Promise<object> {
  const key = await importKey();
  const [ivB64, ctB64] = encrypted.split('.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(ivB64, 'base64') },
    key,
    Buffer.from(ctB64, 'base64'),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function createWallet(
  userId: string,
  currency = 'USD',
  accountRef?: object,
) {
  const encryptedAccountRef = accountRef ? await encryptJson(accountRef) : null;
  try {
    const [wallet] = await db
      .insert(wallets)
      .values({ userId, currency, encryptedAccountRef })
      .returning();
    return wallet;
  } catch (err: any) {
    if (err?.code === '23505') throw new WalletAlreadyExistsError(userId);
    throw err;
  }
}

export async function getWallet(userId: string) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId));
  if (!wallet) throw new WalletNotFoundError(userId);

  let accountRef: object | null = null;
  if (wallet.encryptedAccountRef) {
    accountRef = await decryptJson(wallet.encryptedAccountRef);
  }

  return {
    id:         wallet.id,
    userId:     wallet.userId,
    currency:   wallet.currency,
    balance:    wallet.balance,
    accountRef,
    version:    wallet.version,
    createdAt:  wallet.createdAt,
    updatedAt:  wallet.updatedAt,
  };
}

export async function debitWallet(userId: string, amount: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .for('update');

    if (!wallet) throw new WalletNotFoundError(userId);

    const currentBalance = new Decimal(wallet.balance);
    const debitAmount    = new Decimal(amount);

    if (currentBalance.lessThan(debitAmount)) {
      throw new InsufficientFundsError();
    }

    const newBalance = currentBalance.minus(debitAmount).toFixed(8);
    const updated = await tx
      .update(wallets)
      .set({ balance: newBalance, version: wallet.version + 1, updatedAt: new Date() })
      .where(and(eq(wallets.userId, userId), eq(wallets.version, wallet.version)))
      .returning();

    if (updated.length === 0) throw new ConcurrentModificationError();

    return updated[0].balance;
  });
}

export async function creditWallet(userId: string, amount: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .for('update');

    if (!wallet) throw new WalletNotFoundError(userId);

    const newBalance = new Decimal(wallet.balance).plus(new Decimal(amount)).toFixed(8);
    const updated = await tx
      .update(wallets)
      .set({ balance: newBalance, version: wallet.version + 1, updatedAt: new Date() })
      .where(and(eq(wallets.userId, userId), eq(wallets.version, wallet.version)))
      .returning();

    if (updated.length === 0) throw new ConcurrentModificationError();

    return updated[0].balance;
  });
}
