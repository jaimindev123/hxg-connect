import type { NextFunction, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config';

const isProd = process.env.NODE_ENV === 'production';

/** Baseline headers on everything; a strict CSP on HTML so an injected
 *  script can't run (tokens live in sessionStorage, so this matters). */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!req.path.startsWith('/api')) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
  }
  next();
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  next();
}

/** Fixed-window limiter. In-memory per instance: correct for one node,
 *  approximate across several — swap the Map for Redis INCR+EXPIRE when you
 *  run more than one API replica. */
class Window {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, Math.min(windowMs, 60_000)).unref();
  }
  take(key: string): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) { this.hits.set(key, { n: 1, reset: now + this.windowMs }); return { ok: true, retryAfter: 0 }; }
    h.n += 1;
    return { ok: h.n <= this.limit, retryAfter: Math.ceil((h.reset - now) / 1000) };
  }
}

const apiWindow = new Window(config.rateLimitPerMin, 60_000);
const loginWindow = new Window(10, 15 * 60_000);       // per IP + email
const LOGIN_PATHS = new Set(['/api/auth/login', '/api/platform/auth/login', '/api/auth/accept-invite', '/api/auth/forgot', '/api/auth/reset', '/api/partner/auth/login']);

function tooMany(res: Response, retryAfter: number, message: string) {
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).type('application/problem+json')
    .json({ status: 429, title: 'rate_limited', code: 'rate_limited', message });
}

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith('/api') || req.path.startsWith('/api/webhooks')) return next();   // webhooks are signature-checked
  const ip = req.ip ?? 'unknown';

  const a = apiWindow.take(ip);
  if (!a.ok) return tooMany(res, a.retryAfter, 'Too many requests. Slow down and retry shortly.');

  if (req.method === 'POST' && LOGIN_PATHS.has(req.path)) {
    // Per account: the email for sign-ins, the link itself for invite and
    // reset links (which carry no email). Without this, a whole office
    // accepting invites from one Wi-Fi shared a single allowance of 10.
    const body = (req.body ?? {}) as { email?: unknown; token?: unknown };
    const who = String(body.email ?? '').toLowerCase()
      || (body.token ? `link:${createHash('sha256').update(String(body.token)).digest('hex').slice(0, 16)}` : '');
    const l = loginWindow.take(`${ip}|${who}`);
    if (!l.ok) return tooMany(res, l.retryAfter, 'Too many sign-in attempts. Try again in a few minutes.');
  }
  next();
}
