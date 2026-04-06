import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { db } from '../db';
import { transactions } from '../db/schema';
import { eq } from 'drizzle-orm';

type TransactionType = 'TRANSFER' | 'FX_TRANSFER';

const TransferBodySchema = z.object({
  senderId: z.string().min(1),
  recipientId: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
  fxQuoteId: z.string().optional(),
});

async function sha256(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export const idempotency = (type: TransactionType) =>
  createMiddleware(async (c, next) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) {
      return c.json({ error: 'Idempotency-Key header is required' }, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const parsed = TransferBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation error', details: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    c.set('parsedBody' as never, body);

    const payloadHash = await sha256(JSON.stringify(body));
    const keyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Attempt INSERT ON CONFLICT DO NOTHING
    const inserted = await db
      .insert(transactions)
      .values({
        idempotencyKey: key,
        payloadHash,
        status: 'PENDING',
        type,
        senderId: body.senderId,
        recipientId: body.recipientId,
        amount: body.amount,
        currency: body.currency,
        fxQuoteId: body.fxQuoteId ?? null,
        keyExpiresAt,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) {
      // New request — proceed to handler
      c.set('txnRecord' as never, inserted[0]);
      await next();
      return;
    }

    // Key already exists — fetch the record
    const [existing] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.idempotencyKey, key));

    if (!existing) {
      return c.json({ error: 'Internal error' }, 500);
    }

    const now = new Date();

    // Scenario D: key expired — delete and re-insert as fresh
    if (existing.keyExpiresAt < now) {
      await db.delete(transactions).where(eq(transactions.idempotencyKey, key));
      const [reinserted] = await db
        .insert(transactions)
        .values({
          idempotencyKey: key,
          payloadHash,
          status: 'PENDING',
          type,
          senderId: body.senderId,
          recipientId: body.recipientId,
          amount: body.amount,
          currency: body.currency,
          fxQuoteId: body.fxQuoteId ?? null,
          keyExpiresAt,
        })
        .returning();
      c.set('txnRecord' as never, reinserted);
      c.set('expiredKeyReused' as never, true);
      await next();
      return;
    }

    // Scenario E: same key, different payload
    if (existing.payloadHash !== payloadHash) {
      return c.json(
        {
          error: 'IDEMPOTENCY_CONFLICT',
          message: `Idempotency key already used with a different payload (original amount: ${existing.amount} ${existing.currency}, new amount: ${body.amount} ${body.currency})`,
        },
        409,
      );
    }

    // Scenario A/B: already completed — return stored result
    if (existing.status === 'COMPLETED' && existing.result) {
      return c.json(JSON.parse(existing.result), 200);
    }

    // In-flight — tell caller to poll
    if (existing.status === 'PROCESSING') {
      return c.json({ status: 'PROCESSING', message: 'Transfer in progress' }, 202);
    }

    // PENDING retry — let handler run again
    c.set('txnRecord' as never, existing);
    await next();
  });
