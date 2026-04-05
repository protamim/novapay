import './tracing'; // Must be first import
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { register, httpDuration } from './metrics';
import accountRoutes from './routes/account.routes';

const app = new Hono();
app.use('*', requestId());
app.use('*', logger());
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  httpDuration.observe(
    { method: c.req.method, route: c.req.routePath, status: String(c.res.status) },
    (Date.now() - start) / 1000,
  );
});

app.get('/health', (c) => c.json({ status: 'ok', service: 'account-service' }));
app.get('/metrics', async (c) => c.text(await register.metrics(), 200, { 'Content-Type': register.contentType }));
app.route('/', accountRoutes);

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
};
