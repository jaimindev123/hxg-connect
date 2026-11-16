import { Injectable } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { config } from '../config';

/** Object storage behind presigned-style URLs. Local disk today; an S3/R2
 *  implementation only has to provide put() and signedUrl() — callers and
 *  the database (which stores keys, never URLs) don't change. */
@Injectable()
export class Storage {
  private readonly root = config.storageDir;

  async put(tenantId: string, folder: string, ext: string, data: Buffer): Promise<string> {
    const key = `t/${tenantId}/${folder}/${randomUUID()}.${ext}`;
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o600 });
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  /** Only ever called after an RLS-scoped query returned the key, so the
   *  signature is proof the caller was allowed to see the row. */
  signedUrl(key: string, ttlSec = 600): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `/api/files/${encodeURIComponent(key)}?exp=${exp}&sig=${this.sign(key, exp)}`;
  }

  verify(key: string, exp: string, sig: string): boolean {
    const e = Number(exp);
    if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
    const want = Buffer.from(this.sign(key, e));
    const got = Buffer.from(sig ?? '');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private sign(key: string, exp: number) {
    return createHmac('sha256', config.fileSigningSecret).update(`${key}|${exp}`).digest('base64url');
  }

  private pathFor(key: string) {
    if (!/^t\/[0-9a-f-]{36}\/[a-z_]+\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) throw new Error('bad key');
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('bad key');
    return p;
  }
}
