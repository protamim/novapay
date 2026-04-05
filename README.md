# NovaPay Backend

## Prerequisites

- Docker and Docker Compose
- Bun 1.x (for local development and running tests only)

## Start Everything

```bash
docker compose up --build
```

All six services, six PostgreSQL databases, Redis, Nginx gateway, Prometheus, Grafana, and Jaeger start automatically.

## Service URLs

| Service     | URL                      |
|-------------|--------------------------|
| API Gateway | http://localhost         |
| Grafana     | http://localhost:3000    |
| Prometheus  | http://localhost:9090    |
| Jaeger      | http://localhost:16686   |

All API traffic routes through Nginx at `http://localhost`. Direct service ports are not exposed externally.

---

## API Endpoints

### Account Service

**Create wallet**
```
POST /api/accounts
Content-Type: application/json

{ "userId": "user-123", "currency": "USD" }
```
Response:
```json
{ "success": true, "data": { "walletId": "uuid", "balance": "0", "currency": "USD" } }
```

**Get balance**
```
GET /api/accounts/{walletId}/balance
```

**Debit / Credit (internal — called by transaction-service)**
```
POST /api/accounts/{walletId}/debit
POST /api/accounts/{walletId}/credit
```

---

### FX Service

**Request a rate quote (60-second TTL)**
```
POST /api/fx/quote
Content-Type: application/json

{ "fromCurrency": "USD", "toCurrency": "BDT", "amount": "2000" }
```
Response:
```json
{
  "quoteId": "uuid",
  "rate": "110.5",
  "expiresAt": "2024-01-01T00:01:00.000Z",
  "secondsRemaining": 60
}
```

**Fetch quote status**
```
GET /api/fx/quote/{quoteId}
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
Response:
```json
{ "transactionId": "uuid", "status": "COMPLETED", "amount": "100", "currency": "USD" }
```

**International transfer (requires FX quote)**
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

---

### Payroll Service

**Create and enqueue payroll job**
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
Response:
```json
{ "jobId": "uuid", "status": "QUEUED", "totalCount": 2, "totalAmount": "9500.00000000" }
```

**Check job progress**
```
GET /api/payroll/jobs/{jobId}
```

---

### Admin Service

**Global ledger invariant check**
```
GET /api/admin/ledger/invariant
X-Admin-Key: admin-secret
```
Response:
```json
{ "debitTotal": "1000.00", "creditTotal": "1000.00", "diff": "0", "balanced": true }
```

**Verify audit hash chain for a transaction**
```
GET /api/admin/ledger/verify/{transactionId}
X-Admin-Key: admin-secret
```
Response (clean):
```json
{ "valid": true }
```
Response (tampered):
```json
{ "valid": false, "tamperedAt": "entry-uuid" }
```

---

## System Design — Key Behaviours

### Idempotency (5 Scenarios)

Every mutating endpoint requires an `Idempotency-Key` header. The key + `SHA-256(body)` are stored in PostgreSQL.

| Scenario | What happens |
|----------|-------------|
| **A — Duplicate (same payload)** | `INSERT … ON CONFLICT DO NOTHING` returns empty. Middleware reads existing COMPLETED record and returns stored result. Handler never executes — no second debit. |
| **B — Three concurrent requests** | PostgreSQL's unique index serializes at the DB level. Exactly one INSERT succeeds. The two losing requests read the existing row and return its result. Zero extra writes. |
| **C — Crash (DEBIT_COMPLETE)** | `processingStep` column persists the saga position. Recovery worker detects PROCESSING + age > 2min. Retries credit (3 attempts). On success → COMPLETED. On failure → reverses debit → REVERSED. |
| **D — Expired key (30h later)** | `keyExpiresAt` check. Expired record is deleted. New transaction created. Client receives success with `expired=true` flag. Client should use fresh keys — this is a client-side bug. |
| **E — Same key, different amount** | `payloadHash` mismatch → 409 `IDEMPOTENCY_CONFLICT` with message naming both amounts. Second amount never processed. |

### Double-Entry Ledger Invariant

Every `POST /ledger/entries` validates `sum(DEBIT) == sum(CREDIT)` using `decimal.js` (never JS float) before opening a DB transaction. Violation → 422. Prometheus counter `ledger_invariant_violation_total` fires immediately; alert threshold is `> 0`.

### FX Quote Lifecycle

1. `POST /fx/quote` — fetches live rate, stores quote with `expiresAt = now + 60s`
2. Consumer calls `POST /fx/quote/{id}/consume` — atomic `UPDATE WHERE usedAt IS NULL`
3. If `expiresAt < now` → 422 `QUOTE_EXPIRED`. Never served stale.
4. If already consumed → 422 `QUOTE_ALREADY_USED`
5. If provider is down → 503. No cached fallback, ever.
6. Locked rate is written to the ledger entry for permanent auditability.

### Payroll Resumability

`checkpointIndex` advances after each successful disbursement. On crash recovery, `processPayrollJob` is re-called with the same `jobId` and resumes from `checkpointIndex`. Idempotency keys are deterministic (`${jobId}-${employeeId}-${index}`) — any disbursement that was already submitted returns the cached result from transaction-service. No double-payments on resume.

### Audit Hash Chain

Each ledger entry stores `previousHash` and `entryHash = SHA-256(previousHash + transactionId + accountId + amount + currency + createdAt)`. `GET /ledger/verify/:transactionId` recomputes the chain. Any DB edit after the fact breaks the hash. Response: `{ valid: false, tamperedAt: "<entryId>" }`. Tampered records are flagged but not auto-corrected.

---

## Running Tests

```bash
# From any service directory:
cd services/transaction-service
bun test

# All services:
for s in services/*/; do (cd "$s" && bun test); done
```

Tests use Bun's built-in test runner with `mock.module` for dependency injection. No external services or databases required — all DB interactions are mocked.

---

## Repository Structure

```
services/
  account-service/       Wallet management, debit/credit
  transaction-service/   Transfer saga, idempotency middleware, recovery worker
  ledger-service/        Double-entry bookkeeping, hash chain, invariant checks
  fx-service/            FX quote lifecycle, provider abstraction
  payroll-service/       Batch disbursements, checkpoint resumability
  admin-service/         Internal dashboards, ledger audit proxy
infra/
  docker-compose.yml
  nginx.conf
  prometheus.yml
  grafana/               Datasource provisioning
.github/workflows/
  ci.yml                 Change-detection matrix build: test → Docker build per service
decisions.md             Engineering decision records with full scenario explanations
```
