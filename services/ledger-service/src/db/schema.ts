import { pgTable, uuid, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';

export const ledgerEntries = pgTable('ledger_entries', {
  id:            uuid('id').primaryKey().defaultRandom(),
  transactionId: text('transaction_id').notNull(),
  accountId:     text('account_id').notNull(),
  entryType:     text('entry_type').notNull(), // 'DEBIT' | 'CREDIT'
  amount:        numeric('amount', { precision: 20, scale: 8 }).notNull(),
  currency:      text('currency').notNull(),
  lockedFxRate:  numeric('locked_fx_rate', { precision: 20, scale: 8 }),
  description:   text('description').notNull(),
  previousHash:  text('previous_hash').notNull(),
  entryHash:     text('entry_hash').notNull(),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_ledger_transaction').on(t.transactionId),
  index('idx_ledger_account').on(t.accountId),
]);

export const balanceSnapshots = pgTable('balance_snapshots', {
  accountId: text('account_id').primaryKey(),
  balance:   numeric('balance', { precision: 20, scale: 8 }).notNull().default('0'),
  currency:  text('currency').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
