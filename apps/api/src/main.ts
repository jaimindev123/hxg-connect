import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/util';
import { rateLimit, requestId, securityHeaders } from './common/security';
import { config } from './config';
import { runtime } from './integrations/integrations.service';

/** sunrise.hxgconnect.com → "sunrise". X-Tenant works for local dev,
 *  mobile apps and API clients that don't call through a subdomain. */
export function tenantHint(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers['x-tenant'];
  if (typeof header === 'string' && header.trim()) {
    req.tenantHint = header.trim().toLowerCase();
  } else {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const suffix = runtime.baseDomain ? `.${runtime.baseDomain}` : null;
    if (suffix && host.endsWith(suffix)) {
      const sub = host.slice(0, -suffix.length);
      if (sub && !sub.includes('.') && !config.reservedSubdomains.includes(sub)) req.tenantHint = sub;
    }
  }
  next();
}

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'], bodyParser: false,
  });
  // Proxies in front of the app: 1 = one load balancer (Render, Caddy); 2 = Vercel in front of Render.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');
  app.use(requestId, securityHeaders);
  // Forwarded portal emails can be large and may arrive as form data; parse them first, with a bigger limit.
  app.use('/api/webhooks/inbound-email', express.json({ limit: '10mb' }), express.urlencoded({ extended: false, limit: '10mb' }));
  app.use('/api/webhooks/portal', express.urlencoded({ extended: false, limit: '200kb' }));
  // Lead connectors: form posts with bracketed names (fields[name][value]) from website builders.
  app.use('/api/webhooks/in', express.urlencoded({ extended: true, limit: '300kb' }));
  // Parse before the limiter (it keys logins by email); keep raw bytes for webhook signatures.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  // Website forms post from the client's own domain: open CORS on /api/capture
  // only (key-authenticated, create-only), and accept plain HTML form posts.
  app.use('/api/capture', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-api-key');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  }, express.urlencoded({ extended: false, limit: '100kb' }));
  // Twilio and Exotel post call status as form data.
  app.use('/api/webhooks/calls', express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(rateLimit, tenantHint);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ProblemFilter());
  app.enableCors({ origin: false });         // same-origin SPA; mobile apps don't need CORS
  app.enableShutdownHooks();

  // Serve the built web app with SPA fallback, if it's there.
  const index = join(config.webDist, 'index.html');
  if (existsSync(index)) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h',
      setHeaders: (res, path) => { if (path.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
  }
  return app;
}

if (require.main === module) {
  createApp().then(async app => {
    await app.listen(config.port);
    console.log(`HXG Connect on :${config.port}`);
  });
}
