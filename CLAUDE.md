# NovaPay — CLAUDE.md

## Project Overview

NovaPay is a microservice payment backend built to address four failure modes from a post-mortem: idempotent disbursement, atomic double-entry ledger, locked FX quotes, and pre-computed transaction history.

## Running the Project

```bash
# Start everything (all 6 services + infra)
cd infra && docker compose up --build

# Run tests for a single service
cd services/<service-name> && bun test

# Run all tests
for s in services/*/; do (cd "$s" && bun test); done

# Run migrations (handled automatically on startup, but manual trigger):
bun run migrate
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun 1.x |
| Framework | Hono |
| ORM | Drizzle ORM |
| Database | PostgreSQL (one DB per service) |
| Queue | Redis (via ioredis) |
| Metrics | prom-client → Prometheus |
| Tracing | OpenTelemetry OTLP HTTP → Jaeger |
| Logging | pino (with `redact` for sensitive fields) |
| Decimal math | decimal.js — **never use JS `Number` or `float` for money** |
| Testing | `bun:test` with `mock.module` — no live DB or network |
| Container | Docker Compose (fully self-contained) |
| Gateway | Nginx |

## Repository Structure

```
services/
  account-service/       Wallet CRUD, debit/credit, optimistic locking, AES-256-GCM field encryption
  transaction-service/   Transfer saga, idempotency middleware, Saga recovery worker
  ledger-service/        Double-entry bookkeeping, SHA-256 audit hash chain, invariant checks
  fx-service/            FX quote lifecycle — 60s TTL, single-use, locked rate on ledger
  payroll-service/       Bulk disbursements, Redis per-employer queue, checkpoint resumability
  admin-service/         Internal proxy: ledger audit, stuck-txn detection, aggregate health
infra/
  docker-compose.yml     Single-command full-stack startup
  nginx/nginx.conf       API gateway routing
  prometheus/            Scrape config + alert rules
  grafana/               Dashboard provisioning
.github/workflows/ci.yml Change-detection matrix: test + Docker build per changed service only
decisions.md             All engineering decisions, scenario deep-dives, tradeoffs, production gaps
```

## Service URLs (after `docker compose up`)

| Service     | URL                    |
|-------------|------------------------|
| API Gateway | http://localhost       |
| Grafana     | http://localhost:3000  |
| Prometheus  | http://localhost:9090  |
| Jaeger      | http://localhost:16686 |

All external traffic routes through Nginx. Services communicate directly over Docker Compose networking (no gateway hop for internal calls).

## Key Architectural Patterns

### Idempotency (transaction-service)
- Every mutating endpoint requires an `Idempotency-Key` header.
- Key + `SHA-256(request body)` stored in Postgres before any money movement.
- `INSERT … ON CONFLICT DO NOTHING RETURNING` — if empty, fetch and return existing result.
- Five handled scenarios: duplicate, concurrent, crash recovery, expired key, mismatched payload. See `decisions.md` for full mechanics.

### Double-Entry Ledger (ledger-service)
- `POST /ledger/entries` validates `sum(DEBIT) === sum(CREDIT)` using `decimal.js` before opening any DB transaction.
- Imbalance → `422`, no partial write.
- Prometheus counter `ledger_invariant_violation_total` — alert fires immediately at `> 0`.

### FX Quote Lifecycle (fx-service)
- Quote TTL: 60 seconds. Expiry is enforced at consume time, not advisory.
- Single-use: atomic `UPDATE … WHERE usedAt IS NULL RETURNING`.
- Provider unavailable → `503`. No fallback to cached/stale rates — ever.
- `lockedFxRate` is written to every cross-currency ledger entry for auditability.

### Saga Recovery (transaction-service)
- `processingStep = DEBIT_COMPLETE` is written immediately after debit, before credit attempt.
- Recovery worker polls every 30 s for `status = PROCESSING` rows older than 2 minutes.
- On recovery: retry credit up to 3 times → `COMPLETED`, or reverse debit → `REVERSED`.

### Payroll Checkpoint (payroll-service)
- `checkpointIndex` advances atomically after each successful disbursement.
- Crash recovery resumes from `checkpointIndex`; deterministic idempotency keys (`${jobId}-${employeeId}-${index}`) prevent double-payment.
- One Redis list per `employerId` (`LPOP` for serialization) — no DB lock held across disbursements.

### Audit Hash Chain (ledger-service)
- `entryHash = SHA-256(previousHash + transactionId + accountId + amount + currency + createdAt)`
- Genesis entry uses sentinel `NOVAPAY_GENESIS_0000` as `previousHash`.
- `GET /admin/ledger/verify/:transactionId` recomputes chain; any DB-level tamper breaks it.

### Field-Level Encryption (account-service)
- Sensitive fields encrypted with AES-256-GCM (WebCrypto API), per-record IV.
- DEK encrypted with master key from `MASTER_ENCRYPTION_KEY` env var.
- Raw plaintext never in DB or logs. pino `redact` covers all sensitive field names.

## Money Arithmetic Rule

**Always use `decimal.js`.** Never use JavaScript `Number`, `float`, or native arithmetic for any monetary calculation. This applies across all services.

## Testing Conventions

- Framework: `bun:test` with `mock.module`
- No live database or network in tests
- Coverage: all 5 idempotency scenarios, ledger invariant, hash chain integrity, FX lifecycle, payroll checkpoint resumability
- Run per-service: `cd services/<name> && bun test`

## Auth

Currently static API key auth per service. Admin endpoints require `X-Admin-Key` header (env: `ADMIN_API_KEY`). No JWT — this is a known production gap (see `decisions.md`).

## Known Production Gaps (do not "fix" without discussion)

- Mock FX provider (`FX_PROVIDER_DOWN=true` env simulates outage)
- Static API keys instead of JWT with rotation
- No circuit breakers between services
- 100% OTel trace sampling (intentional for dev)
- No PgBouncer connection pooling
- No dead-letter queue for failed payroll disbursements
- No rate limiting between internal services (Nginx only rate-limits external)

Full rationale in [decisions.md](decisions.md).

## Environment Variables (per service)

Each service reads its own `DATABASE_URL`, `REDIS_URL`, and service-specific vars from Docker Compose. `MASTER_ENCRYPTION_KEY` is required for account-service. `ADMIN_API_KEY` is required for admin-service. `FX_PROVIDER_DOWN` (optional, fx-service) simulates provider failure.
