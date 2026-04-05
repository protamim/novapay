import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const MASTER_KEY = Buffer.from(process.env.MASTER_ENCRYPTION_KEY!, 'hex'); // 32 bytes

export function encrypt(plaintext: string): string {
  // Generate a unique DEK per record
  const dek = randomBytes(32);
  const iv = randomBytes(12); // 96-bit IV for GCM

  // Encrypt plaintext with DEK
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Encrypt DEK with master key
  const dekIv = randomBytes(12);
  const dekCipher = createCipheriv('aes-256-gcm', MASTER_KEY, dekIv);
  const encryptedDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
  const dekAuthTag = dekCipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedDek: encryptedDek.toString('base64'),
    dekIv: dekIv.toString('base64'),
    dekAuthTag: dekAuthTag.toString('base64'),
  });
}

export function decrypt(encrypted: string): string {
  const { iv, ciphertext, authTag, encryptedDek, dekIv, dekAuthTag } = JSON.parse(encrypted);

  // Decrypt DEK with master key
  const dekDecipher = createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(dekIv, 'base64'));
  dekDecipher.setAuthTag(Buffer.from(dekAuthTag, 'base64'));
  const dek = Buffer.concat([
    dekDecipher.update(Buffer.from(encryptedDek, 'base64')),
    dekDecipher.final(),
  ]);

  // Decrypt plaintext with DEK
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
