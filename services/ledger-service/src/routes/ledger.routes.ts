import { Hono } from 'hono';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import {
  computeBalance,
  invariantCheck,
  verifyChain,
  writeEntries,
} from '../services/ledger.service';

const LedgerEntrySchema = z.object({
  transactionId: z.string().min(1),
  accountId: z.string().min(1),
  entryType: z.enum(['DEBIT', 'CREDIT']),
  amount: z.string().min(1),
  currency: z.string().min(1),
  lockedFxRate: z.string().optional(),
  description: z.string().optional(),
});

const LedgerEntriesBodySchema = z.union([
  z.array(LedgerEntrySchema).min(1),
  z.object({ entries: z.array(LedgerEntrySchema).min(1) }),
]);

const ledger = new Hono();

ledger.post('/entries', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const parsed = LedgerEntriesBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.issues }, 400);
  }

  const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.entries;

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', transactionId: entries[0]?.transactionId ?? '' });

  try {
    await writeEntries(entries as any);
    return c.json({ ok: true }, 201);
  } catch (err: any) {
    if (err.message?.startsWith('Ledger invariant')) {
      return c.json({ error: err.message }, 422);
    }
    if (err.message?.startsWith('Entry count')) {
      return c.json({ error: err.message }, 400);
    }
    if (err.message?.startsWith('Insufficient funds')) {
      return c.json({ error: err.message }, 422);
    }
    throw err;
  }
});

ledger.get('/balance/:accountId', async (c) => {
  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', userId: c.req.param('accountId') });

  const snapshot = await computeBalance(c.req.param('accountId'));
  if (!snapshot) return c.json({ error: 'Account not found' }, 404);
  return c.json(snapshot);
});

ledger.get('/verify/:transactionId', async (c) => {
  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', transactionId: c.req.param('transactionId') });

  const result = await verifyChain(c.req.param('transactionId'));
  return c.json(result);
});

ledger.get('/invariant-check', async (c) => {
  const result = await invariantCheck();
  return c.json(result);
});

export default ledger;
