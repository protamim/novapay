import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { disbursementRecords } from '../db/schema';
import { createPayrollJob, getJobProgress } from '../services/payroll.service';
import { enqueuePayrollJob } from '../queue/payroll.queue';

const DisbursementSchema = z.object({
  employeeId: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(1),
});

const CreatePayrollJobSchema = z.object({
  employerId: z.string().min(1),
  disbursements: z.array(DisbursementSchema).min(1),
});

const payroll = new Hono();

// POST /payroll/jobs — submit a bulk payroll job
payroll.post('/payroll/jobs', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const parsed = CreatePayrollJobSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Validation error', details: parsed.error.issues }, 400);
  }
  const body = parsed.data;

  const job = await createPayrollJob({
    employerId: body.employerId,
    disbursements: body.disbursements,
  });

  await enqueuePayrollJob(job.id, job.employerId);

  return c.json(
    {
      jobId: job.id,
      status: job.status,
      totalCount: job.totalCount,
      totalAmount: job.totalAmount,
    },
    202,
  );
});

// GET /payroll/jobs/:jobId — progress
payroll.get('/payroll/jobs/:jobId', async (c) => {
  const job = await getJobProgress(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);

  return c.json({
    jobId: job.id,
    employerId: job.employerId,
    status: job.status,
    totalCount: job.totalCount,
    processedCount: job.processedCount,
    failedCount: job.failedCount,
    checkpointIndex: job.checkpointIndex,
    totalAmount: job.totalAmount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});

// GET /payroll/jobs/:jobId/disbursements — paginated disbursement records
payroll.get('/payroll/jobs/:jobId/disbursements', async (c) => {
  const jobId = c.req.param('jobId');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const records = await db
    .select()
    .from(disbursementRecords)
    .where(eq(disbursementRecords.jobId, jobId))
    .limit(limit)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(disbursementRecords)
    .where(eq(disbursementRecords.jobId, jobId));

  return c.json({ data: records, total: count, limit, offset });
});

// GET /payroll/jobs — list all jobs (used by admin proxy)
payroll.get('/payroll/jobs', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const { payrollJobs } = await import('../db/schema');
  const jobs = await db
    .select({
      jobId: payrollJobs.id,
      employerId: payrollJobs.employerId,
      status: payrollJobs.status,
      totalCount: payrollJobs.totalCount,
      processedCount: payrollJobs.processedCount,
      failedCount: payrollJobs.failedCount,
      totalAmount: payrollJobs.totalAmount,
      createdAt: payrollJobs.createdAt,
    })
    .from(payrollJobs)
    .limit(limit)
    .offset(offset);

  return c.json({ data: jobs, limit, offset });
});

export default payroll;
