import { eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { db } from '../db';
import { payrollJobs, disbursementRecords } from '../db/schema';
import { activePayrollJobs } from '../metrics';

const TRANSACTION_SERVICE_URL =
  process.env.TRANSACTION_SERVICE_URL ?? 'http://transaction-service:3000';

interface Disbursement {
  employeeId: string;
  amount: string;
  currency: string;
}

interface CreateJobParams {
  employerId: string;
  disbursements: Disbursement[];
}

export async function createPayrollJob(params: CreateJobParams) {
  const { employerId, disbursements } = params;

  const totalAmount = disbursements
    .reduce((acc, d) => acc.plus(new Decimal(d.amount)), new Decimal(0))
    .toFixed(8);

  const [job] = await db
    .insert(payrollJobs)
    .values({
      employerId,
      totalAmount,
      disbursements: JSON.stringify(disbursements),
      totalCount: disbursements.length,
    })
    .returning();

  return job;
}

export async function processPayrollJob(jobId: string): Promise<void> {
  const [job] = await db
    .select()
    .from(payrollJobs)
    .where(eq(payrollJobs.id, jobId));

  if (!job) {
    console.error(`[payroll] job ${jobId} not found`);
    return;
  }

  // Mark as PROCESSING
  await db
    .update(payrollJobs)
    .set({ status: 'PROCESSING', updatedAt: new Date() })
    .where(eq(payrollJobs.id, jobId));

  activePayrollJobs.inc();

  const disbursements: Disbursement[] = JSON.parse(job.disbursements);
  let processedCount = job.processedCount;
  let failedCount = job.failedCount;

  // Resume from checkpoint — not from 0
  for (let i = job.checkpointIndex; i < disbursements.length; i++) {
    const { employeeId, amount, currency } = disbursements[i];
    const idempotencyKey = `${jobId}-${employeeId}-${i}`;

    try {
      const res = await fetch(`${TRANSACTION_SERVICE_URL}/transfers`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          senderId: job.employerId,
          recipientId: employeeId,
          amount,
          currency,
          type: 'PAYROLL_DISBURSEMENT',
        }),
      });

      const body = await res.json() as { transactionId?: string };
      const transactionId = body.transactionId ?? null;

      if (res.ok) {
        processedCount++;
        await db
          .insert(disbursementRecords)
          .values({
            jobId,
            employeeId,
            amount,
            currency,
            status: 'COMPLETED',
            transactionId,
            idempotencyKey,
            processedAt: new Date(),
          })
          .onConflictDoNothing();

        // Advance checkpoint after each successful disbursement
        await db
          .update(payrollJobs)
          .set({ checkpointIndex: i + 1, processedCount, updatedAt: new Date() })
          .where(eq(payrollJobs.id, jobId));
      } else {
        failedCount++;
        await db
          .insert(disbursementRecords)
          .values({
            jobId,
            employeeId,
            amount,
            currency,
            status: 'FAILED',
            idempotencyKey,
          })
          .onConflictDoNothing();

        await db
          .update(payrollJobs)
          .set({ failedCount, updatedAt: new Date() })
          .where(eq(payrollJobs.id, jobId));
      }
    } catch (err) {
      failedCount++;
      console.error(`[payroll] disbursement ${idempotencyKey} threw:`, err);

      await db
        .insert(disbursementRecords)
        .values({
          jobId,
          employeeId,
          amount,
          currency,
          status: 'FAILED',
          idempotencyKey,
        })
        .onConflictDoNothing();

      await db
        .update(payrollJobs)
        .set({ failedCount, updatedAt: new Date() })
        .where(eq(payrollJobs.id, jobId));
    }
  }

  await db
    .update(payrollJobs)
    .set({ status: 'COMPLETED', updatedAt: new Date() })
    .where(eq(payrollJobs.id, jobId));

  activePayrollJobs.dec();
}

export async function getJobProgress(jobId: string) {
  const [job] = await db
    .select()
    .from(payrollJobs)
    .where(eq(payrollJobs.id, jobId));
  return job ?? null;
}
