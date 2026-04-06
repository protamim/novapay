# NovaPay

Microservice payment backend built to address four failure modes from an incident post-mortem: idempotent disbursement, atomic double-entry ledger, locked FX quotes, and crash-safe payroll.

---

## Table of Contents

1. [Setup and Running](#setup-and-running)
2. [Service URLs](#service-urls)
3. [API Endpoints](#api-endpoints)
4. [Idempotency — Five Scenarios](#idempotency--five-scenarios)
5. [Double-Entry Ledger Invariant](#double-entry-ledger-invariant)
6. [FX Quote Strategy](#fx-quote-strategy)
7. [Payroll Resumability](#payroll-resumability)
8. [Audit Hash Chain](#audit-hash-chain)
9. [Observability](#observability)
10. [Tradeoffs Under Time Pressure](#tradeoffs-under-time-pressure)
11. [What Would Be Added Before Production](#what-would-be-added-before-production)
12. [Repository Structure](#repository-structure)

---

## Setup and Running

### Prerequisites

- Docker >= 24 and Docker Compose V2
- Bun 1.x — only needed to run tests locally; production runs entirely inside Docker

### Start everything

```bash
git clone <repo>
cd novapay/infra
docker compose up --build
```

This starts all six services, six PostgreSQL databases, Redis, Nginx, Prometheus, Grafana, and Jaeger. Database migrations run automatically on each service's startup before the HTTP server begins listening. No manual migration step is required.

### Run tests

```bash
# Single service
cd services/transaction-service && bun test

# All services
for s in services/*/; do (cd "$s" && bun test); done
```

Tests use `bun:test` with `mock.module`. No live database or network is required. Every test file runs in complete isolation.

### Simulate an FX provider outage

```bash
# In docker-compose.yml, set this env var on the fx-service:
FX_PROVIDER_DOWN=true
```

All `POST /api/fx/quote` requests will return `503`. No stale rate is ever served.

---

## Service URLs

| Service         | URL                    |
|-----------------|------------------------|
| API Gateway     | http://localhost       |
| Grafana         | http://localhost:3000  |
| Prometheus      | http://localhost:9090  |
| Jaeger          | http://localhost:16686 |

All external API traffic routes through Nginx at `http://localhost`. Services communicate directly over Docker Compose networking for internal calls — no gateway hop.

---

## API Endpoints

### Account Service

**Create wallet**

```
POST /api/accounts
Content-Type: application/json

{ "userId": "user-123", "currency": "USD" }
```

Response `201`:
```json
{
  "id": "a1b2c3d4-...",
  "userId": "user-123",
  "currency": "USD",
  "balance": "0.00000000",
  "accountRef": null,
  "version": 0,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Duplicate `userId` → `409 Wallet already exists for user user-123`.

---

**Get wallet**

```
GET /api/accounts/{userId}
```

Response `200`: same shape as create. Returns current balance and optimistic-lock version.

---

**Credit wallet** — internal endpoint, called by transaction-service

```
POST /api/accounts/user-123/credit
Content-Type: application/json

{ "amount": "1000" }
```

Response `200`:
```json
{ "balance": "1000.00000000" }
```

---

**Debit wallet** — internal endpoint, called by transaction-service

```
POST /api/accounts/user-123/debit
Content-Type: application/json

{ "amount": "100" }
```

Response `200` (wallet had 1000):
```json
{ "balance": "900.00000000" }
```

Response `402` (insufficient balance): `{ "error": "Insufficient funds" }`

Response `409`: optimistic lock conflict — caller retries with fresh version.

---

### FX Service

**Request a rate quote**

```
POST /api/fx/quote
Content-Type: application/json

{ "fromCurrency": "USD", "toCurrency": "BDT" }
```

Response `201`:
```json
{
  "quoteId": "f7e6d5c4-...",
  "rate": "110.50",
  "expiresAt": "2026-01-01T00:01:00.000Z",
  "secondsRemaining": 60
}
```

Response `503` (provider down): `{ "error": "FX provider unavailable" }`

---

**Fetch quote status**

```
GET /api/fx/quote/{quoteId}
```

Response `200`:
```json
{
  "id": "f7e6d5c4-...",
  "fromCurrency": "USD",
  "toCurrency": "BDT",
  "rate": "110.50",
  "expiresAt": "2026-01-01T00:01:00.000Z",
  "usedAt": null,
  "isExpired": false,
  "isUsed": false,
  "secondsRemaining": 38
}
```

---

### Transaction Service

Every mutating endpoint requires an `Idempotency-Key` header.

**Domestic transfer**

```
POST /api/transfers
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "senderId": "user-1",
  "recipientId": "user-2",
  "amount": "100",
  "currency": "USD"
}
```

Response `201`:
```json
{
  "transactionId": "9f8e7d6c-...",
  "status": "COMPLETED",
  "amount": "100",
  "currency": "USD"
}
```

Duplicate key + same body → `200` with identical stored result. No second debit occurs.

---

**International transfer**

```
POST /api/transfers/international
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440001
Content-Type: application/json

{
  "senderId": "user-1",
  "recipientId": "user-2",
  "amount": "2000",
  "currency": "USD",
  "fxQuoteId": "ca597ba5-e966-460a-b904-c1ace0edb2df"
}
```

Response `201`: same shape as domestic. The `lockedFxRate` is written to the ledger entry for permanent audit.

Response `422 QUOTE_EXPIRED`: quote TTL elapsed. Client must re-request a fresh quote.

Response `422 QUOTE_ALREADY_USED`: quote was already consumed by another transfer.

---

**Get transfer status**

```
GET /api/transfers/{transactionId}
```

Response `200`:
```json
{
  "transactionId": "9f8e7d6c-...",
  "status": "COMPLETED",
  "senderId": "user-1",
  "recipientId": "user-2",
  "amount": "100",
  "currency": "USD",
  "processingStep": null,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

---

### Payroll Service

**Create and enqueue a bulk payroll job**

```
POST /api/payroll/jobs
Content-Type: application/json

{
  "employerId": "corp-1",
  "disbursements": [
    { "employeeId": "emp-1", "amount": "5000", "currency": "USD" },
    { "employeeId": "emp-2", "amount": "4500", "currency": "USD" }
  ]
}
```

Response `202`:
```json
{
  "jobId": "3c2b1a0f-...",
  "status": "QUEUED",
  "totalCount": 2,
  "totalAmount": "9500.00000000"
}
```

---

**Check job progress**

```
GET /api/payroll/jobs/{jobId}
```

Response `200`:
```json
{
  "jobId": "3c2b1a0f-...",
  "employerId": "corp-1",
  "status": "PROCESSING",
  "totalCount": 2,
  "processedCount": 1,
  "failedCount": 0,
  "checkpointIndex": 1,
  "totalAmount": "9500.00000000"
}
```

---

**List jobs**

```
GET /api/payroll/jobs?limit=50&offset=0
```

**List disbursements for a job**

```
GET /api/payroll/jobs/{jobId}/disbursements?limit=50&offset=0
```

---

### Admin Service

All admin endpoints require `X-Admin-Key: <value>` (env: `ADMIN_API_KEY`).

**Global ledger invariant check**

```
GET /api/admin/ledger/invariant
X-Admin-Key: admin-secret
```

Response `200`:
```json
{ "debitTotal": "10000.00", "creditTotal": "10000.00", "diff": "0", "balanced": true }
```

---

**Verify audit hash chain for a transaction**

```
GET /api/admin/ledger/verify/{transactionId}
X-Admin-Key: admin-secret
```

Response `200` (clean): `{ "valid": true }`

Response `200` (tampered): `{ "valid": false, "tamperedAt": "entry-uuid" }`

---

**List stuck transactions**

```
GET /api/admin/transactions/stuck
X-Admin-Key: admin-secret
```

Returns all transactions in `PROCESSING` status with `updatedAt` older than 2 minutes — these are candidates for saga recovery.

---

**Manually reverse a stuck transaction**

```
POST /api/admin/transactions/{transactionId}/reverse
X-Admin-Key: admin-secret
```

Response `200`: `{ "status": "REVERSED" }`

---

**Aggregate health check**

```
GET /api/admin/health
X-Admin-Key: admin-secret
```

Response `200` (all healthy) or `207` (one or more degraded):
```json
{
  "status": "ok",
  "services": {
    "account-service":     { "status": "ok" },
    "transaction-service": { "status": "ok" },
    "ledger-service":      { "status": "ok" },
    "fx-service":          { "status": "ok" },
    "payroll-service":     { "status": "ok" }
  }
}
```

---

## Idempotency — Five Scenarios

Every mutating endpoint on transaction-service requires an `Idempotency-Key` header. The middleware stores `(key, SHA-256(request body), status, result)` in PostgreSQL using `INSERT … ON CONFLICT DO NOTHING RETURNING` before any money movement begins.

### Scenario A — Duplicate request, same payload

A client retries a completed transfer with the same `Idempotency-Key` and identical body.

**What happens:** The `INSERT … ON CONFLICT DO NOTHING RETURNING` returns an empty array. The middleware reads the existing row, finds `status = COMPLETED` with a stored `result` JSON blob, and returns it immediately with `HTTP 200`. The transfer handler never executes. No second debit is ever attempted. The client receives exactly the same response body as the original request.

---

### Scenario B — Three concurrent requests within 100ms

Three identical requests arrive before any of them completes processing.

**What happens:** PostgreSQL's unique index on `idempotency_key` serializes contention at the database level. Exactly one `INSERT` wins and proceeds to the handler. The two losing requests receive an empty `RETURNING` result from their `ON CONFLICT DO NOTHING`. Both read the existing row: if it is `COMPLETED` they return the stored result; if `PROCESSING` they return `202`. Only one database row is ever inserted. The two losing requests perform zero additional writes. No distributed lock is needed — the unique constraint is the lock.

---

### Scenario C — Crash after debit, before credit

The service process crashes after debiting the sender's wallet but before crediting the recipient.

**What happens:** Immediately after the debit succeeds, the transaction record is updated with `processingStep = DEBIT_COMPLETE` before attempting the credit. A recovery worker polls every 30 seconds for rows in `status = PROCESSING` with `updatedAt` older than 2 minutes. On finding a row with `processingStep = DEBIT_COMPLETE`, it attempts to complete the credit up to 3 times. If credit succeeds, it writes ledger entries and marks the transaction `COMPLETED`. If all three credit attempts fail, it calls the account service to reverse the debit and marks the transaction `REVERSED`. The ledger is never left in an unbalanced state — either both sides complete or neither does.

---

### Scenario D — Expired key reused 30 hours later

A client reuses an `Idempotency-Key` created yesterday for a new transfer.

**What happens:** Every idempotency record has a `keyExpiresAt` set to 24 hours from creation. On `ON CONFLICT`, if `keyExpiresAt < now`, the old record is deleted and a fresh transaction is processed as if the key is new. The client receives a normal success response with an `expired` flag in the body indicating the old record was purged. This is treated as a client-side bug — clients should generate a fresh key per distinct transfer. The system cleans up rather than rejects, to accommodate legitimate mobile retry flows where a stored key ages out.

---

### Scenario E — Same key, different payload

A client sends the same `Idempotency-Key` but changes the amount.

**What happens:** The middleware computes `SHA-256(JSON.stringify(body))` and compares it against the stored `payloadHash`. A mismatch signals the client is attempting to use the same key for a different operation. The response is `409 IDEMPOTENCY_CONFLICT` with a message naming both the original amount and the attempted amount. The second amount is never processed. This prevents a category of bugs where a client accidentally submits the wrong amount and assumes idempotency will prevent double-charging — it will, but it will not silently swap the amount either.

---

## Double-Entry Ledger Invariant

Every `POST /ledger/entries` call must include at least one DEBIT entry and at least one CREDIT entry. Before opening any database transaction, the service layer validates:

```
sum(entries where type = DEBIT, using decimal.js) === sum(entries where type = CREDIT, using decimal.js)
```

All arithmetic uses `decimal.js`. JavaScript's native `Number` and `float` are never used for any monetary calculation anywhere in the codebase — IEEE-754 rounding errors are a known source of ledger drift.

If the sums do not match, the request returns `422` with the exact debit and credit totals. No partial write occurs — the database transaction never opens. This means a buggy caller cannot produce an unbalanced ledger even if it tries.

**Verification:** `GET /api/admin/ledger/invariant` recomputes `sum(all DEBIT entries)` and `sum(all CREDIT entries)` across the entire ledger table and returns the diff. A balanced system always returns `"diff": "0"`.

**Alerting:** The Prometheus counter `ledger_invariant_violation_total` increments on every rejected imbalanced request. An alert rule fires immediately at `> 0` — there is no delay or threshold. Any imbalance attempt is an engineering incident.

---

## FX Quote Strategy

FX rates are locked at request time and protected by a hard 60-second TTL and single-use enforcement.

### Quote lifecycle

1. **Issuance** — `POST /api/fx/quote` fetches a live rate from the provider and stores the quote with `expiresAt = now + 60s`. The client receives the `quoteId` and `secondsRemaining`.

2. **Consume** — Transaction service calls `POST /api/fx/quote/{id}/consume` atomically: `UPDATE fx_quotes SET usedAt = now() WHERE id = $1 AND usedAt IS NULL RETURNING *`. If `RETURNING` is empty, the quote was already consumed.

3. **Expiry enforcement** — Checked at consume time. If `expiresAt < now`, the response is `422 QUOTE_EXPIRED`. Expiry is not advisory — there is no grace period. The 60-second window is the window. Callers must re-initiate the transfer with a fresh quote.

4. **Single-use** — The atomic `WHERE usedAt IS NULL` clause is the enforcement. No two concurrent consumers can both receive a non-empty `RETURNING`. If the race is lost, the response is `422 QUOTE_ALREADY_USED`.

5. **Provider failure** — A `ProviderUnavailableError` returns `503`. There is no fallback to a cached rate, a recent rate, or an estimated rate. Serving a stale rate would silently misrepresent the exchange, which is worse than a visible 503. The explicit design decision is: fail loudly.

6. **Audit** — The `lockedFxRate` is written onto every cross-currency ledger entry at the time of credit. The exact rate used for every international transfer is permanently recorded and survives even if the quote record is later purged.

---

## Payroll Resumability

Payroll jobs disburse to potentially thousands of employees. A crash mid-job must not result in double-payment or lost payments.

### Checkpoint pattern

After each successful disbursement at index `i`, the job record is updated:

```
UPDATE payroll_jobs SET checkpointIndex = i + 1 WHERE jobId = $1
```

This write is atomic and happens before moving to `i + 1`. On any restart — crash, OOM, or manual re-trigger — `processPayrollJob` resumes the loop from `job.checkpointIndex`, skipping all previously completed indices.

### Idempotency key construction

Disbursement idempotency keys are deterministic:

```
${jobId}-${employeeId}-${index}
```

This means if a disbursement at index `i` was already submitted to transaction-service before the crash (but after submission and before the checkpoint was written), the retry will hit transaction-service with the same idempotency key and receive the cached result. No double payment occurs even in this edge case.

### Redis serialization

Each employer gets a dedicated Redis list (`LPOP` semantics) — only one payroll job runs per employer at a time. No database lock is held across disbursements. The "lock" window per disbursement is the time to pop from Redis, make one HTTP call, and advance the checkpoint — microseconds to a few hundred milliseconds. This avoids holding a `SELECT FOR UPDATE` row lock for the entire duration of a long payroll run.

---

## Audit Hash Chain

Every ledger entry is linked into a SHA-256 hash chain, making any post-write database tampering detectable.

### Hash construction

```
entryHash = SHA-256(
  previousHash
  + transactionId
  + accountId
  + amount
  + currency
  + createdAt
)
```

The first entry in the system uses the sentinel string `NOVAPAY_GENESIS_0000` as `previousHash`. Every subsequent entry's `previousHash` is the `entryHash` of the entry immediately preceding it for the same transaction.

### What tampered record detection means in practice

`GET /api/admin/ledger/verify/{transactionId}` recomputes every hash from the stored field values and compares it against the stored `entryHash`. If any field — amount, account, currency, timestamp — was changed in the database after the entry was written, the recomputed hash will not match the stored one. The response identifies exactly which entry broke the chain:

```json
{ "valid": false, "tamperedAt": "entry-uuid-here" }
```

The chain does not auto-correct. A false result is surfaced to an admin as an incident. This means:

- A developer who manually runs `UPDATE ledger_entries SET amount = ...` will be detected.
- A backup restored from a modified snapshot will be detected.
- Silent ledger corruption from a buggy migration is detectable by running the verifier after the migration.

The chain does not protect against a sophisticated attacker who also rewrites `entryHash` and `previousHash` in every downstream entry — full chain recomputation is not free and is not run continuously. It is a tamper-evidence mechanism, not a cryptographic seal.

---

## Observability

| Tool       | URL                    | Purpose |
|------------|------------------------|---------|
| Grafana    | http://localhost:3000  | Dashboards: transfer throughput, failure rate, ledger violations, API latency p95/p99 |
| Prometheus | http://localhost:9090  | Metrics scraped every 15s from all 6 services |
| Jaeger     | http://localhost:16686 | Distributed traces via OpenTelemetry OTLP HTTP |

**Critical alert:** `ledger_invariant_violation_total > 0` triggers immediately as severity `critical`. No threshold, no delay.

**FX failure trace:** When `FX_PROVIDER_DOWN=true`, the failed span is visible in Jaeger terminating at the fx-service with error status and propagated trace context from the originating transfer request.

---

## Tradeoffs Under Time Pressure

**Mock FX provider instead of a real integration**
The provider is an in-process function that returns a hardcoded rate. A real integration would need rate caching strategy, retry logic, fallback providers, and circuit breakers. The mock demonstrates the lifecycle (TTL, single-use, provider-down path) without the operational complexity of a live external API dependency.

**Static API keys instead of JWT**
All service-to-service auth and admin auth uses static keys passed via env. JWT with rotation, refresh tokens, and per-client scopes is the correct production approach — it is omitted because it is infrastructure overhead that does not demonstrate the core payment correctness properties this system is built to prove.

**Admin service proxies to other services instead of read replicas**
`GET /api/admin/ledger/invariant` reads directly from the ledger-service's database via an internal HTTP call. Under production load, aggregate queries should run against read replicas to avoid competing with write transactions on the primary.

**No circuit breakers on outbound calls**
Services call each other with plain `fetch`. If account-service becomes slow, transaction-service will queue up in-flight requests until timeouts fire. A circuit breaker (half-open/open states) would fail fast and shed load. Omitted because it does not affect correctness for the scenarios this system is demonstrating.

**100% OTel trace sampling**
Every request is traced. At production scale this would saturate Jaeger storage within hours. Sampling at 5–10% with head-based sampling and 100% on error spans is the standard approach.

**No rate limiting between internal services**
Nginx rate-limits external clients. Internal service-to-service calls are unlimited. A misconfigured payroll job with 50,000 employees could flood account-service.

---

## What Would Be Added Before Production

**Key management service (AWS KMS or HashiCorp Vault)**
`MASTER_ENCRYPTION_KEY` currently lives in an env var in `docker-compose.yml`. In production this secret must be managed by a KMS with audit logging, automatic rotation, and hardware-backed storage. The current envelope encryption architecture supports this — the DEK layer means only DEKs need re-encrypting on master key rotation, not all ciphertext.

**JWT authentication with rotation**
Replace static `X-Admin-Key` and service-to-service API keys with short-lived JWTs issued by an auth service. Scoped tokens per service, automatic refresh, and revocation via a token blocklist.

**PgBouncer connection pooling**
Each Bun service instance opens its own connection pool directly to Postgres. Under load, this exhausts the server's `max_connections`. PgBouncer in transaction-mode pooling sits in front of each Postgres instance and multiplexes hundreds of application connections onto a small pool.

**Read replicas for balance queries and history**
Balance reads and transaction history queries should hit read replicas. The write primary should only serve mutations. This also enables the admin aggregate queries to run without competing with live transfers.

**Circuit breakers on all outbound service calls**
Wrap every `fetch` call to another service with a circuit breaker: closed → open after N consecutive failures → half-open after a timeout → closed again on success. Prevents cascading failure when any one service degrades.

**Dead-letter queue for failed payroll disbursements**
Currently a disbursement that fails after all retries is recorded in `disbursement_records` with `status = FAILED` and the job continues. There is no automatic retry, no alerting, and no operator queue. A DLQ with visibility timeout and a dedicated reprocessing worker is needed.

**Sampling and tail-based tracing**
Reduce OTel sampling to ~5–10% for healthy requests. Use 100% sampling for all error spans and all spans above a latency threshold (tail-based sampling). This keeps Jaeger storage manageable while preserving full observability for every error.

**Rate limiting per API key**
Nginx currently rate-limits by client IP. API key-level rate limiting (using Redis token buckets) would prevent a single misbehaving client from exhausting internal capacity regardless of IP rotation.

**Formal dead letter and alerting for the saga recovery worker**
The saga recovery worker polls every 30 seconds. If the worker itself crashes or falls behind, stuck transactions accumulate silently beyond the 2-minute window. The worker should emit a heartbeat metric; an alert should fire if the heartbeat is absent for more than 2 polling cycles.

---

## Repository Structure

```
services/
  account-service/       Wallet CRUD, debit/credit, optimistic locking, AES-256-GCM encryption
  transaction-service/   Transfer saga, idempotency middleware, recovery worker
  ledger-service/        Double-entry bookkeeping, SHA-256 hash chain, invariant enforcement
  fx-service/            FX quote lifecycle — 60s TTL, single-use, locked rate on ledger
  payroll-service/       Bulk disbursements, Redis per-employer queue, checkpoint resumability
  admin-service/         Internal proxy: ledger audit, stuck-txn detection, aggregate health
infra/
  docker-compose.yml     Single-command full-stack startup
  nginx/nginx.conf       API gateway routing
  prometheus/            Scrape config + alert rules
  grafana/               Dashboard provisioning
.github/workflows/
  ci.yml                 Change-detection matrix: test + Docker build per changed service only
decisions.md             All engineering decisions, scenario deep-dives, and tradeoffs
```
