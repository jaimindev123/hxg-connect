# Deploying HXG Connect on Supabase (and Vercel)

## What runs where

| Part | Where | Why |
|---|---|---|
| Database | **Supabase** | Managed PostgreSQL with backups. The row-level security that keeps clients apart works unchanged. |
| API | **Render** (or Fly.io) | Must be an always-on server: it runs background jobs (expired holds, billing on the 1st, hourly dunning), stores selfies on disk, and keeps sign-in rate limits in memory. Vercel functions do none of these. |
| Web app | Served by the API, or **Vercel** if you want it there | Optional. Vercel adds a global CDN for the web app's files. |

**Keep the API and database in the same region.** Every page makes several database queries; if the API is in Singapore and the database in Mumbai, each query crosses the sea and the app feels slow. Pick one:

- **Simplest:** Render **Singapore** + Supabase **Singapore** (Southeast Asia). Indian users are ~50–70 ms away, once per request.
- **Data stays in India:** Fly.io **Mumbai** (`bom`) + Supabase **Mumbai** (South Asia). Fly.io is driven from a command line; the steps below are for Render, and the same environment variables apply on Fly.io.

## 1. Supabase

1. Create a project in your chosen region on the **Pro** plan. Free projects pause after a week without activity and have no backups, which is not acceptable for clients.
2. **Project Settings → Database**: copy the **Session pooler** connection string (it works over IPv4, which Render needs). It looks like
   `postgresql://postgres.<project-ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   On the same page, download the **SSL certificate**.
3. **Project Settings → API (Data API)**: switch the Data API off, or remove `public` from the exposed schemas. HXG Connect never uses it. Migration 012 also strips the access Supabase gives its anonymous role to our tables and functions; this is the second lock.
4. In the **SQL editor**, run `select rolbypassrls from pg_roles where rolname = 'postgres';`. It must say `true`. A few internal lookups that work across clients (directory counts, webhook routing, website-form keys, releasing expired holds) depend on it.

## 2. Render (the API)

1. Put the code in a private GitHub repository.
2. **New → Web Service**, connect the repository, runtime **Docker** (the `Dockerfile` is at the root), same region as Supabase, instance **Standard** (2 GB) or larger.
3. **Start command**: `sh -c "node scripts/migrate.mjs && node dist/main.js"` and **Health check path**: `/api/health`.
4. **Disk**: mount path `/app/storage`, 5 GB to start. This holds check-in selfies; Render snapshots it daily. A service with a disk runs as one instance, which is what the app expects today.
5. **Secret Files**: add `supabase-ca.crt` with the certificate's contents. Render places it at `/etc/secrets/supabase-ca.crt`.
6. **Environment variables** (generate each secret with `openssl rand -base64 48`):

```
NODE_ENV=production
DATABASE_OWNER_URL=postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt
DATABASE_APP_URL=postgresql://hxg_app.<ref>:<new-strong-password-1>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt
DATABASE_PLATFORM_URL=postgresql://hxg_platform.<ref>:<new-strong-password-2>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt
PLATFORM_JWT_SECRET=...
TENANT_JWT_SECRET=...
FILE_SIGNING_SECRET=...
ENCRYPTION_KEY=...                      # back this up
BASE_DOMAIN=hxgconnect.com
SUPER_ADMIN_EMAIL=you@hxgconnect.com
SUPER_ADMIN_PASSWORD=...                # 12+ characters, first start only
TRUST_PROXY_HOPS=1                      # 2 if you put Vercel in front (layout B)
BILLING_SCHEDULER=on
```

   - The `role.<project-ref>` user format is how Supabase's pooler knows which project you mean. The two `hxg_` roles don't exist yet: the first start creates them and sets their passwords from these URLs (16+ characters, letters and digits keep it simple).
   - Use passwords made of letters and digits, or URL-encode special characters.
   - If the first start fails with a certificate error, check the certificate file. As a last resort, `sslmode=no-verify` keeps the connection encrypted but unverified; switch back once it works.
7. **Deploy.** The logs should show the migrations being applied and then `HXG Connect on :4000`.

## 3a. Layout A: everything on Render (start here)

In the service's **Settings → Custom Domains**, add `hxgconnect.com`, `admin.hxgconnect.com` and `*.hxgconnect.com`, then create the DNS records Render shows you (the wildcard also needs a verification record). Render issues HTTPS certificates automatically. You don't need Vercel.

## 3b. Layout B: web app on Vercel, API on Render

1. On Render, add the custom domain `api.hxgconnect.com` and set `TRUST_PROXY_HOPS=2`.
2. In `apps/web/vercel.json`, replace `api.hxgconnect.com` with your API domain and commit.
3. Vercel → **New Project** → import the repository → **Root Directory** `apps/web` (build settings come from `vercel.json`).
4. **Domains:** add `hxgconnect.com`, `admin.hxgconnect.com` and `*.hxgconnect.com`. Vercel only allows wildcard domains when the domain's nameservers point to Vercel, so move DNS there and add a CNAME `api` → your Render address.
5. Browsers only ever talk to `hxgconnect.com`; Vercel forwards `/api/...` to Render.

Use Vercel **Pro**: the free Hobby plan is for non-commercial use.

## 4. First setup

Follow `DEPLOY.md` steps 6–8: sign in at `https://admin.hxgconnect.com`, change your password, delete `SUPER_ADMIN_PASSWORD`, then set up email (SMTP), GST billing details, Razorpay billing, plan prices and staff, and create your first client. In the mobile app, users enter `https://hxgconnect.com` as the server address.

## Receiving portal emails (one-time, optional)

Clients can forward property-portal enquiry emails into HXG Connect. To switch it on:

1. Pick a receiving subdomain, e.g. `leads.hxgconnect.com`, and an inbound email service: SendGrid Inbound Parse, Mailgun Routes or Postmark Inbound all work.
2. Add the MX record the service gives you for `leads.hxgconnect.com` (SendGrid, for example, uses `mx.sendgrid.net`, priority 10).
3. Point the service at `https://hxgconnect.com/api/webhooks/inbound-email?secret=YOUR_SECRET` (for SendGrid, leave "send raw MIME" unticked).
4. Set `INBOUND_EMAIL_DOMAIN=leads.hxgconnect.com` and `INBOUND_EMAIL_SECRET=` (from `openssl rand -hex 24`), then restart.

Each client's address then appears under Settings → Integrations → Property portals.

## 5. Backups, monitoring, cost

- **Database:** Supabase Pro keeps daily backups; add point-in-time recovery if you want to restore to the minute.
- **Selfies:** only on the Render disk (snapshotted daily). Moving them to Supabase Storage needs a small storage adapter that isn't built yet.
- **Monitoring:** point an uptime monitor at `https://hxgconnect.com/api/health`.
- **Rough monthly cost:** Supabase Pro about $25, Render Standard about $25 plus a dollar or two for the disk, Vercel Pro about $20 per member if you use layout B. Check current pricing before you commit.

## How this differs from DEPLOY.md

Render and Vercel handle HTTPS, so Caddy and `docker-compose.prod.yml` aren't used; Supabase backups and Render disk snapshots replace the backup container. The production safety checks (no development passwords, no weak first admin password, no missing secrets) work the same way.
