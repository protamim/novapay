import { eq } from 'drizzle-orm';
import { trace } from '@opentelemetry/api';
import { db } from '../db';
import { transactions } from '../db/schema';
import { transactionsTotal } from '../metrics';

const ACCOUNT_SERVICE_URL = process.env.ACCOUNT_SERVICE_URL ?? 'http://account-service:3000';
const FX_SERVICE_URL      = process.env.FX_SERVICE_URL      ?? 'http://fx-service:3000';
const LEDGER_SERVICE_URL  = process.env.LEDGER_SERVICE_URL  ?? 'http://ledger-service:3000';

type TxnRecord = typeof transactions.$inferSelect;

interface TransferBody {
  senderId: string;
  recipientId: string;
  amount: string;
  currency: string;
  fxQuoteId?: string;
}

interface TransferResult {
  transactionId: string;
  status: string;
  amount: string;
  currency: string;
}

export async function executeTransfer(
  txnRecord: TxnRecord,
  body: TransferBody,
): Promise<TransferResult> {
  const transactionId = txnRecord.id;

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: txnRecord.idempotencyKey, userId: body.senderId, transactionId });

  // Step 1: Debit sender
  const debitRes = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/${body.senderId}/debit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, amount: body.amount, currency: body.currency }),
  });
  if (!debitRes.ok) {
    const errBody = await debitRes.json().catch(() => ({})) as Record<string, unknown>;
    await db.update(transactions)
      .set({ status: 'FAILED', failureReason: String(errBody.error ?? 'Debit failed'), updatedAt: new Date() })
      .where(eq(transactions.id, transactionId));
    transactionsTotal.inc({ status: 'failed' });
    throw new Error(String(errBody.error ?? 'Debit failed'));
  }

  // Step 2: Mark PROCESSING + DEBIT_COMPLETE immediately
  await db.update(transactions)
    .set({ status: 'PROCESSING', processingStep: 'DEBIT_COMPLETE', updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));

  // Step 3: For FX transfers, consume the quote and lock the rate
  let lockedFxRate: string | null = null;
  if (body.fxQuoteId) {
    const consumeRes = await fetch(`${FX_SERVICE_URL}/fx/quote/${body.fxQuoteId}/consume`, {
      method: 'POST',
    });
    if (!consumeRes.ok) {
      const errBody = await consumeRes.json().catch(() => ({})) as Record<string, unknown>;
      await reverseDebit(transactionId, body.senderId, body.amount, body.currency);
      transactionsTotal.inc({ status: 'failed' });
      throw new Error(String(errBody.error ?? 'Quote consume failed'));
    }
    const quote = await consumeRes.json() as { rate: string };
    lockedFxRate = quote.rate;
    await db.update(transactions)
      .set({ lockedFxRate, updatedAt: new Date() })
      .where(eq(transactions.id, transactionId));
  }

  // Step 4: Credit recipient
  const creditRes = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/${body.recipientId}/credit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transactionId,
      amount: body.amount,
      currency: body.currency,
      lockedFxRate,
    }),
  });
  if (!creditRes.ok) {
    await reverseDebit(transactionId, body.senderId, body.amount, body.currency);
    transactionsTotal.inc({ status: 'failed' });
    throw new Error('Credit failed');
  }

  // Step 5: Write balanced ledger entries (DEBIT sender + CREDIT recipient)
  await fetch(`${LEDGER_SERVICE_URL}/ledger/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [
        {
          transactionId,
          accountId: body.senderId,
          entryType: 'DEBIT',
          amount: body.amount,
          currency: body.currency,
          lockedFxRate,
        },
        {
          transactionId,
          accountId: body.recipientId,
          entryType: 'CREDIT',
          amount: body.amount,
          currency: body.currency,
          lockedFxRate,
        },
      ],
    }),
  });

  // Step 6: Mark COMPLETED and store result JSON
  const result: TransferResult = {
    transactionId,
    status: 'COMPLETED',
    amount: body.amount,
    currency: body.currency,
  };

  await db.update(transactions)
    .set({
      status: 'COMPLETED',
      processingStep: 'CREDIT_COMPLETE',
      result: JSON.stringify(result),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, transactionId));

  transactionsTotal.inc({ status: 'completed' });
  return result;
}

async function reverseDebit(
  transactionId: string,
  accountId: string,
  amount: string,
  currency: string,
): Promise<void> {
  await fetch(`${ACCOUNT_SERVICE_URL}/accounts/${accountId}/credit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, amount, currency, isReversal: true }),
  });

  // Write a compensating balanced ledger entry so the ledger stays consistent.
  // The forward debit was already written; this credit reverses it.
  // REVERSAL_SUSPENSE is a system account that absorbs the offsetting debit.
  await fetch(`${LEDGER_SERVICE_URL}/ledger/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entries: [
        {
          transactionId,
          accountId,
          entryType: 'CREDIT',
          amount,
          currency,
          description: `REVERSAL credit: ${amount} ${currency}`,
        },
        {
          transactionId,
          accountId: 'REVERSAL_SUSPENSE',
          entryType: 'DEBIT',
          amount,
          currency,
          description: `REVERSAL suspense debit: ${amount} ${currency}`,
        },
      ],
    }),
  });

  await db.update(transactions)
    .set({ status: 'REVERSED', failureReason: 'Reversal after failed credit', updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));
}

export { reverseDebit };
