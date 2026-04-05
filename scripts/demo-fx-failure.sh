#!/bin/bash
set -euo pipefail

echo "=== NovaPay FX Provider Failure Demo ==="

echo "1. Restarting fx-service with FX_PROVIDER_DOWN=true..."
docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" stop fx-service
FX_PROVIDER_DOWN=true docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" up -d fx-service
sleep 3

echo "2. Attempting to get FX quote (should fail with 503)..."
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST http://localhost/api/fx/quote \
  -H "Content-Type: application/json" \
  -d '{"fromCurrency":"USD","toCurrency":"BDT","amount":"2000"}')
echo "$RESPONSE"

echo "3. Attempting international transfer (should fail before any money moves)..."
curl -s -X POST http://localhost/api/transfers/international \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-fx-failure-$(date +%s)" \
  -d '{"senderId":"user-1","recipientId":"user-2","amount":"2000","currency":"USD","fxQuoteId":"nonexistent"}' | jq .

echo "4. Check Jaeger at http://localhost:16686 — search for service: fx-service"
echo "   The trace should terminate at fx-service with error FX_PROVIDER_UNAVAILABLE"
echo "   No ledger entries should exist for this transfer"

echo "5. Restoring fx-service..."
docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" stop fx-service
docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" up -d fx-service

echo "Done. fx-service restored."
