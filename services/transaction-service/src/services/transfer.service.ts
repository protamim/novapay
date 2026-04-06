import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { trace } from '@opentelemetry/api';
import { db } from '../db';
import { transactions } from '../db/schema';
import { transactionsTotal } from '../metrics';

const NOVAPAY_FEE_ACCT = 'novapay_fee_acct';
const TRANSFER_FEE     = new Decimal('2'); // $2 flat fee per transfer

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
  fee: string;
  currency: string;
}

export async function executeTransfer(
  txnRecord: TxnRecord,
  body: TransferBody,
): Promise<TransferResult> {
  const transactionId = txnRecord.id;

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: txnRecord.idempotencyKey, userId: body.senderId, transactionId });

  const fee = TRANSFER_FEE;
  const totalDebit = new Decimal(body.amount).plus(fee).toFixed(8);

  // Step 1: Debit sender (transfer amount + fee)
  const debitRes = await fetch(`${ACCOUNT_SERVICE_URL}/accounts/${body.senderId}/debit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, amount: totalDebit, currency: body.currency }),
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

  // Step 5: Write two balanced ledger entry pairs:
  //   Pair A — transfer:  DEBIT sender $amount      + CREDIT recipient $amount
  //   Pair B — fee:       DEBIT sender $fee          + CREDIT novapay_fee_acct $fee
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
          description: `Transfer debit: ${body.amount} ${body.currency}`,
        },
        {
          transactionId,
          accountId: body.recipientId,
          entryType: 'CREDIT',
          amount: body.amount,
          currency: body.currency,
          lockedFxRate,
          description: `Transfer credit: ${body.amount} ${body.currency}`,
        },
        {
          transactionId,
          accountId: body.senderId,
          entryType: 'DEBIT',
          amount: fee.toFixed(8),
          currency: body.currency,
          description: `Fee debit: ${fee.toFixed(8)} ${body.currency}`,
        },
        {
          transactionId,
          accountId: NOVAPAY_FEE_ACCT,
          entryType: 'CREDIT',
          amount: fee.toFixed(8),
          currency: body.currency,
          description: `Fee credit: ${fee.toFixed(8)} ${body.currency}`,
        },
      ],
    }),
  });

  // Step 6: Mark COMPLETED and store result JSON
  const result: TransferResult = {
    transactionId,
    status: 'COMPLETED',
    amount: body.amount,
    fee: fee.toFixed(8),
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
  // The forward debit charged amount + fee; refund the full amount to the sender.
  const totalRefund = new Decimal(amount).plus(TRANSFER_FEE).toFixed(8);

  await fetch(`${ACCOUNT_SERVICE_URL}/accounts/${accountId}/credit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionId, amount: totalRefund, currency, isReversal: true }),
  });

  // Write compensating ledger entries. The forward debit wrote two DEBIT entries
  // (transfer + fee) against the sender. Reverse both with matching CREDITs.
  // REVERSAL_SUSPENSE absorbs the offsetting DEBITs to keep the ledger balanced.
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
          description: `REVERSAL transfer credit: ${amount} ${currency}`,
        },
        {
          transactionId,
          accountId: 'REVERSAL_SUSPENSE',
          entryType: 'DEBIT',
          amount,
          currency,
          description: `REVERSAL suspense debit: ${amount} ${currency}`,
        },
        {
          transactionId,
          accountId,
          entryType: 'CREDIT',
          amount: TRANSFER_FEE.toFixed(8),
          currency,
          description: `REVERSAL fee credit: ${TRANSFER_FEE.toFixed(8)} ${currency}`,
        },
        {
          transactionId,
          accountId: 'REVERSAL_SUSPENSE',
          entryType: 'DEBIT',
          amount: TRANSFER_FEE.toFixed(8),
          currency,
          description: `REVERSAL fee suspense debit: ${TRANSFER_FEE.toFixed(8)} ${currency}`,
        },
      ],
    }),
  });

  await db.update(transactions)
    .set({ status: 'REVERSED', failureReason: 'Reversal after failed credit', updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));
}

export { reverseDebit };
