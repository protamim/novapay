import { Hono } from 'hono';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { transactions } from '../db/schema';
import { idempotency } from '../middleware/idempotency';
import { executeTransfer, reverseDebit } from '../services/transfer.service';

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

const transfers = new Hono();

// POST /transfers — domestic transfer
transfers.post('/', idempotency('TRANSFER'), async (c) => {
  const txnRecord = c.get('txnRecord' as never) as typeof transactions.$inferSelect;
  const body = c.get('parsedBody' as never) as {
    senderId: string;
    recipientId: string;
    amount: string;
    currency: string;
  };

  try {
    const result = await executeTransfer(txnRecord, body);
    const expired = c.get('expiredKeyReused' as never) as boolean | undefined;
    if (expired) {
      return c.json({ ...result, note: 'Idempotency key was expired and reused as a fresh request' }, 201);
    }
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /transfers/international — FX transfer
transfers.post('/international', idempotency('FX_TRANSFER'), async (c) => {
  const txnRecord = c.get('txnRecord' as never) as typeof transactions.$inferSelect;
  const body = c.get('parsedBody' as never) as {
    senderId: string;
    recipientId: string;
    amount: string;
    currency: string;
    fxQuoteId: string;
  };

  if (!body.fxQuoteId) {
    return c.json({ error: 'fxQuoteId is required for international transfers' }, 400);
  }

  try {
    const result = await executeTransfer(txnRecord, body);
    const expired = c.get('expiredKeyReused' as never) as boolean | undefined;
    if (expired) {
      return c.json({ ...result, note: 'Idempotency key was expired and reused as a fresh request' }, 201);
    }
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /transfers/stuck — PROCESSING transactions older than 2 minutes
transfers.get('/stuck', async (c) => {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stuck = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.status, 'PROCESSING'), lt(transactions.updatedAt, staleThreshold)));

  return c.json({
    count: stuck.length,
    transactions: stuck.map((txn) => ({
      transactionId: txn.id,
      status: txn.status,
      processingStep: txn.processingStep,
      senderId: txn.senderId,
      recipientId: txn.recipientId,
      amount: txn.amount,
      currency: txn.currency,
      updatedAt: txn.updatedAt,
      createdAt: txn.createdAt,
    })),
  });
});

// POST /transfers/:id/reverse — manually trigger reversal of a PROCESSING transaction
transfers.post('/:id/reverse', async (c) => {
  const id = c.req.param('id');
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, id));

  if (!txn) return c.json({ error: 'Transaction not found' }, 404);

  if (txn.status !== 'PROCESSING') {
    return c.json({ error: `Cannot reverse a transaction in status ${txn.status}` }, 409);
  }

  await reverseDebit(txn.id, txn.senderId, txn.amount, txn.currency);

  return c.json({ transactionId: txn.id, status: 'REVERSED' });
});

// GET /transfers/:transactionId — fetch status and result
transfers.get('/:transactionId', async (c) => {
  const transactionId = c.req.param('transactionId');
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, transactionId));

  if (!txn) return c.json({ error: 'Transaction not found' }, 404);

  return c.json({
    transactionId: txn.id,
    status: txn.status,
    type: txn.type,
    senderId: txn.senderId,
    recipientId: txn.recipientId,
    amount: txn.amount,
    currency: txn.currency,
    fxQuoteId: txn.fxQuoteId,
    lockedFxRate: txn.lockedFxRate,
    processingStep: txn.processingStep,
    failureReason: txn.failureReason,
    result: txn.result ? JSON.parse(txn.result) : null,
    completedAt: txn.completedAt,
    createdAt: txn.createdAt,
  });
});

export default transfers;
