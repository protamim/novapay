import { pgTable, uuid, text, numeric, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const payrollJobs = pgTable('payroll_jobs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  employerId:      text('employer_id').notNull(),
  status:          text('status').notNull().default('QUEUED'),
  totalAmount:     numeric('total_amount', { precision: 20, scale: 8 }).notNull(),
  disbursements:   text('disbursements').notNull(), // JSON string: [{employeeId, amount, currency}]
  totalCount:      integer('total_count').notNull(),
  processedCount:  integer('processed_count').notNull().default(0),
  failedCount:     integer('failed_count').notNull().default(0),
  checkpointIndex: integer('checkpoint_index').notNull().default(0),
  createdAt:       timestamp('created_at').defaultNow().notNull(),
  updatedAt:       timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('idx_payroll_employer').on(t.employerId, t.status),
]);

export const disbursementRecords = pgTable('disbursement_records', {
  id:             uuid('id').primaryKey().defaultRandom(),
  jobId:          text('job_id').notNull(),
  employeeId:     text('employee_id').notNull(),
  amount:         numeric('amount', { precision: 20, scale: 8 }).notNull(),
  currency:       text('currency').notNull(),
  status:         text('status').notNull().default('PENDING'),
  transactionId:  text('transaction_id'),
  idempotencyKey: text('idempotency_key').notNull().unique(), // "${jobId}-${employeeId}-${index}"
  processedAt:    timestamp('processed_at'),
}, (t) => [
  index('idx_disb_job').on(t.jobId),
  index('idx_disb_idempotency').on(t.idempotencyKey),
]);
