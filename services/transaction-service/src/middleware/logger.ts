import pino from 'pino';

export const logger = pino({
  redact: {
    paths: [
      'password',
      'token',
      'cardNumber',
      'pan',
      'cvv',
      'accountRef',
      'encryptedAccountRef',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  base: { service: process.env.OTEL_SERVICE_NAME },
});
