// Money — always string for decimals, never float
export type Money = {
  amount: string;
  currency: string;
};

export type TransactionStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REVERSED';

export type LedgerEntryType = 'DEBIT' | 'CREDIT';

export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  requestId: string;
};

export type IdempotencyRecord = {
  key: string;
  payloadHash: string;
  result: unknown;
  expiresAt: Date;
};
