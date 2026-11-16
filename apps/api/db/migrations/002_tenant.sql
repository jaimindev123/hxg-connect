-- =====================================================================
-- 002 — TENANT PLANE (everything a client company owns)
-- Every table carries tenant_id and is locked down by row-level security.
-- =====================================================================

-- The current request's tenant. NULL when unset → policies match nothing.
CREATE FUNCTION app_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text NOT NULL,             -- owner | admin | sales_manager | ...
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, key)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  name          text NOT NULL,
  password_hash text,                    -- null until invite accepted
  role_id       uuid NOT NULL REFERENCES roles(id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','inactive')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)              -- same person can work at two clients
);

CREATE TABLE pipelines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false
);

CREATE TABLE pipeline_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    int  NOT NULL,
  is_won      boolean NOT NULL DEFAULT false,
  is_lost     boolean NOT NULL DEFAULT false
);

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  email            citext,
  primary_phone    text NOT NULL,        -- E.164
  whatsapp_number  text,
  pipeline_id      uuid NOT NULL REFERENCES pipelines(id),
  stage_id         uuid NOT NULL REFERENCES pipeline_stages(id),
  owner_id         uuid REFERENCES users(id),
  source           text,
  budget_min       numeric(14,2),
  budget_max       numeric(14,2),
  property_type    text,
  preferred_locations text[] NOT NULL DEFAULT '{}',
  tags             text[]  NOT NULL DEFAULT '{}',
  custom_fields    jsonb   NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','junk')),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_leads_tenant_created ON leads (tenant_id, created_at DESC, id DESC);
CREATE INDEX ix_leads_tenant_stage   ON leads (tenant_id, stage_id);
CREATE INDEX ix_leads_tenant_owner   ON leads (tenant_id, owner_id);

-- Dedupe backbone: a phone number is unique *within* a client, never across.
CREATE TABLE lead_phones (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone     text NOT NULL,
  lead_id   uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, phone)
);

CREATE TABLE activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  type        text NOT NULL,             -- note | call | stage_change | re_enquiry | system
  actor_id    uuid,
  body        text,
  meta        jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_act_lead ON activities (tenant_id, lead_id, occurred_at DESC);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id        uuid,
  impersonator_id uuid,                  -- set when platform support acted
  action          text NOT NULL,
  entity          text,
  entity_id       uuid,
  detail          jsonb NOT NULL DEFAULT '{}',
  at              timestamptz NOT NULL DEFAULT now()
);

-- ---------- Row-level security on every tenant table ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles','users','pipelines','pipeline_stages',
                           'leads','lead_phones','activities','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant())
                      WITH CHECK (tenant_id = app_tenant())$p$, t);
  END LOOP;
END $$;

-- ---------- Grants ---------------------------------------------------
-- Client CRM: full CRUD, always filtered by RLS.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON roles, users, pipelines, pipeline_stages, leads, lead_phones, activities
  TO hxg_app;
GRANT SELECT, INSERT ON audit_log TO hxg_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO hxg_app;

-- Platform: may seed a new client's config (roles, owner user, pipeline).
-- Deliberately NO grant on leads, lead_phones, activities, audit_log.
GRANT SELECT, INSERT ON roles, users, pipelines, pipeline_stages TO hxg_platform;

-- ---------- Narrow bridges between the planes (SECURITY DEFINER) ----
-- These are the ONLY ways one plane touches the other's data.

-- Tenant plane: resolve a subdomain before login (no tenant context yet).
CREATE FUNCTION resolve_tenant(p_subdomain text)
RETURNS TABLE (id uuid, name text, status text, features jsonb, limits jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
  SELECT t.id, t.name, t.status,
         p.features || t.feature_overrides,
         p.limits   || t.limit_overrides
  FROM tenants t JOIN platform.plans p ON p.id = t.plan_id
  WHERE t.subdomain = lower(p_subdomain)
$$;

-- Tenant plane: live status/plan for the tenant on every request.
CREATE FUNCTION tenant_state(p_tenant uuid)
RETURNS TABLE (id uuid, status text, features jsonb, limits jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
  SELECT t.id, t.status, p.features || t.feature_overrides, p.limits || t.limit_overrides
  FROM tenants t JOIN platform.plans p ON p.id = t.plan_id
  WHERE t.id = p_tenant
$$;

-- Platform plane: usage COUNTS per tenant. Numbers only, never rows.
CREATE FUNCTION platform_tenant_usage()
RETURNS TABLE (tenant_id uuid, users bigint, leads bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id,
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status <> 'inactive'),
         (SELECT count(*) FROM leads l WHERE l.tenant_id = t.id)
  FROM tenants t
$$;

-- Tenant plane: client admin sees support-access requests for THEIR company.
CREATE FUNCTION tenant_impersonation_requests()
RETURNS TABLE (id uuid, requested_by text, reason text, mode text, status text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
  SELECT s.id, pu.name, s.reason, s.mode, s.status, s.created_at
  FROM platform.impersonation_sessions s
  JOIN platform.users pu ON pu.id = s.platform_user_id
  WHERE s.tenant_id = app_tenant()
  ORDER BY s.created_at DESC
$$;

-- Tenant plane: client admin approves/rejects. Scoped to their tenant only.
CREATE FUNCTION tenant_decide_impersonation(p_session uuid, p_approve boolean,
                                            p_user uuid, p_minutes int DEFAULT 60)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, platform AS $$
BEGIN
  UPDATE platform.impersonation_sessions
     SET status      = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         approved_by = p_user,
         approved_at = now(),
         expires_at  = CASE WHEN p_approve THEN now() + make_interval(mins => p_minutes) END
   WHERE id = p_session AND tenant_id = app_tenant() AND status = 'pending';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION resolve_tenant(text), tenant_state(uuid), platform_tenant_usage(),
  tenant_impersonation_requests(), tenant_decide_impersonation(uuid, boolean, uuid, int)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text), tenant_state(uuid),
  tenant_impersonation_requests(), tenant_decide_impersonation(uuid, boolean, uuid, int)
  TO hxg_app;
GRANT EXECUTE ON FUNCTION platform_tenant_usage() TO hxg_platform;
GRANT EXECUTE ON FUNCTION app_tenant() TO hxg_app, hxg_platform;
