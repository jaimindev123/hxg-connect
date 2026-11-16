const isProd = process.env.NODE_ENV === 'production';

/** Empty strings count as unset. In production, secrets and DB URLs must be
 *  set explicitly — the API refuses to boot on dev defaults. */
const env = (key: string, fallback?: string): string => {
  const raw = process.env[key]?.trim();
  if (raw) return raw;
  if (isProd && /SECRET|_KEY$|_URL$/.test(key)) throw new Error(`${key} must be set in production`);
  if (fallback === undefined) throw new Error(`Missing env ${key}`);
  return fallback;
};

export const config = {
  port: Number(env('PORT', '4000')),
  // Two runtime connections, two Postgres roles. Never the owner.
  platformDbUrl: env('DATABASE_PLATFORM_URL', 'postgres://hxg_platform:hxg_platform_dev@localhost:5432/hxg_connect'),
  appDbUrl: env('DATABASE_APP_URL', 'postgres://hxg_app:hxg_app_dev@localhost:5432/hxg_connect'),
  // Separate secrets per realm: a platform token cannot verify as a tenant token.
  platformJwtSecret: env('PLATFORM_JWT_SECRET', 'dev-platform-secret-change-me'),
  tenantJwtSecret: env('TENANT_JWT_SECRET', 'dev-tenant-secret-change-me'),
  // Client workspaces live at {subdomain}.{baseDomain}
  // Optional. Empty = no domain yet: everyone signs in at the server address
  // and types a workspace name. The console's domain setting overrides this.
  baseDomain: (process.env.BASE_DOMAIN ?? '').trim().toLowerCase() || null as string | null,
  encryptionKey: env('ENCRYPTION_KEY', 'dev-encryption-key-change-me-0123456789abcdef'),
  // Overridable for sandboxes and tests; production uses the defaults.
  providerBase: {
    razorpay: env('RAZORPAY_API_BASE', 'https://api.razorpay.com'),
    twilio: env('TWILIO_API_BASE', 'https://api.twilio.com'),
    graph: env('WHATSAPP_GRAPH_BASE', 'https://graph.facebook.com'),
    exotel: process.env.EXOTEL_API_BASE?.trim() || null as string | null,
  },
  defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '91'),
  storageDir: env('STORAGE_DIR', require('node:path').resolve(process.cwd(), 'storage')),
  fileSigningSecret: env('FILE_SIGNING_SECRET', 'dev-file-signing-secret-change-me'),
  rateLimitPerMin: Number(env('RATE_LIMIT_PER_MIN', '600')),
  // Built web app (apps/web/dist). Served by the API when present.
  webDist: env('WEB_DIST', require('node:path').resolve(process.cwd(), '../web/dist')),
  // Forwarded portal emails: the inbound mail service posts to /api/webhooks/inbound-email?secret=...
  inboundEmailDomain: (process.env.INBOUND_EMAIL_DOMAIN ?? '').trim().toLowerCase() || null as string | null,
  inboundEmailSecret: (process.env.INBOUND_EMAIL_SECRET ?? '').trim() || null as string | null,
  reservedSubdomains: ['admin', 'api', 'app', 'www', 'platform', 'mail', 'support', 'status', 'docs', 'billing'],
};
