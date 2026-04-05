export class ProviderUnavailableError extends Error {
  constructor() {
    super('FX provider is unavailable');
    this.name = 'ProviderUnavailableError';
  }
}

// Hardcoded rates table
const RATES: Record<string, Record<string, number>> = {
  USD: { BDT: 110.5,  EUR: 0.92,  GBP: 0.79,  USD: 1.0 },
  EUR: { USD: 1.087,  BDT: 120.1, EUR: 1.0 },
  GBP: { USD: 1.265,  BDT: 139.7, GBP: 1.0 },
  BDT: { USD: 0.00905, EUR: 0.00833, BDT: 1.0 },
};

export async function getRate(fromCurrency: string, toCurrency: string): Promise<string> {
  // FX_PROVIDER_DOWN=true simulates the Checkpoint 3 failure scenario
  if (process.env.FX_PROVIDER_DOWN === 'true') {
    throw new ProviderUnavailableError();
  }

  const rate = RATES[fromCurrency]?.[toCurrency];
  if (rate === undefined) {
    throw new Error(`No rate available for ${fromCurrency} → ${toCurrency}`);
  }
  return rate.toString();
}
