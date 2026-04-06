import Decimal from 'decimal.js';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { balanceSnapshots, ledgerEntries } from '../db/schema';
import { ledgerInvariantViolations } from '../metrics';

export interface LedgerEntryInput {
  transactionId: string;
  accountId: string;
  entryType: 'DEBIT' | 'CREDIT';
  amount: string;
  currency: string;
  lockedFxRate?: string;
  description?: string;
}

const GENESIS_HASH = 'NOVAPAY_GENESIS_0000';

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function computeEntryHash(
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

export async function writeEntries(entries: LedgerEntryInput[]): Promise<void> {
  if (entries.length === 0 || entries.length % 2 !== 0) {
    throw new Error(`Entry count must be a positive even number, got ${entries.length}`);
  }

  const totalDebit = entries
    .filter((e) => e.entryType === 'DEBIT')
    .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
  const totalCredit = entries
    .filter((e) => e.entryType === 'CREDIT')
    .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));

  if (!totalDebit.equals(totalCredit)) {
    ledgerInvariantViolations.inc();
    throw new Error(
      `Ledger invariant violated: DEBIT ${totalDebit.toFixed()} ≠ CREDIT ${totalCredit.toFixed()}`,
    );
  }

  await db.transaction(async (tx) => {
    const [lastEntry] = await tx
      .select({ entryHash: ledgerEntries.entryHash })
      .from(ledgerEntries)
      .orderBy(desc(ledgerEntries.createdAt))
      .limit(1);

    let previousHash = lastEntry?.entryHash ?? GENESIS_HASH;
    const now = new Date();

    // Pre-fetch current balances for accounts that will be debited so we can
    // enforce the non-negative balance invariant before writing any entries.
    const debitAccountIds = [
      ...new Set(entries.filter((e) => e.entryType === 'DEBIT').map((e) => e.accountId)),
    ];
    const snapshots = debitAccountIds.length > 0
      ? await tx
          .select({ accountId: balanceSnapshots.accountId, balance: balanceSnapshots.balance })
          .from(balanceSnapshots)
          .where(inArray(balanceSnapshots.accountId, debitAccountIds))
      : [];

    // Running balances track the net effect of this batch so far (per account).
    const runningBalances: Record<string, Decimal> = {};
    for (const snap of snapshots) {
      runningBalances[snap.accountId] = new Decimal(snap.balance);
    }

    for (const entry of entries) {
      // Enforce non-negative balance on DEBIT before writing.
      if (entry.entryType === 'DEBIT') {
        const current = runningBalances[entry.accountId] ?? new Decimal(0);
        const after   = current.minus(new Decimal(entry.amount));
        if (after.isNegative()) {
          throw new Error(
            `Insufficient funds: account ${entry.accountId} has ${current.toFixed(8)} but DEBIT requires ${entry.amount}`,
          );
        }
        runningBalances[entry.accountId] = after;
      }

      const entryHash = await computeEntryHash(
        previousHash,
        entry.transactionId,
        entry.accountId,
        entry.amount,
        entry.currency,
        now,
      );

      await tx.insert(ledgerEntries).values({
        transactionId: entry.transactionId,
        accountId:     entry.accountId,
        entryType:     entry.entryType,
        amount:        entry.amount,
        currency:      entry.currency,
        lockedFxRate:  entry.lockedFxRate ?? null,
        description:   entry.description ?? `${entry.entryType}: ${entry.amount} ${entry.currency}`,
        previousHash,
        entryHash,
        createdAt: now,
      });

      const delta =
        entry.entryType === 'CREDIT'
          ? new Decimal(entry.amount)
          : new Decimal(entry.amount).negated();

      await tx
        .insert(balanceSnapshots)
        .values({
          accountId: entry.accountId,
          balance:   delta.toFixed(8),
          currency:  entry.currency,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: balanceSnapshots.accountId,
          set: {
            balance:   sql`${balanceSnapshots.balance} + ${delta.toFixed(8)}::numeric`,
            updatedAt: now,
          },
        });

      previousHash = entryHash;
    }
  });
}

export async function computeBalance(accountId: string) {
  const [snapshot] = await db
    .select()
    .from(balanceSnapshots)
    .where(eq(balanceSnapshots.accountId, accountId));
  return snapshot ?? null;
}

export async function verifyChain(
  transactionId: string,
): Promise<{ valid: boolean; tamperedAt?: string }> {
  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.transactionId, transactionId))
    .orderBy(ledgerEntries.createdAt);

  for (const entry of entries) {
    const recomputed = await computeEntryHash(
      entry.previousHash,
      entry.transactionId,
      entry.accountId,
      entry.amount,
      entry.currency,
      entry.createdAt,
    );
    if (recomputed !== entry.entryHash) {
      return { valid: false, tamperedAt: entry.id };
    }
  }

  return { valid: true };
}

export async function invariantCheck() {
  const [debitRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(amount), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.entryType, 'DEBIT'));

  const [creditRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(amount), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.entryType, 'CREDIT'));

  const debitTotal  = new Decimal(debitRow?.total  ?? '0');
  const creditTotal = new Decimal(creditRow?.total ?? '0');
  const diff        = debitTotal.minus(creditTotal);

  return {
    debitTotal:  debitTotal.toFixed(),
    creditTotal: creditTotal.toFixed(),
    diff:        diff.toFixed(),
    balanced:    diff.isZero(),
  };
}
