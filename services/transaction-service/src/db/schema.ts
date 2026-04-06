import { pgTable, uuid, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';

export const transactions = pgTable('transactions', {
  id:             uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  payloadHash:    text('payload_hash').notNull(),
  status:         text('status').notNull().default('PENDING'),
  type:           text('type').notNull(), // 'TRANSFER' | 'PAYROLL_DISBURSEMENT' | 'FX_TRANSFER'
  senderId:       text('sender_id').notNull(),
  recipientId:    text('recipient_id').notNull(),
  amount:         numeric('amount', { precision: 20, scale: 8 }).notNull(),
  currency:       text('currency').notNull(),
  fxQuoteId:      text('fx_quote_id'),
  lockedFxRate:   numeric('locked_fx_rate', { precision: 20, scale: 8 }),
  fee:            numeric('fee', { precision: 20, scale: 8 }).notNull().default('2'),
  processingStep: text('processing_step'), // 'DEBIT_COMPLETE' | 'CREDIT_COMPLETE'
  failureReason:  text('failure_reason'),
  result:         text('result'), // JSON stringified final response
  keyExpiresAt:   timestamp('key_expires_at').notNull(),
  completedAt:    timestamp('completed_at'),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
  updatedAt:      timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('idx_txn_idempotency').on(t.idempotencyKey),
  index('idx_txn_status').on(t.status),
]);
