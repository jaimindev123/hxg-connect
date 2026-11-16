import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

/** AES-256-GCM for stored credentials. The data key is derived from
 *  ENCRYPTION_KEY with HKDF, so the env value is never used directly.
 *  Format "v1.<iv>.<tag>.<ciphertext>" leaves room for key rotation. */
const key = Buffer.from(hkdfSync('sha256', config.encryptionKey, 'hxg-connect', 'integrations-v1', 32));

export function seal(data: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function unseal(sealed: string | null | undefined): Record<string, string> {
  if (!sealed) return {};
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown credential format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

/** "rzp_live_AbC123xyz" → "••••3xyz". Short values reveal nothing. */
export const hint = (s?: string) => (!s ? null : s.length < 8 ? '••••' : `••••${s.slice(-4)}`);
export const randomKey = (bytes = 24) => randomBytes(bytes).toString('base64url');
