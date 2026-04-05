# NovaPay — API Reference

All services share a common `/api` base path. Start the stack with `cd infra && docker compose up --build`.

---

## Access

### Direct (recommended for development and testing)

Each service is accessible on its own port:

| Service             | Base URL                        | Port |
|---------------------|---------------------------------|------|
| Account Service     | `http://localhost:3001/api`     | 3001 |
| Transaction Service | `http://localhost:3002/api`     | 3002 |
| Ledger Service      | `http://localhost:3003/api`     | 3003 |
| FX Service          | `http://localhost:3004/api`     | 3004 |
| Payroll Service     | `http://localhost:3005/api`     | 3005 |
| Admin Service       | `http://localhost:3006/api`     | 3006 |

### API Gateway (Nginx, port 80)

Nginx proxies the following path prefixes to each service:

| Path prefix      | Upstream service    |
|------------------|---------------------|
| `/api/accounts`  | account-service     |
| `/api/transfers` | transaction-service |
| `/api/ledger`    | ledger-service      |
| `/api/fx`        | fx-service          |
| `/api/payroll`   | payroll-service     |
| `/api/admin`     | admin-service       |

---

## Authentication

| Endpoint group        | Required header                           |
|-----------------------|-------------------------------------------|
| Transfer endpoints    | `Idempotency-Key: <uuid>` (see below)     |
| Admin endpoints       | `X-Admin-Key: <key>` (env: `ADMIN_API_KEY`, default: `admin-secret`) |
| All other endpoints   | None                                      |

---

## Conventions

- **Amounts** — always strings (`"100.00"`). Never use floats. Internally uses `decimal.js`.
- **IDs** — UUIDs.
- **Timestamps** — ISO 8601 strings.
- **Errors** — always `{ "error": "..." }` JSON.
- **Content-Type** — `application/json` for all requests with a body.

---

## Idempotency (Transaction Service)

All mutating transfer endpoints enforce idempotency.

**Required header:** `Idempotency-Key: <any-unique-string>`

Keys are valid for **24 hours**. The key + `SHA-256(request body)` are stored atomically before any money moves.

| Scenario | Behaviour |
|---|---|
| First request | Executes and stores result |
| Duplicate (same key + same payload) | Returns `200` with the cached result — no money moves |
| In-flight duplicate | Returns `202 { "status": "PROCESSING" }` — poll `/transfers/:id` |
| Same key, different payload | Returns `409 IDEMPOTENCY_CONFLICT` |
| Expired key (>24 h), reused | Treated as a fresh request; `201` response includes `note` field |

---

## Account Service

Manages wallets — creation, balances, debit, and credit.

---

### `POST /api/accounts`

Create a wallet for a user.

**Request body**

```json
{
  "userId": "user-123",
  "currency": "USD",
  "accountRef": {}
}
```

| Field        | Type   | Required | Description                       |
|--------------|--------|----------|-----------------------------------|
| `userId`     | string | yes      | Unique user identifier            |
| `currency`   | string | no       | Defaults to `USD`                 |
| `accountRef` | object | no       | Arbitrary metadata                |

**Response `201`**

```json
{
  "id": "a1b2c3d4-...",
  "userId": "user-123",
  "currency": "USD",
  "balance": "0.00",
  "version": 1,
  "createdAt": "2026-04-06T00:00:00.000Z"
}
```

**Errors**

| Status | `error` value                           |
|--------|-----------------------------------------|
| 400    | `userId is required`                    |
| 409    | `Wallet already exists for user user-X` |

---

### `GET /api/accounts/:userId`

Fetch a wallet and its current balance.

**Response `200`**

```json
{
  "id": "a1b2c3d4-...",
  "userId": "user-123",
  "currency": "USD",
  "balance": "980.00",
  "version": 5,
  "createdAt": "2026-04-06T00:00:00.000Z"
}
```

**Errors**

| Status | `error` value                         |
|--------|---------------------------------------|
| 404    | `Wallet not found for user user-123`  |

---

### `POST /api/accounts/:userId/debit`

Debit an amount from a wallet. Used internally by the transaction service — not intended for direct client calls.

**Request body**

```json
{ "amount": "50.00" }
```

**Response `200`**

```json
{ "balance": "930.00" }
```

**Errors**

| Status | `error` value                                     |
|--------|---------------------------------------------------|
| 400    | `amount is required`                              |
| 402    | `Insufficient funds`                              |
| 404    | `Wallet not found for user user-X`                |
| 409    | `Concurrent modification detected — please retry` |

> The 409 uses optimistic locking (`version` column). The caller should retry the operation.

---

### `POST /api/accounts/:userId/credit`

Credit an amount to a wallet. Used internally by the transaction service.

**Request body**

```json
{ "amount": "50.00" }
```

**Response `200`**

```json
{ "balance": "1030.00" }
```

**Errors**

| Status | `error` value                                     |
|--------|---------------------------------------------------|
| 400    | `amount is required`                              |
| 404    | `Wallet not found for user user-X`                |
| 409    | `Concurrent modification detected — please retry` |

---

## Transaction Service

Orchestrates money movement via a saga pattern: debit → (FX consume) → credit → ledger entries. A saga recovery worker runs every 30 seconds to resolve stuck transactions.

---

### `POST /api/transfers`

Domestic transfer between two wallets in the same currency.

**Required header:** `Idempotency-Key: <uuid>`

**Request body**

```json
{
  "senderId": "user-123",
  "recipientId": "user-456",
  "amount": "100.00",
  "currency": "USD"
}
```

**Response `201`**

```json
{
  "transactionId": "8224fb63-...",
  "status": "COMPLETED",
  "amount": "100.00",
  "currency": "USD"
}
```

**Errors**

| Status | `error` value                             |
|--------|-------------------------------------------|
| 400    | `Idempotency-Key header is required`      |
| 402    | `Insufficient funds`                      |
| 404    | `Wallet not found for user user-X`        |
| 409    | `IDEMPOTENCY_CONFLICT`                    |

---

### `POST /api/transfers/international`

Cross-currency transfer. Requires a pre-created, non-expired FX quote. The quote is consumed atomically — it cannot be reused.

**Required header:** `Idempotency-Key: <uuid>`

**Request body**

```json
{
  "senderId": "user-123",
  "recipientId": "user-456",
  "amount": "120.00",
  "currency": "USD",
  "fxQuoteId": "67f69214-5a8d-4902-9d8f-0416c5f54960"
}
```

| Field        | Type   | Required | Description                                        |
|--------------|--------|----------|----------------------------------------------------|
| `fxQuoteId`  | string | yes      | UUID from `POST /api/fx/quote`. Valid for 60 s.    |

**Response `201`**

```json
{
  "transactionId": "634a6eab-...",
  "status": "COMPLETED",
  "amount": "120.00",
  "currency": "USD"
}
```

**Errors**

| Status | `error` value                                        |
|--------|------------------------------------------------------|
| 400    | `Idempotency-Key header is required`                 |
| 400    | `fxQuoteId is required for international transfers`  |
| 400    | `Invalid quote ID format`                            |
| 402    | `Insufficient funds`                                 |
| 404    | `Quote not found`                                    |
| 409    | `IDEMPOTENCY_CONFLICT`                               |
| 422    | `QUOTE_EXPIRED`                                      |
| 422    | `QUOTE_ALREADY_USED`                                 |

> **Workflow:** Create a quote first → `POST /api/fx/quote`, then use `quoteId` here within 60 seconds.

---

### `GET /api/transfers/:transactionId`

Fetch the current status and result of any transaction.

**Response `200`**

```json
{
  "transactionId": "8224fb63-...",
  "status": "COMPLETED",
  "type": "FX_TRANSFER",
  "senderId": "user-123",
  "recipientId": "user-456",
  "amount": "120.00",
  "currency": "USD",
  "fxQuoteId": "67f69214-...",
  "lockedFxRate": "0.92000000",
  "processingStep": "CREDIT_COMPLETE",
  "failureReason": null,
  "result": { "transactionId": "...", "status": "COMPLETED", "amount": "120.00", "currency": "USD" },
  "completedAt": "2026-04-06T00:01:00.000Z",
  "createdAt": "2026-04-06T00:00:00.000Z"
}
```

**`status` lifecycle**

```
PENDING → PROCESSING → COMPLETED
                     → FAILED
                     → REVERSED
```

**`processingStep` values**

| Value            | Meaning                                     |
|------------------|---------------------------------------------|
| `null`           | Not yet started                             |
| `DEBIT_COMPLETE` | Sender debited; credit not yet attempted    |
| `CREDIT_COMPLETE`| Both sides settled                          |

**Errors**

| Status | `error` value          |
|--------|------------------------|
| 404    | `Transaction not found`|

---

### `GET /api/transfers/stuck`

List `PROCESSING` transactions older than 2 minutes. These are candidates for the saga recovery worker or manual reversal.

**Response `200`**

```json
{
  "count": 1,
  "transactions": [
    {
      "transactionId": "...",
      "status": "PROCESSING",
      "processingStep": "DEBIT_COMPLETE",
      "senderId": "user-123",
      "recipientId": "user-456",
      "amount": "100.00",
      "currency": "USD",
      "updatedAt": "2026-04-06T00:00:00.000Z",
      "createdAt": "2026-04-06T00:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/transfers/:id/reverse`

Manually trigger a reversal of a `PROCESSING` transaction. The sender's debit is refunded. The recovery worker does this automatically but this endpoint allows immediate action.

**Response `200`**

```json
{
  "transactionId": "...",
  "status": "REVERSED"
}
```

**Errors**

| Status | `error` value                                            |
|--------|----------------------------------------------------------|
| 404    | `Transaction not found`                                  |
| 409    | `Cannot reverse a transaction in status COMPLETED`       |

---

## FX Service

Manages exchange-rate quotes. Quotes have a **60-second TTL** and are **single-use**. There is no fallback to stale rates — if the provider is down, requests fail hard.

---

### `POST /api/fx/quote`

Request a live FX rate quote.

**Request body**

```json
{
  "fromCurrency": "USD",
  "toCurrency": "EUR"
}
```

**Response `201`**

```json
{
  "quoteId": "67f69214-5a8d-4902-9d8f-0416c5f54960",
  "rate": "0.92000000",
  "expiresAt": "2026-04-06T00:01:00.000Z",
  "secondsRemaining": 60
}
```

**Errors**

| Status | `error` value                              |
|--------|--------------------------------------------|
| 400    | `fromCurrency and toCurrency are required` |
| 503    | `FX provider unavailable`                  |

> `503` is returned when `FX_PROVIDER_DOWN=true` is set. No stale-rate fallback — ever.

---

### `GET /api/fx/quote/:id`

Inspect a quote — check its rate, expiry, and whether it has been used.

**Response `200`**

```json
{
  "id": "67f69214-...",
  "fromCurrency": "USD",
  "toCurrency": "EUR",
  "rate": "0.92000000",
  "expiresAt": "2026-04-06T00:01:00.000Z",
  "usedAt": null,
  "isExpired": false,
  "isUsed": false,
  "secondsRemaining": 38
}
```

**Errors**

| Status | `error` value           |
|--------|-------------------------|
| 400    | `Invalid quote ID format`|
| 404    | `Quote not found`        |

---

### `POST /api/fx/quote/:id/consume`

**Internal endpoint — called by transaction-service only.**

Atomically marks a quote as used and returns the locked rate. Uses `UPDATE … WHERE usedAt IS NULL RETURNING` to prevent races.

**Response `200`**

```json
{
  "quoteId": "67f69214-...",
  "rate": "0.92000000",
  "usedAt": "2026-04-06T00:00:22.000Z"
}
```

**Errors**

| Status | `error` value            |
|--------|--------------------------|
| 400    | `Invalid quote ID format` |
| 404    | `Quote not found`         |
| 422    | `QUOTE_EXPIRED`           |
| 422    | `QUOTE_ALREADY_USED`      |

---

## Ledger Service

Double-entry bookkeeping with a SHA-256 audit hash chain. Every entry is linked to its predecessor — any DB-level tamper breaks the chain.

---

### `POST /api/ledger/entries`

Write a balanced set of ledger entries. The sum of all `DEBIT` amounts must exactly equal the sum of all `CREDIT` amounts (validated with `decimal.js` before any DB write).

**Request body** (two forms accepted)

```json
{
  "entries": [
    {
      "transactionId": "8224fb63-...",
      "accountId": "user-123",
      "entryType": "DEBIT",
      "amount": "100.00",
      "currency": "USD",
      "lockedFxRate": null
    },
    {
      "transactionId": "8224fb63-...",
      "accountId": "user-456",
      "entryType": "CREDIT",
      "amount": "100.00",
      "currency": "USD",
      "lockedFxRate": null
    }
  ]
}
```

A raw array (without the `entries` wrapper) is also accepted.

`lockedFxRate` is `null` for domestic transfers and the locked exchange rate string for cross-currency entries.

**Response `201`**

```json
{ "ok": true }
```

**Errors**

| Status | `error` value                                                    |
|--------|------------------------------------------------------------------|
| 400    | `Body must be an array of ledger entries or { entries: [...] }`  |
| 422    | `Ledger invariant violated: DEBIT X ≠ CREDIT Y`                  |

---

### `GET /api/ledger/balance/:accountId`

Compute current balance for an account by summing ledger entries. Independent of the account-service balance — useful for audit reconciliation.

**Response `200`**

```json
{
  "accountId": "user-123",
  "balance": "880.00",
  "currency": "USD",
  "entryCount": 4
}
```

**Errors**

| Status | `error` value      |
|--------|--------------------|
| 404    | `Account not found`|

---

### `GET /api/ledger/verify/:transactionId`

Recompute the SHA-256 hash chain for a transaction and report whether it matches the stored hashes. Any modification to ledger data at the DB level will produce a mismatch.

**Response `200`**

```json
{
  "transactionId": "8224fb63-...",
  "valid": true,
  "entries": [
    {
      "id": "...",
      "entryType": "DEBIT",
      "amount": "100.00",
      "currency": "USD",
      "accountId": "user-123",
      "entryHash": "abc123...",
      "hashValid": true
    }
  ]
}
```

---

### `GET /api/ledger/invariant-check`

Verify that total DEBITs equal total CREDITs across the entire ledger. A Prometheus alert fires immediately if this ever returns `valid: false`.

**Response `200`**

```json
{
  "valid": true,
  "totalDebit": "1200.00",
  "totalCredit": "1200.00"
}
```

---

## Payroll Service

Bulk disbursements processed via a Redis-backed queue (one queue per employer). Each job records a `checkpointIndex` after every successful disbursement — crash recovery resumes from the checkpoint with deterministic idempotency keys to prevent double-payment.

---

### `POST /api/payroll/jobs`

Submit a bulk payroll job. The response is immediate (`202`) — actual disbursements run asynchronously via the queue worker.

**Request body**

```json
{
  "employerId": "employer-abc",
  "disbursements": [
    { "employeeId": "emp-001", "amount": "2500.00", "currency": "USD" },
    { "employeeId": "emp-002", "amount": "3000.00", "currency": "USD" }
  ]
}
```

**Response `202`**

```json
{
  "jobId": "a9f3c1e2-...",
  "status": "PENDING",
  "totalCount": 2,
  "totalAmount": "5500.00"
}
```

**Errors**

| Status | `error` value                           |
|--------|-----------------------------------------|
| 400    | `employerId is required`                |
| 400    | `disbursements must be a non-empty array`|

---

### `GET /api/payroll/jobs/:jobId`

Fetch job progress and counts.

**Response `200`**

```json
{
  "jobId": "a9f3c1e2-...",
  "employerId": "employer-abc",
  "status": "PROCESSING",
  "totalCount": 100,
  "processedCount": 47,
  "failedCount": 0,
  "checkpointIndex": 47,
  "totalAmount": "250000.00",
  "createdAt": "2026-04-06T00:00:00.000Z",
  "updatedAt": "2026-04-06T00:00:30.000Z"
}
```

**`status` lifecycle**

```
PENDING → PROCESSING → COMPLETED
                     → FAILED
```

**Errors**

| Status | `error` value   |
|--------|-----------------|
| 404    | `Job not found` |

---

### `GET /api/payroll/jobs/:jobId/disbursements`

Paginated list of individual disbursement records for a job.

**Query parameters**

| Param    | Default | Max | Description            |
|----------|---------|-----|------------------------|
| `limit`  | `50`    | 200 | Results per page       |
| `offset` | `0`     | —   | Pagination offset      |

**Response `200`**

```json
{
  "data": [
    {
      "id": "...",
      "jobId": "a9f3c1e2-...",
      "employeeId": "emp-001",
      "amount": "2500.00",
      "currency": "USD",
      "status": "COMPLETED",
      "transactionId": "...",
      "idempotencyKey": "a9f3c1e2-emp-001-0",
      "createdAt": "..."
    }
  ],
  "total": 100,
  "limit": 50,
  "offset": 0
}
```

---

### `GET /api/payroll/jobs`

List all payroll jobs across all employers (also used by admin service proxy).

**Query parameters:** `limit` (default `50`, max `200`), `offset` (default `0`)

**Response `200`**

```json
{
  "data": [
    {
      "jobId": "...",
      "employerId": "employer-abc",
      "status": "COMPLETED",
      "totalCount": 100,
      "processedCount": 100,
      "failedCount": 0,
      "totalAmount": "250000.00",
      "createdAt": "..."
    }
  ],
  "limit": 50,
  "offset": 0
}
```

---

## Admin Service

Internal operations proxy. All routes require `X-Admin-Key` header matching the `ADMIN_API_KEY` env var (default in docker-compose: `admin-secret`).

---

### `GET /api/admin/health`

Aggregate health check — pings all 5 services in parallel (3-second timeout each).

**Headers:** `X-Admin-Key: admin-secret`

**Response `200`** (all healthy) or **`207`** (one or more degraded/down)

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

**Service status values:** `ok` | `degraded` | `down`

---

### `GET /api/admin/ledger/invariant`

Proxy to ledger global invariant check.

**Headers:** `X-Admin-Key: admin-secret`

**Response** → see `GET /api/ledger/invariant-check`

---

### `GET /api/admin/ledger/verify/:transactionId`

Proxy to ledger audit hash chain verification.

**Headers:** `X-Admin-Key: admin-secret`

**Response** → see `GET /api/ledger/verify/:transactionId`

---

### `GET /api/admin/transactions/stuck`

List PROCESSING transactions older than 2 minutes.

**Headers:** `X-Admin-Key: admin-secret`

**Response** → see `GET /api/transfers/stuck`

---

### `POST /api/admin/transactions/:id/reverse`

Manually reverse a stuck PROCESSING transaction.

**Headers:** `X-Admin-Key: admin-secret`

**Response** → see `POST /api/transfers/:id/reverse`

---

### `GET /api/admin/payroll/jobs`

List all payroll jobs.

**Headers:** `X-Admin-Key: admin-secret`
**Query parameters:** `limit`, `offset`

**Response** → see `GET /api/payroll/jobs`

---

## Health & Metrics

Every service exposes these two endpoints (no auth required):

| Endpoint          | Description                                   |
|-------------------|-----------------------------------------------|
| `GET /api/health` | Returns `{ "status": "ok", "service": "..." }`|
| `GET /api/metrics`| Prometheus metrics scrape endpoint (`text/plain`) |

---

## Typical Flows

### Domestic transfer

```
1. POST /api/accounts            → create sender wallet (if needed)
2. POST /api/accounts            → create recipient wallet (if needed)
3. POST /api/transfers           → execute transfer (Idempotency-Key required)
4. GET  /api/transfers/:id       → poll until status = COMPLETED
```

### International transfer

```
1. POST /api/fx/quote            → get locked rate (valid 60 s)
2. POST /api/transfers/international  → execute with fxQuoteId (Idempotency-Key required)
3. GET  /api/transfers/:id       → poll until status = COMPLETED
```

### Bulk payroll

```
1. POST /api/payroll/jobs                      → submit job (async, returns 202)
2. GET  /api/payroll/jobs/:jobId               → poll processedCount / status
3. GET  /api/payroll/jobs/:jobId/disbursements → inspect individual results
```

### Audit / tamper detection

```
1. GET /api/admin/ledger/invariant             → check global DEBIT = CREDIT
2. GET /api/admin/ledger/verify/:txId          → verify hash chain for a transaction
3. GET /api/ledger/balance/:accountId          → reconcile against account-service balance
```
