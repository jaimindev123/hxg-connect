-- =====================================================================
-- 007 — Lead capture: assignment rules and API keys for website forms
-- =====================================================================
CREATE TABLE assignment_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     int  NOT NULL DEFAULT 0,
  enabled      boolean NOT NULL DEFAULT true,
  conditions   jsonb NOT NULL DEFAULT '{}',   -- {sources:[], property_types:[], locations:[], budget_min, budget_max}
  assignee_ids uuid[] NOT NULL,               -- round-robin pool
  last_index   int NOT NULL DEFAULT -1,       -- cursor, advanced under row lock
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_rules_order ON assignment_rules (tenant_id, position);

-- Website-form keys. Only a SHA-256 hash is stored; the key is shown once.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,                 -- shown in the UI to tell keys apart
  key_hash     text NOT NULL UNIQUE,
  default_source text NOT NULL DEFAULT 'website',
  last_used_at timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assignment_rules','api_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hxg_app', t);
  END LOOP;
END $$;

-- Public capture requests carry only the key: find its workspace by hash.
CREATE FUNCTION resolve_api_key(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, default_source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT k.id, k.tenant_id, k.default_source FROM api_keys k
  WHERE k.key_hash = p_hash AND k.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO hxg_app;
