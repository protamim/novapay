import './tracing'; // Must be first import
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { requestId } from 'hono/request-id';
import { register, httpDuration } from './metrics';
import payrollRoutes from './routes/payroll.routes';
import { startPayrollWorker } from './queue/payroll.queue';
import { processPayrollJob } from './services/payroll.service';

const app = new Hono().basePath("/api");
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

app.get('/health', (c) => c.json({ status: 'ok', service: 'payroll-service' }));
app.get('/metrics', async (c) => c.text(await register.metrics(), 200, { 'Content-Type': register.contentType }));
app.route('/', payrollRoutes);

startPayrollWorker(processPayrollJob);

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
};
