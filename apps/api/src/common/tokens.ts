import jwt from 'jsonwebtoken';
import { config } from '../config';

export type PlatformRole = 'super_admin' | 'admin_sales' | 'admin_support' | 'admin_billing';

export interface PlatformClaims {
  realm: 'platform';
  sub: string;           // platform.users.id
  role: PlatformRole;
  name: string;
}

export interface TenantClaims {
  realm: 'tenant';
  sub: string;           // users.id — or platform user id when impersonating
  tid: string;           // tenant id
  role: string;          // tenant role key
  name: string;
  imp?: { sid: string; mode: 'read_only' | 'full' };   // support session
}

export interface InviteClaims { tid: string; uid: string }

const ISSUER = 'hxg-connect';

export function signPlatform(c: Omit<PlatformClaims, 'realm'>): string {
  return jwt.sign({ ...c, realm: 'platform' }, config.platformJwtSecret,
    { audience: 'platform', issuer: ISSUER, expiresIn: '8h' });
}

export function verifyPlatform(token: string): PlatformClaims {
  const c = jwt.verify(token, config.platformJwtSecret, { audience: 'platform', issuer: ISSUER }) as PlatformClaims;
  if (c.realm !== 'platform') throw new Error('wrong realm');
  return c;
}

export function signTenant(c: Omit<TenantClaims, 'realm'>, expiresInSec = 12 * 3600): string {
  return jwt.sign({ ...c, realm: 'tenant' }, config.tenantJwtSecret,
    { audience: 'tenant', issuer: ISSUER, expiresIn: expiresInSec });
}

export function verifyTenant(token: string): TenantClaims {
  const c = jwt.verify(token, config.tenantJwtSecret, { audience: 'tenant', issuer: ISSUER }) as TenantClaims;
  if (c.realm !== 'tenant') throw new Error('wrong realm');
  return c;
}

/** One-time set-password link for invited users (in prod this goes by email). */
export function signInvite(c: InviteClaims): string {
  return jwt.sign(c, config.tenantJwtSecret, { audience: 'tenant-invite', issuer: ISSUER, expiresIn: '72h' });
}

export function verifyInvite(token: string): InviteClaims {
  return jwt.verify(token, config.tenantJwtSecret, { audience: 'tenant-invite', issuer: ISSUER }) as InviteClaims;
}

export function bearer(header?: string): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}
