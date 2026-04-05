import { Registry, Counter, Histogram, Gauge } from 'prom-client';

export const register = new Registry();

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

export const transactionsTotal = new Counter({
  name: 'transactions_total',
  help: 'Total transactions by status',
  labelNames: ['status'],
  registers: [register],
});

export const ledgerInvariantViolations = new Gauge({
  name: 'ledger_invariant_violation_total',
  help: 'Count of ledger invariant violations — must always be 0',
  registers: [register],
});

export const fxQuoteExpired = new Counter({
  name: 'fx_quote_expired_total',
  help: 'FX quotes rejected due to expiry',
  registers: [register],
});

export const activePayrollJobs = new Gauge({
  name: 'active_payroll_jobs',
  help: 'Currently processing payroll jobs',
  registers: [register],
});
