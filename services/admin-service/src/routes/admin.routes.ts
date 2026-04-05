import { Hono } from 'hono';
import { adminAuth } from '../middleware/adminAuth';

const LEDGER_SERVICE_URL      = process.env.LEDGER_SERVICE_URL      ?? 'http://ledger-service:3000';
const TRANSACTION_SERVICE_URL = process.env.TRANSACTION_SERVICE_URL ?? 'http://transaction-service:3000';
const PAYROLL_SERVICE_URL     = process.env.PAYROLL_SERVICE_URL     ?? 'http://payroll-service:3000';
const ACCOUNT_SERVICE_URL     = process.env.ACCOUNT_SERVICE_URL     ?? 'http://account-service:3000';
const FX_SERVICE_URL          = process.env.FX_SERVICE_URL          ?? 'http://fx-service:3000';

const admin = new Hono();

admin.use('/admin/*', adminAuth);

// GET /admin/ledger/invariant
admin.get('/admin/ledger/invariant', async (c) => {
  const res = await fetch(`${LEDGER_SERVICE_URL}/ledger/invariant-check`);
  const body = await res.json();
  return c.json(body, res.status as never);
});

// GET /admin/ledger/verify/:transactionId
admin.get('/admin/ledger/verify/:transactionId', async (c) => {
  const id = c.req.param('transactionId');
  const res = await fetch(`${LEDGER_SERVICE_URL}/ledger/verify/${id}`);
  const body = await res.json();
  return c.json(body, res.status as never);
});

// GET /admin/transactions/stuck
admin.get('/admin/transactions/stuck', async (c) => {
  const res = await fetch(`${TRANSACTION_SERVICE_URL}/transfers/stuck`);
  const body = await res.json();
  return c.json(body, res.status as never);
});

// POST /admin/transactions/:id/reverse
admin.post('/admin/transactions/:id/reverse', async (c) => {
  const id = c.req.param('id');
  const res = await fetch(`${TRANSACTION_SERVICE_URL}/transfers/${id}/reverse`, {
    method: 'POST',
  });
  const body = await res.json();
  return c.json(body, res.status as never);
});

// GET /admin/payroll/jobs
admin.get('/admin/payroll/jobs', async (c) => {
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
  const res = await fetch(`${PAYROLL_SERVICE_URL}/payroll/jobs${qs}`);
  const body = await res.json();
  return c.json(body, res.status as never);
});

// GET /admin/health — aggregate health check across all services
admin.get('/admin/health', async (c) => {
  const services: Record<string, string> = {
    'account-service':     `${ACCOUNT_SERVICE_URL}/health`,
    'transaction-service': `${TRANSACTION_SERVICE_URL}/health`,
    'ledger-service':      `${LEDGER_SERVICE_URL}/health`,
    'fx-service':          `${FX_SERVICE_URL}/health`,
    'payroll-service':     `${PAYROLL_SERVICE_URL}/health`,
  };

  const health: Record<string, { status: string }> = {};
  let overall = 'ok';

  await Promise.all(
    Object.entries(services).map(async ([name, url]) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        health[name] = { status: res.ok ? 'ok' : 'degraded' };
        if (!res.ok) overall = 'degraded';
      } catch {
        health[name] = { status: 'down' };
        overall = 'degraded';
      }
    }),
  );

  return c.json({ status: overall, services: health }, overall === 'ok' ? 200 : 207);
});

export default admin;
