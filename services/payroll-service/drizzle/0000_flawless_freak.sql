CREATE TABLE "disbursement_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"transaction_id" text,
	"idempotency_key" text NOT NULL,
	"processed_at" timestamp,
	CONSTRAINT "disbursement_records_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payroll_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employer_id" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"total_amount" numeric(20, 8) NOT NULL,
	"disbursements" text NOT NULL,
	"total_count" integer NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"checkpoint_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_disb_job" ON "disbursement_records" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_disb_idempotency" ON "disbursement_records" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_payroll_employer" ON "payroll_jobs" USING btree ("employer_id","status");