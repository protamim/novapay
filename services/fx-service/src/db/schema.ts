import { pgTable, uuid, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';

export const fxQuotes = pgTable('fx_quotes', {
  id:           uuid('id').primaryKey().defaultRandom(),
  fromCurrency: text('from_currency').notNull(),
  toCurrency:   text('to_currency').notNull(),
  rate:         numeric('rate', { precision: 20, scale: 8 }).notNull(),
  expiresAt:    timestamp('expires_at').notNull(),
  usedAt:       timestamp('used_at'),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_fx_expires').on(t.expiresAt),
]);
