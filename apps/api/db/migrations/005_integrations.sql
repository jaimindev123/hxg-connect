-- =====================================================================
-- 005 — Integrations (keys entered in the admin UI, encrypted at rest),
--       platform settings (domain), and an inbox for provider webhooks.
-- =====================================================================

-- Client-owned credentials: their telephony, WhatsApp, Razorpay.
CREATE TABLE integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  config         jsonb NOT NULL DEFAULT '{}',       -- non-secret values (ids, numbers)
  secrets_enc    text,                              -- AES-256-GCM sealed JSON, never returned
  status         text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','connected','error')),
  last_tested_at timestamptz,
  last_error     text,
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);
CREATE INDEX ix_integrations_webhook ON integrations (provider, (config->>'webhook_key'));

-- Signed provider events land here; later milestones process them.
CREATE TABLE webhook_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  event_type  text,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX ix_webhook_events_pending ON webhook_events (tenant_id, provider) WHERE processed_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integrations','webhook_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations TO hxg_app;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO hxg_app;
GRANT USAGE ON SEQUENCE webhook_events_id_seq TO hxg_app;
-- hxg_platform: no grant. A client's keys are the client's data.

-- Webhooks arrive with no session: find the owning tenant by its random
-- webhook key. Returns the sealed secrets so the app can check signatures.
CREATE FUNCTION webhook_target(p_provider text, p_key text)
RETURNS TABLE (tenant_id uuid, config jsonb, secrets_enc text, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.tenant_id, i.config, i.secrets_enc, i.enabled FROM integrations i
  WHERE i.provider = p_provider AND i.config->>'webhook_key' = p_key AND length(p_key) >= 24
$$;
REVOKE ALL ON FUNCTION webhook_target(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_target(text, text) TO hxg_app;

-- Your own credentials: subscription billing, outgoing email.
CREATE TABLE platform.integrations (
  provider       text PRIMARY KEY,
  enabled        boolean NOT NULL DEFAULT true,
  config         jsonb NOT NULL DEFAULT '{}',
  secrets_enc    text,
  status         text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved','connected','error')),
  last_tested_at timestamptz,
  last_error     text,
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Platform-wide settings editable in the console (domain, etc.).
CREATE TABLE platform.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON platform.integrations TO hxg_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.settings TO hxg_platform;

-- Requests also need the workspace's name and address (invite links, emails, UI).
DROP FUNCTION tenant_state(uuid);
CREATE FUNCTION tenant_state(p_tenant uuid)
RETURNS TABLE (id uuid, status text, trial_ends_at timestamptz, features jsonb, limits jsonb, name text, subdomain text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, platform AS $$
  SELECT t.id, t.status, t.trial_ends_at, p.features || t.feature_overrides, p.limits || t.limit_overrides,
         t.name, t.subdomain::text
  FROM tenants t JOIN platform.plans p ON p.id = t.plan_id
  WHERE t.id = p_tenant
$$;
REVOKE ALL ON FUNCTION tenant_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_state(uuid) TO hxg_app;
