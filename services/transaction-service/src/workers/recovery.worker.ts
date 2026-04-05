import { eq, and, lt } from 'drizzle-orm';
import { db } from '../db';
import { transactions } from '../db/schema';
import { reverseDebit } from '../services/transfer.service';

const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL ?? 'http://account-service:3000';
const LEDGER_SERVICE_URL  = process.env.LEDGER_SERVICE_URL  ?? 'http://ledger-service:3000';
const STALE_THRESHOLD_MS  = 2 * 60 * 1000; // 2 minutes
const MAX_CREDIT_RETRIES  = 3;

async function attemptCredit(
  transactionId: string,
  recipientId: string,
  amount: string,
  currency: string,
  lockedFxRate: string | null,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_CREDIT_RETRIES; attempt++) {
    try {
      const res = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/${recipientId}/credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, amount, currency, lockedFxRate }),
      });
      if (res.ok) return true;
      console.error(`[recovery] Credit attempt ${attempt}/${MAX_CREDIT_RETRIES} failed for txn ${transactionId}`);
    } catch (err) {
      console.error(`[recovery] Credit attempt ${attempt}/${MAX_CREDIT_RETRIES} threw for txn ${transactionId}:`, err);
    }
  }
  return false;
}

async function recoverTransaction(txn: typeof transactions.$inferSelect): Promise<void> {
  console.log(`[recovery] Recovering txn ${txn.id} (step=${txn.processingStep})`);

  if (txn.processingStep === 'DEBIT_COMPLETE') {
    const credited = await attemptCredit(
      txn.id,
      txn.recipientId,
      txn.amount,
      txn.currency,
      txn.lockedFxRate,
    );

    if (credited) {
      // Write ledger entries
      await fetch(`${LEDGER_SERVICE_URL}/ledger/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              transactionId: txn.id,
              accountId: txn.senderId,
              entryType: 'DEBIT',
              amount: txn.amount,
              currency: txn.currency,
              lockedFxRate: txn.lockedFxRate,
            },
            {
              transactionId: txn.id,
              accountId: txn.recipientId,
              entryType: 'CREDIT',
              amount: txn.amount,
              currency: txn.currency,
              lockedFxRate: txn.lockedFxRate,
            },
          ],
        }),
      });

      const result = JSON.stringify({
        transactionId: txn.id,
        status: 'COMPLETED',
        amount: txn.amount,
        currency: txn.currency,
      });

      await db.update(transactions)
        .set({
          status: 'COMPLETED',
          processingStep: 'CREDIT_COMPLETE',
          result,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, txn.id));

      console.log(`[recovery] txn ${txn.id} → COMPLETED`);
    } else {
      // Credit failed after retries — reverse the debit
      await reverseDebit(txn.id, txn.senderId, txn.amount, txn.currency);
      console.log(`[recovery] txn ${txn.id} → REVERSED (credit exhausted after ${MAX_CREDIT_RETRIES} retries)`);
    }
  } else {
    console.warn(`[recovery] txn ${txn.id} has unexpected processingStep=${txn.processingStep}, skipping`);
  }
}

async function runRecovery(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  let stuck: (typeof transactions.$inferSelect)[];
  try {
    stuck = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.status, 'PROCESSING'), lt(transactions.updatedAt, staleThreshold)));
  } catch (err) {
    console.error('[recovery] Failed to query stuck transactions:', err);
    return;
  }

  if (stuck.length === 0) return;

  console.log(`[recovery] Found ${stuck.length} stuck transaction(s)`);
  for (const txn of stuck) {
    try {
      await recoverTransaction(txn);
    } catch (err) {
      console.error(`[recovery] Unhandled error recovering txn ${txn.id}:`, err);
    }
  }
}

export function startRecoveryWorker(): void {
  // Run immediately on startup, then every 30 seconds
  runRecovery();
  setInterval(runRecovery, 30_000);
  console.log('[recovery] Worker started (interval=30s)');
}
