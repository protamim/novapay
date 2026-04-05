import { Hono } from 'hono';
import { trace } from '@opentelemetry/api';
import {
  computeBalance,
  invariantCheck,
  verifyChain,
  writeEntries,
} from '../services/ledger.service';

const ledger = new Hono();

ledger.post('/entries', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(body)) {
    return c.json({ error: 'Body must be an array of ledger entries' }, 400);
  }

  const span = trace.getActiveSpan();
  const firstEntry = (body as Array<{ transactionId?: string }>)[0];
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', transactionId: firstEntry?.transactionId ?? '' });

  try {
    await writeEntries(body as any);
    return c.json({ ok: true }, 201);
  } catch (err: any) {
    if (err.message?.startsWith('Ledger invariant')) {
      return c.json({ error: err.message }, 422);
    }
    if (err.message?.startsWith('Entry count')) {
      return c.json({ error: err.message }, 400);
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
