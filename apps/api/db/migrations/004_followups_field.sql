-- =====================================================================
-- 004 — Follow-ups (the "no lead is ever lost" engine) and field check-ins
-- =====================================================================

-- Reporting line: whose check-ins land in whose feed.
ALTER TABLE users ADD COLUMN manager_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE follow_ups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to  uuid REFERENCES users(id) ON DELETE SET NULL,
  type         text NOT NULL CHECK (type IN ('call','whatsapp','email','meeting','site_visit')),
  due_at       timestamptz NOT NULL,
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  outcome      text,
  completed_at timestamptz,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_fu_queue ON follow_ups (tenant_id, assigned_to, status, due_at);
CREATE INDEX ix_fu_lead  ON follow_ups (tenant_id, lead_id, status);

CREATE TABLE field_checkins (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id   uuid REFERENCES users(id) ON DELETE SET NULL,   -- snapshot at check-in time
  type         text NOT NULL CHECK (type IN
                 ('day_start','day_end','site_visit_in','site_visit_out','meeting','adhoc')),
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  selfie_key   text NOT NULL,
  captured_at  timestamptz NOT NULL,                            -- device time
  submitted_at timestamptz NOT NULL DEFAULT now(),              -- server time
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m   numeric,
  address      text,
  note         text,
  flags        jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','flagged','approved','rejected')),
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz
);
CREATE INDEX ix_fc_user ON field_checkins (tenant_id, user_id, captured_at DESC);
CREATE INDEX ix_fc_mgr  ON field_checkins (tenant_id, manager_id, submitted_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['follow_ups','field_checkins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON follow_ups, field_checkins TO hxg_app;
-- hxg_platform gets nothing here: follow-ups and selfies are client data.
