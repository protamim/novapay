CREATE TABLE "balance_snapshots" (
	"account_id" text PRIMARY KEY NOT NULL,
	"balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"currency" text NOT NULL,
	"locked_fx_rate" numeric(20, 8),
	"description" text NOT NULL,
	"previous_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ledger_transaction" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_account" ON "ledger_entries" USING btree ("account_id");