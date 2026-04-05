CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"type" text NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"currency" text NOT NULL,
	"fx_quote_id" text,
	"locked_fx_rate" numeric(20, 8),
	"processing_step" text,
	"failure_reason" text,
	"result" text,
	"key_expires_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "idx_txn_idempotency" ON "transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_txn_status" ON "transactions" USING btree ("status");