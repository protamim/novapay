# NovaPay Engineering Decisions

## Idempotency Scenarios

### Scenario A — Duplicate key, same payload

A client retries a completed transfer with the same `Idempotency-Key` and body.

**Mechanism:** `INSERT … ON CONFLICT DO NOTHING RETURNING` returns an empty array. The middleware fetches the existing record, finds `status = COMPLETED` and a stored `result` JSON, and returns it immediately with HTTP 200. The transfer handler never executes — no second debit is ever attempted. The client receives exactly the same response as the original successful transfer.

### Scenario B — Three identical requests within 100ms

Three requests arrive before any of them completes.

**Mechanism:** PostgreSQL serializes at the unique index on `idempotency_key`. Exactly one `INSERT` succeeds; the other two get `ON CONFLICT DO NOTHING` and receive an empty `RETURNING`. Both losing requests query the existing row and wait on whatever status they find (COMPLETED → return stored result, PROCESSING → 202, PENDING → retry via handler). **Database state: only one row is ever inserted.** The two losing requests perform zero additional writes.

### Scenario C — Crash recovery (Saga pattern)

The service crashes after debiting the sender but before crediting the recipient.

**Mechanism:** The `processingStep` column is set to `DEBIT_COMPLETE` immediately after the debit succeeds, before attempting the credit. A recovery worker polls every 30 seconds for transactions stuck in `PROCESSING` with `updatedAt` older than 2 minutes. On finding such a record with `processingStep = DEBIT_COMPLETE`, it attempts to complete the credit (up to 3 retries). If credit succeeds, it writes ledger entries and marks `COMPLETED`. If all credit retries fail, it calls the account service to reverse the debit and marks the transaction `REVERSED`. This is the compensating transaction pattern from the Saga architecture.

### Scenario D — Expired key reuse (30 hours later)

A client reuses an `Idempotency-Key` from yesterday for a new transfer.

**Mechanism:** Every idempotency key has a `keyExpiresAt` set to 24 hours from creation. On conflict, if `keyExpiresAt < now`, the old record is deleted and a fresh transaction is created. The client receives a normal success response with an `expired` flag set, indicating the old record was purged. **This is a client bug**, not a system error — clients should generate a new key for each distinct transfer. The expired key is cleaned up rather than rejected, to allow legitimate retry scenarios (e.g., a mobile app that stored a key and retried it the next day).

### Scenario E — Same key, different payload

A client sends the same `Idempotency-Key` but with a different amount.

**Mechanism:** The middleware computes `SHA-256(JSON.stringify(body))` and compares it against the stored `payloadHash`. A mismatch means the client is attempting to use the same key for a different operation. The system returns `409 IDEMPOTENCY_CONFLICT` with a message naming both the original amount and the new amount. **The second amount is never processed.** This prevents a class of bugs where a client accidentally submits the wrong amount and expects idempotency to protect them.

---

## Why Redis Queue with Concurrency=1 per Employer vs DB Locking

Payroll jobs for a single employer are serialized via a Redis list keyed by `employerId`.

**The alternative (row-level DB lock):** A `SELECT … FOR UPDATE` on the employer's account row would hold the lock for the entire duration of the payroll job — potentially several minutes for 14,000 employee credits. This blocks all balance reads for that account during the entire run, creating a noticeable degradation for any concurrent queries.

**The Redis approach:** An atomic `LPOP` on a per-employer list means only one job runs per employer at a time. The "lock" window per disbursement is microseconds — the time to pop from Redis, submit one HTTP call to transaction-service, and advance the checkpoint. No DB lock is ever held across multiple disbursements.

---

## Double-Entry Invariant

Every `POST /ledger/entries` validates `sum(DEBIT) === sum(CREDIT)` before writing anything.

All arithmetic uses `decimal.js` — never JavaScript `Number` or `float`. The validation happens in the service layer before the DB transaction opens, so no partial writes occur on imbalance. If the invariant is violated, the request returns `422` with the exact DEBIT and CREDIT totals. A Prometheus counter `ledger_invariant_violation_total` fires immediately on any violation; an alert rule triggers if it goes above zero.

---

## FX Quote Strategy

FX rates are locked at request time with a hard 60-second TTL.

- **Quote issuance:** Rate is fetched from the mock provider, stored in `fx_quotes` with `expiresAt = now + 60s`.
- **Expiry enforcement:** Checked at consume time (`expiresAt < now` → 422 `QUOTE_EXPIRED`). The TTL is not advisory — it is enforced.
- **Single-use:** An atomic `UPDATE … WHERE usedAt IS NULL RETURNING` ensures exactly one consumer can claim the quote. If `RETURNING` is empty, the quote was already claimed (422 `QUOTE_ALREADY_USED`).
- **Provider down:** `ProviderUnavailableError` → 503. No cached or stale rate is ever served. The code explicitly has no fallback path.
- **Audit:** The `lockedFxRate` is stored on the ledger entry at the time of credit, making the exact rate used for every international transfer permanently auditable.

---

## Payroll Checkpoint Pattern

Long-running payroll jobs persist their position so they can resume after a crash without double-paying.

- After each successful disbursement, `checkpointIndex` is advanced to `i + 1`.
- On crash recovery, `processPayrollJob` is re-called with the same `jobId`. It resumes the loop from `job.checkpointIndex`, skipping all previously completed indices.
- **Idempotency keys are deterministic:** `${jobId}-${employeeId}-${i}`. If a disbursement at index `i` was already submitted before the crash, transaction-service's idempotency layer returns the cached result — no double payment occurs even if the crash happened after submission but before the checkpoint was written.

---

## Audit Hash Chain

Every ledger entry is linked into a SHA-256 hash chain, making DB tampering detectable.

Each entry stores `previousHash` (the `entryHash` of the preceding entry, or `NOVAPAY_GENESIS_0000` for the first) and `entryHash = SHA-256(previousHash + transactionId + accountId + amount + currency + createdAt)`. To verify integrity, `GET /ledger/verify/:transactionId` recomputes each hash from the stored fields. If any field was modified in the database after the fact, the recomputed hash will differ from the stored `entryHash`. The response is `{ valid: false, tamperedAt: "<entryId>" }`. Tampered records are flagged but not auto-corrected — the alert is surfaced to an admin for investigation.

---

## Envelope Encryption (Two-Key Hierarchy)

Sensitive fields use AES-256-GCM with a per-record data encryption key (DEK).

- Each record gets a unique DEK generated at write time.
- The DEK is encrypted with a master key (stored in environment config; production would use AWS KMS or HashiCorp Vault).
- Only encrypted ciphertext lands in PostgreSQL; the DEK is stored as an encrypted blob alongside the ciphertext.
- **Key rotation:** Rotating the master key requires re-encrypting only the DEKs, not all ciphertext. The volume of work is proportional to the number of records, but the DEK re-encryption can be done lazily on next read.
- **Log safety:** `pino` is configured with `redact` paths covering all sensitive field names. Raw values never appear in log output.

---

## Tradeoffs Under Time Pressure

- In-memory mock FX provider instead of a real external API integration
- Admin service proxies reads to other services instead of maintaining read replicas
- No rate limiting between internal services (Nginx only rate-limits external traffic)
- Simplified auth: static API key per service instead of JWT with rotation and refresh tokens

## What Would Be Added Before Production

- **AWS KMS or HashiCorp Vault** for master key management — removing the secret from environment config
- **Distributed tracing sampling** — 100% sampling is fine for development; production should sample at ~5–10% to manage Jaeger storage
- **Read replicas** for balance queries and transaction history — isolating heavy reads from write path
- **Circuit breakers** between services — e.g., Hono middleware wrapping all outbound `fetch` calls with a circuit breaker to avoid cascading failures when account-service is degraded
- **Proper auth service** with JWT rotation, refresh tokens, and per-client scopes
- **Dead letter queue** for failed payroll disbursements — currently a failed disbursement is recorded in `disbursement_records` with `status = FAILED` but there is no automatic retry or alerting
- **Database connection pooling via PgBouncer** — each Bun service opens a new connection pool; under heavy load, this exhausts Postgres connection limits
- **Rate limiting at Nginx layer** per client IP and API key to prevent abuse
