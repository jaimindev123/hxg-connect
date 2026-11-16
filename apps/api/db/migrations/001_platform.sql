-- =====================================================================
-- 001 — PLATFORM PLANE
-- Runs as the migration owner (superuser in dev, owner role in prod).
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Runtime roles -------------------------------------------
-- hxg_platform : Super Admin console. Manages tenants, plans, billing.
--               Can seed a new tenant's config, can NEVER read lead data.
-- hxg_app      : Client CRM. Every tenant table is RLS-filtered for it.
--               No access to the platform schema at all.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hxg_platform') THEN
    CREATE ROLE hxg_platform LOGIN PASSWORD 'hxg_platform_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hxg_app') THEN
    CREATE ROLE hxg_app LOGIN PASSWORD 'hxg_app_dev';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS platform;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO hxg_platform;

-- ---------- Plans ---------------------------------------------------
CREATE TABLE platform.plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text UNIQUE NOT NULL,          -- starter | growth | pro | enterprise
  name           text NOT NULL,
  price_per_user numeric(10,2) NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'INR',
  billing_cycle  text NOT NULL DEFAULT 'monthly',
  limits         jsonb NOT NULL DEFAULT '{}',   -- {"users":5,"leads":50000}
  features       jsonb NOT NULL DEFAULT '{}',   -- {"telephony":true,"field_tracking":false}
  is_public      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Platform staff ------------------------------------------
CREATE TABLE platform.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN
                  ('super_admin','admin_sales','admin_support','admin_billing')),
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- Tenants (one row per client company) --------------------
-- Lives in public because the tenant plane must resolve a subdomain to a
-- tenant before login. hxg_app gets no direct grant: it goes through the
-- resolve_tenant() function defined in 002.
CREATE TABLE public.tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  subdomain      citext UNIQUE NOT NULL
                   CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'),
  status         text NOT NULL DEFAULT 'trial'
                   CHECK (status IN ('trial','active','past_due','suspended','churned')),
  plan_id        uuid NOT NULL REFERENCES platform.plans(id),
  trial_ends_at  timestamptz,
  limit_overrides   jsonb NOT NULL DEFAULT '{}',  -- per-contract exceptions
  feature_overrides jsonb NOT NULL DEFAULT '{}',
  owner_email    citext NOT NULL,
  created_by     uuid REFERENCES platform.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  plan_id            uuid NOT NULL REFERENCES platform.plans(id),
  seats              int NOT NULL DEFAULT 1,
  status             text NOT NULL DEFAULT 'trialing',
  gateway            text,                 -- razorpay | stripe
  gateway_sub_id     text,
  current_period_end timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Consent-gated support access to a client's CRM.
CREATE TABLE platform.impersonation_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id uuid NOT NULL REFERENCES platform.users(id),
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  reason           text NOT NULL CHECK (length(reason) >= 10),
  mode             text NOT NULL DEFAULT 'read_only' CHECK (mode IN ('read_only','full')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','expired','ended')),
  approved_by      uuid,                   -- tenant user id (client admin)
  approved_at      timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,
  tenant_id  uuid,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);

-- Effective plan for a tenant = plan values with contract overrides on top.
CREATE VIEW platform.tenant_directory AS
SELECT t.id, t.name, t.subdomain, t.status, t.trial_ends_at, t.owner_email, t.created_at,
       p.code AS plan_code, p.name AS plan_name, p.price_per_user,
       p.limits   || t.limit_overrides   AS limits,
       p.features || t.feature_overrides AS features
FROM public.tenants t JOIN platform.plans p ON p.id = t.plan_id;

GRANT SELECT, INSERT, UPDATE ON platform.plans, platform.users, platform.subscriptions,
      platform.impersonation_sessions TO hxg_platform;
GRANT SELECT, INSERT ON platform.audit_log TO hxg_platform;
GRANT USAGE ON SEQUENCE platform.audit_log_id_seq TO hxg_platform;
GRANT SELECT ON platform.tenant_directory TO hxg_platform;
GRANT SELECT, INSERT, UPDATE ON public.tenants TO hxg_platform;
