-- =====================================================================
-- 009 — Channel partners (brokers): portal accounts, lead protection,
--       commissions
-- =====================================================================
CREATE TABLE channel_partners (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  firm_name       text NOT NULL,
  contact_name    text NOT NULL,
  email           citext NOT NULL,
  phone           text,
  rera_number     text,
  commission_pct  numeric(5,2) NOT NULL DEFAULT 2.00 CHECK (commission_pct BETWEEN 0 AND 20),
  protection_days int NOT NULL DEFAULT 60 CHECK (protection_days BETWEEN 1 AND 365),
  status          text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended')),
  password_hash   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- Attribution lives on the lead: which partner brought them, until when.
ALTER TABLE leads ADD COLUMN cp_id uuid REFERENCES channel_partners(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN cp_protected_until timestamptz;
CREATE INDEX ix_leads_cp ON leads (tenant_id, cp_id);

CREATE TABLE cp_commissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cp_id          uuid NOT NULL REFERENCES channel_partners(id),
  booking_id     uuid NOT NULL UNIQUE REFERENCES bookings(id),      -- one commission per booking
  lead_id        uuid NOT NULL REFERENCES leads(id),
  base_amount    numeric(14,2) NOT NULL,
  pct            numeric(5,2) NOT NULL,
  amount         numeric(14,2) NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','cancelled')),
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  paid_reference text,
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_partners','cp_commissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hxg_app', t);
  END LOOP;
END $$;
