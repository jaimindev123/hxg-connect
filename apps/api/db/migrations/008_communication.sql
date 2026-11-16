-- =====================================================================
-- 008 — Calls (click-to-call, recordings, dispositions) and WhatsApp
-- =====================================================================
ALTER TABLE users ADD COLUMN phone text;            -- agent's own mobile: rung first on click-to-call

CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  provider         text NOT NULL,
  provider_call_id text,
  direction        text NOT NULL CHECK (direction IN ('outbound','inbound')),
  from_number      text,
  to_number        text,
  status           text NOT NULL DEFAULT 'initiated'
                     CHECK (status IN ('initiated','ringing','in_progress','completed','no_answer','busy','failed','missed')),
  duration_sec     int,
  recording_url    text,                            -- fetched through the API with provider credentials, never linked directly
  disposition      text,
  disposition_note text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  UNIQUE (tenant_id, provider, provider_call_id)
);
CREATE INDEX ix_calls_lead ON calls (tenant_id, lead_id, started_at DESC);
CREATE INDEX ix_calls_user ON calls (tenant_id, user_id, started_at DESC);

CREATE TABLE wa_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  language   text NOT NULL,
  category   text,
  status     text NOT NULL,                         -- APPROVED / PENDING / REJECTED, as Meta reports it
  body       text,
  params     int NOT NULL DEFAULT 0,                -- number of {{n}} placeholders in the body
  synced_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, language)
);

CREATE TABLE wa_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES leads(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id text,
  kind          text NOT NULL DEFAULT 'text',       -- text | template | media
  body          text,
  template_name text,
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','read','failed','received')),
  error         text,
  sent_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_message_id)
);
CREATE INDEX ix_wa_thread ON wa_messages (tenant_id, lead_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calls','wa_templates','wa_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hxg_app', t);
  END LOOP;
END $$;
