import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Time-based one-time codes (RFC 6238): 6 digits, 30 seconds, SHA-1, which
 *  is what Google Authenticator, Microsoft Authenticator and Authy expect. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret(): string {
  let bits = '', out = '';
  for (const b of randomBytes(20)) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function decode(secret: string): Buffer {
  let bits = '';
  for (const c of secret.toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function codeAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const stepNow = (ms = Date.now()) => Math.floor(ms / 30_000);

/** The matching time step, or null. Accepts the previous and next 30 seconds
 *  for clock drift, and never a step at or before `after`: a code that was
 *  just used (or seen over a shoulder) can't be used again. */
export function verify(secret: string, code: string, after = 0, ms = Date.now()): number | null {
  const given = Buffer.from(code.replace(/\s/g, ''));
  if (given.length !== 6) return null;
  for (const d of [0, -1, 1]) {
    const step = stepNow(ms) + d;
    if (step > after && timingSafeEqual(Buffer.from(codeAt(secret, step)), given)) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer = 'HXG Connect') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Eight one-time backup codes, shown once. Only their hashes are stored. */
export function newBackupCodes(): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: 8 }, () => { const h = randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
  return { plain, hashed: plain.map(hashBackup) };
}
export const hashBackup = (code: string) => createHash('sha256').update(code.toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
