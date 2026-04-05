import { pgTable, uuid, text, numeric, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const wallets = pgTable('wallets', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  userId:              text('user_id').notNull().unique(),
  currency:            text('currency').notNull().default('USD'),
  balance:             numeric('balance', { precision: 20, scale: 8 }).notNull().default('0'),
  encryptedAccountRef: text('encrypted_account_ref'),
  version:             integer('version').notNull().default(0),
  createdAt:           timestamp('created_at').defaultNow().notNull(),
  updatedAt:           timestamp('updated_at').defaultNow().notNull(),
}, (t) => [
  index('idx_wallet_user').on(t.userId),
]);
