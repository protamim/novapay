import { Hono } from "hono";
import { trace } from "@opentelemetry/api";
import {
  ConcurrentModificationError,
  InsufficientFundsError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  createWallet,
  creditWallet,
  debitWallet,
  getWallet,
} from "../services/account.service";

const accounts = new Hono();

accounts.post("/accounts", async (c) => {
  let body: { userId: string; currency?: string; accountRef?: object };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  try {
    if (!body.userId) return c.json({ error: "userId is required" }, 400);

    const span = trace.getActiveSpan();
    span?.setAttributes({
      requestId: c.req.header("x-request-id") ?? "",
      userId: body.userId,
    });
    const wallet = await createWallet(
      body.userId,
      body.currency,
      body.accountRef,
    );
    return c.json(wallet, 201);
  } catch (err) {
    console.error("Error creating wallet:", err, c.res.status);
    if (err instanceof WalletAlreadyExistsError)
      return c.json({ error: err.message }, 409);
    throw err;
  }
});

accounts.get("/accounts/:userId", async (c) => {
  const span = trace.getActiveSpan();
  span?.setAttributes({
    requestId: c.req.header("x-request-id") ?? "",
    userId: c.req.param("userId"),
  });

  try {
    const wallet = await getWallet(c.req.param("userId"));
    return c.json(wallet);
  } catch (err) {
    if (err instanceof WalletNotFoundError)
      return c.json({ error: err.message }, 404);
    throw err;
  }
});

accounts.post("/accounts/:userId/debit", async (c) => {
  let body: { amount: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!body.amount) return c.json({ error: "amount is required" }, 400);

  const span = trace.getActiveSpan();
  span?.setAttributes({
    requestId: c.req.header("x-request-id") ?? "",
    userId: c.req.param("userId"),
  });

  try {
    const newBalance = await debitWallet(c.req.param("userId"), body.amount);
    return c.json({ balance: newBalance });
  } catch (err) {
    if (err instanceof WalletNotFoundError)
      return c.json({ error: err.message }, 404);
    if (err instanceof InsufficientFundsError)
      return c.json({ error: err.message }, 402);
    if (err instanceof ConcurrentModificationError)
      return c.json({ error: err.message }, 409);
    throw err;
  }
});

accounts.post("/accounts/:userId/credit", async (c) => {
  let body: { amount: string; transactionId?: string; currency?: string; isReversal?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!body.amount) return c.json({ error: "amount is required" }, 400);

  const span = trace.getActiveSpan();
  span?.setAttributes({
    requestId: c.req.header("x-request-id") ?? "",
    userId: c.req.param("userId"),
  });

  try {
    const userId = c.req.param("userId");
    const newBalance = await creditWallet(userId, body.amount);

    // Write a balanced ledger entry for direct credits (no transactionId) so
    // the ledger balance stays in sync with the wallet balance, including initial
    // funding. Saga transfers (transactionId set) and reversals (isReversal=true)
    // have their ledger entries written by transaction-service — skip those here.
    const LEDGER_SERVICE_URL = process.env.LEDGER_SERVICE_URL ?? "http://ledger-service:3000";
    const isDirectCredit = !body.transactionId && !body.isReversal;
    if (isDirectCredit) {
      const txnId = `funding-${userId}-${Date.now()}`;
      const currency = body.currency ?? "USD";
      await fetch(`${LEDGER_SERVICE_URL}/ledger/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            {
              transactionId: txnId,
              accountId: "FUNDING_SOURCE",
              entryType: "DEBIT",
              amount: body.amount,
              currency,
              description: `Funding source debit: ${body.amount} ${currency}`,
            },
            {
              transactionId: txnId,
              accountId: userId,
              entryType: "CREDIT",
              amount: body.amount,
              currency,
              description: `FUNDING credit: ${body.amount} ${currency}`,
            },
          ],
        }),
      }).catch(() => {
        // Ledger write is best-effort for direct credits; wallet credit already succeeded
      });
    }

    return c.json({ balance: newBalance });
  } catch (err) {
    if (err instanceof WalletNotFoundError)
      return c.json({ error: err.message }, 404);
    if (err instanceof ConcurrentModificationError)
      return c.json({ error: err.message }, 409);
    throw err;
  }
});

export default accounts;
