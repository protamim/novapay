# NovaPay Backend

Microservice payment backend addressing the four failure modes from the incident post-mortem:
idempotent disbursement, atomic double-entry ledger, locked FX quotes, and pre-computed transaction history.

## Prerequisites

- Docker ≥ 24 and Docker Compose V2
- Bun 1.x — **only needed for running tests locally**; production runs entirely in Docker

## Quick Start

```bash
cd infra
docker compose up --build
```

All six services, six PostgreSQL databases, Redis, Nginx gateway, Prometheus, Grafana, and Jaeger start automatically. Migrations run on each service's startup before the server listens.

## Service URLs (after `docker compose up`)

| Service         | URL                      |
|-----------------|--------------------------|
| API Gateway     | http://localhost         |
| Grafana         | http://localhost:3000    |
| Prometheus      | http://localhost:9090    |
| Jaeger          | http://localhost:16686   |

All external API traffic routes through Nginx at `http://localhost`. Internal services communicate directly via Docker Compose networking.

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
  "id": "uuid",
  "userId": "user-123",
  "currency": "USD",
  "balance": "0.00000000",
  "accountRef": null,
  "version": 0,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

**Get wallet (balance + metadata)**
```
GET /api/accounts/{userId}
```
Response `200`: same shape as create.

**Debit / Credit — internal, called by transaction-service**
```
POST /api/accounts/{userId}/debit    { "amount": "100" }
POST /api/accounts/{userId}/credit   { "amount": "100" }
```
Response `200`: `{ "balance": "900.00000000" }`

---

### FX Service

**Request a rate quote (60-second TTL)**
```
POST /api/fx/quote
Content-Type: application/json

{ "fromCurrency": "USD", "toCurrency": "BDT" }
```
Response `201`:
```json
{
  "quoteId": "uuid",
  "rate": "110.5",
  "expiresAt": "2026-01-01T00:01:00.000Z",
  "secondsRemaining": 60
}
```

**Fetch quote status**
```
GET /api/fx/quote/{quoteId}
```
Response `200`:
```json
{
  "id": "uuid",
  "fromCurrency": "USD",
  "toCurrency": "BDT",
  "rate": "110.5",
  "expiresAt": "2026-01-01T00:01:00.000Z",
  "usedAt": null,
  "isExpired": false,
  "isUsed": false,
  "secondsRemaining": 42
}
```

---

### Transaction Service

**Domestic transfer**
```
POST /api/transfers
Idempotency-Key: <client-generated-uuid>
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
{ "transactionId": "uuid", "status": "COMPLETED", "amount": "100", "currency": "USD" }
```

Duplicate request (same key + body): returns `200` with the identical stored result. No second debit.

**International transfer (requires unexpired FX quote)**
```
POST /api/transfers/international
Idempotency-Key: <client-generated-uuid>
Content-Type: application/json

{
  "senderId": "user-1",
  "recipientId": "user-2",
  "amount": "2000",
  "currency": "USD",
  "fxQuoteId": "quote-uuid"
}
```
Response `201`: same shape as domestic transfer, with `lockedFxRate` recorded in ledger.

**Get transfer status**
```
GET /api/transfers/{transactionId}
```

---

### Payroll Service

**Create and enqueue bulk payroll job**
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
{ "jobId": "uuid", "status": "QUEUED", "totalCount": 2, "totalAmount": "9500.00000000" }
```

**Check job progress**
```
GET /api/payroll/jobs/{jobId}
```
Response `200`:
```json
{
  "jobId": "uuid",
  "employerId": "corp-1",
  "status": "PROCESSING",
  "totalCount": 2,
  "processedCount": 1,
  "failedCount": 0,
  "checkpointIndex": 1,
  "totalAmount": "9500.00000000"
}
```

**List all jobs (admin use)**
```
GET /api/payroll/jobs?limit=50&offset=0
```

**Paginated disbursement records for a job**
```
GET /api/payroll/jobs/{jobId}/disbursements?limit=50&offset=0
```

---

### Admin Service

All admin endpoints require `X-Admin-Key: admin-secret` header (set via `ADMIN_API_KEY` env var).

**Global ledger invariant check**
```
GET /api/admin/ledger/invariant
X-Admin-Key: admin-secret
```
Response `200`:
```json
{ "debitTotal": "1000.00", "creditTotal": "1000.00", "diff": "0", "balanced": true }
```

**Verify audit hash chain for a transaction**
```
GET /api/admin/ledger/verify/{transactionId}
X-Admin-Key: admin-secret
```
Response (clean): `{ "valid": true }`
Response (tampered): `{ "valid": false, "tamperedAt": "entry-uuid" }`

**List stuck transactions (PROCESSING > 2 minutes)**
```
GET /api/admin/transactions/stuck
X-Admin-Key: admin-secret
```

**Manually reverse a stuck transaction**
```
POST /api/admin/transactions/{transactionId}/reverse
X-Admin-Key: admin-secret
```

**Aggregate health check**
```
GET /api/admin/health
X-Admin-Key: admin-secret
```
Response `200` (all healthy) or `207` (degraded):
```json
{
  "status": "ok",
  "services": {
    "account-service": { "status": "ok" },
    "transaction-service": { "status": "ok" },
    "ledger-service": { "status": "ok" },
    "fx-service": { "status": "ok" },
    "payroll-service": { "status": "ok" }
  }
}
```

---

## System Design — Key Behaviours

### Idempotency (5 Scenarios)

Every mutating endpoint requires an `Idempotency-Key` header. The key and `SHA-256(request body)` are stored in PostgreSQL before any money movement begins.

| Scenario | Mechanism |
|----------|-----------|
| **A — Duplicate (same payload)** | `INSERT … ON CONFLICT DO NOTHING` returns empty. Middleware reads the existing `COMPLETED` record and returns the stored result with `200`. Transfer handler never runs — no second debit. |
| **B — Three concurrent requests in 100ms** | PostgreSQL's unique index on `idempotency_key` serializes at the DB level. Exactly one `INSERT` wins; the two losing requests receive an empty `RETURNING`. Both read the existing row and return the cached result. Exactly one DB row ever exists. |
| **C — Crash after debit, before credit** | `processingStep = DEBIT_COMPLETE` is written immediately after the debit succeeds. Recovery worker polls every 30 s for `status = PROCESSING` rows older than 2 minutes. It retries the credit (3 attempts). On success → writes ledger entries and marks `COMPLETED`. On failure → reverses the debit → marks `REVERSED`. Ledger never unbalances. |
| **D — Expired key reused 30 hours later** | `keyExpiresAt` is checked on every conflict. If expired, the old record is deleted and a fresh transaction is created. Client receives success with `note` indicating expiry. This is a client-side bug — clients should generate new keys. |
| **E — Same key, different payload** | `SHA-256(body)` is compared against the stored `payloadHash`. Mismatch → `409 IDEMPOTENCY_CONFLICT` with the message naming both amounts. Second amount is never processed. |

### Double-Entry Ledger Invariant

Every `POST /ledger/entries` validates `sum(DEBIT) === sum(CREDIT)` with `decimal.js` (no JS floats) before opening a DB transaction. Any imbalance → `422` — no partial writes occur. The Prometheus counter `ledger_invariant_violation_total` fires on any violation; an alert rule triggers at `> 0` (immediate, no delay).

### FX Quote Lifecycle

1. `POST /fx/quote` — fetches live rate from provider, stores quote with `expiresAt = now + 60s`
2. Transaction service calls `POST /fx/quote/{id}/consume` — atomic `UPDATE … WHERE usedAt IS NULL RETURNING`
3. `expiresAt < now` → `422 QUOTE_EXPIRED`. Caller must re-initiate with a new quote.
4. Already consumed → `422 QUOTE_ALREADY_USED`. One quote equals one transfer.
5. Provider unavailable → `503`. No cached or stale rate is ever served.
6. Locked rate is written to every cross-currency ledger entry for permanent auditability.

### Payroll Resumability

`checkpointIndex` advances atomically after each successful disbursement. On crash recovery, `processPayrollJob` resumes the loop from `job.checkpointIndex`. Idempotency keys are deterministic (`${jobId}-${employeeId}-${index}`), so any disbursement already submitted before the crash returns the cached result from transaction-service — no double-payment on resume.

### Audit Hash Chain

Each ledger entry stores `previousHash` and `entryHash = SHA-256(previousHash + transactionId + accountId + amount + currency + createdAt)`. `GET /admin/ledger/verify/:transactionId` recomputes the chain. Any field modified in the DB after writing breaks the chain. Response: `{ valid: false, tamperedAt: "<entryId>" }`.

### Field-Level Encryption

Sensitive fields (e.g., `encrypted_account_ref` in wallets) use AES-256-GCM via the WebCrypto API. A per-record IV is generated at write time. The master key is loaded from `MASTER_ENCRYPTION_KEY` (hex-encoded 32-byte key in env). Raw plaintext never appears in any DB column or log line.

---

## Running Tests

```bash
# Single service
cd services/transaction-service && bun test

# All services at once
for s in services/*/; do (cd "$s" && bun test); done
```

All tests use `bun:test` with `mock.module` for dependency injection — no live database or network required. Tests cover all 5 idempotency scenarios, ledger invariant enforcement, hash chain integrity, FX quote lifecycle, and payroll checkpoint resumability.

---

## Observability

| Tool       | URL                      | Purpose |
|------------|--------------------------|---------|
| Grafana    | http://localhost:3000    | Dashboards: transaction throughput, failure rate, ledger violations, API latency p95/p99 |
| Prometheus | http://localhost:9090    | Metrics scraping every 15 s from all 6 services |
| Jaeger     | http://localhost:16686   | Distributed traces via OpenTelemetry OTLP HTTP |

**Alert:** `ledger_invariant_violation_total > 0` fires immediately as `critical`.

**FX failure scenario:** Set `FX_PROVIDER_DOWN=true` on the fx-service container. All `POST /fx/quote` calls return `503`. Traces in Jaeger show the span terminating at the FX service with error status.

---

## Repository Structure

```
services/
  account-service/       Wallet management, debit/credit with optimistic locking
  transaction-service/   Transfer saga, idempotency middleware, recovery worker
  ledger-service/        Double-entry bookkeeping, SHA-256 hash chain, invariant checks
  fx-service/            FX quote lifecycle, 60s TTL, single-use enforcement
  payroll-service/       Batch disbursements, checkpoint resumability, Redis queue
  admin-service/         Internal proxy: ledger audit, stuck-txn detection, health
infra/
  docker-compose.yml     Fully self-contained — no external setup required
  nginx/nginx.conf       API gateway routing for all 6 services
  prometheus/            Scrape config + alert rules
  grafana/               Dashboard provisioning
.github/workflows/
  ci.yml                 Change-detection matrix: test → Docker build per service only
decisions.md             Engineering decisions: idempotency scenarios, tradeoffs, production gaps
```

## Tradeoffs and Production Gaps

See [decisions.md](decisions.md) for the full list. Key items:
- Mock FX provider (no real external API)
- Static API key auth (no JWT rotation)
- No circuit breakers between services
- 100% OTel trace sampling (reduce to ~5–10% in production)
- No PgBouncer connection pooling
