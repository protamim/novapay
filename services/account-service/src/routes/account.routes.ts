import { Hono } from 'hono';
import { trace } from '@opentelemetry/api';
import {
  ConcurrentModificationError,
  InsufficientFundsError,
  WalletNotFoundError,
  createWallet,
  creditWallet,
  debitWallet,
  getWallet,
} from '../services/account.service';

const accounts = new Hono();

accounts.post('/accounts', async (c) => {
  let body: { userId: string; currency?: string; accountRef?: object };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.userId) return c.json({ error: 'userId is required' }, 400);

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', userId: body.userId });

  const wallet = await createWallet(body.userId, body.currency, body.accountRef);
  return c.json(wallet, 201);
});

accounts.get('/accounts/:userId', async (c) => {
  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', userId: c.req.param('userId') });

  try {
    const wallet = await getWallet(c.req.param('userId'));
    return c.json(wallet);
  } catch (err) {
    if (err instanceof WalletNotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

accounts.post('/accounts/:userId/debit', async (c) => {
  let body: { amount: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.amount) return c.json({ error: 'amount is required' }, 400);

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', userId: c.req.param('userId') });

  try {
    const newBalance = await debitWallet(c.req.param('userId'), body.amount);
    return c.json({ balance: newBalance });
  } catch (err) {
    if (err instanceof WalletNotFoundError)        return c.json({ error: err.message }, 404);
    if (err instanceof InsufficientFundsError)     return c.json({ error: err.message }, 402);
    if (err instanceof ConcurrentModificationError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

accounts.post('/accounts/:userId/credit', async (c) => {
  let body: { amount: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.amount) return c.json({ error: 'amount is required' }, 400);

  const span = trace.getActiveSpan();
  span?.setAttributes({ requestId: c.req.header('x-request-id') ?? '', userId: c.req.param('userId') });

  try {
    const newBalance = await creditWallet(c.req.param('userId'), body.amount);
    return c.json({ balance: newBalance });
  } catch (err) {
    if (err instanceof WalletNotFoundError)        return c.json({ error: err.message }, 404);
    if (err instanceof ConcurrentModificationError) return c.json({ error: err.message }, 409);
    throw err;
  }
});

export default accounts;
